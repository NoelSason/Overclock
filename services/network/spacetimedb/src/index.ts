/**
 * Overclock Network — global intelligence plane (SpacetimeDB 2.x TypeScript module).
 *
 * Independent Overclock engines share validated, portable execution capabilities through this
 * database. Every write goes through a transactional reducer; every identity check uses the
 * authenticated connection identity (`ctx.sender`), never an argument.
 *
 * Admin bootstrap: `init` runs once when the database is first published (or cleared), and its
 * `ctx.sender` is the database owner (the identity that ran `spacetime publish`). The owner is
 * stored in `network_config` and inserted into `publishers` as an authorized admin. Every other
 * identity registers itself as `pending` and must be authorized by an admin.
 *
 * Tables are public unless noted, so clients can replicate them with scoped subscriptions
 * (`watchOrigins` subscribes only to rows linked to the requested application origins).
 * Capability payloads live in their own table and are fetched on demand, never streamed with
 * registry metadata.
 */

import { schema, table, t, SenderError, type InferSchema, type ReducerCtx } from "spacetimedb/server";
import { Timestamp, type Identity } from "spacetimedb";
import {
  FAILURE_CATEGORIES,
  MAX_CAPABILITY_BYTES,
  canTransition,
  checkPayload,
  findSecret,
  hostOf,
  isRole,
  normalizeOrigin,
  requireDigest,
  requireId,
  requireRouteFamily,
  requireToken,
  sanitizeText,
  type PublicationState,
  type PublisherRole,
} from "./checks";
import { sha256Hex, utf8Bytes } from "./sha256";

/** Activity feed is bounded: older rows are deleted as new ones arrive. */
const ACTIVITY_LIMIT = 1000;
/** Selection key for "all UI variants of the capability's applications". */
const DEFAULT_VARIANT = "*";
const MIN_LEASE_MS = 200;
const MAX_LEASE_MS = 15 * 60 * 1000;
const MAX_COMPATIBLE_VERSIONS = 32;

// =============================================================================================
// Tables
// =============================================================================================

/** Private singleton (id = 0): module owner and contiguous counters. */
const networkConfig = table(
  { name: "network_config" },
  {
    id: t.u32().primaryKey(),
    owner: t.identity(),
    activitySeq: t.u64(),
    createdAt: t.timestamp(),
  },
);

const publishers = table(
  { name: "publishers", public: true },
  {
    identity: t.identity().primaryKey(),
    displayName: t.string(),
    /** publisher | validator | repairer | admin */
    role: t.string(),
    /** pending | authorized | suspended */
    status: t.string().index("btree"),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  },
);

const applications = table(
  { name: "applications", public: true },
  {
    /** Public app id: "app-" + sha256(origin)[0..16]. */
    appId: t.string().primaryKey(),
    origin: t.string().unique(),
    /** Host part of the origin (site identity without scheme/port). */
    siteId: t.string(),
    routeFamilies: t.array(t.string()),
    registeredBy: t.identity(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  },
);

const uiVariants = table(
  { name: "ui_variants", public: true },
  {
    variantId: t.string().primaryKey(),
    appId: t.string().index("btree"),
    origin: t.string().index("btree"),
    /** Structural interface fingerprint of this variant. */
    fingerprint: t.string(),
    /** Coarse, non-sensitive feature metadata. */
    roleClass: t.string(),
    locale: t.string(),
    featureVariant: t.string(),
    routeFamilies: t.array(t.string()),
    /** Promoted versions known to run on this variant (most recent last). */
    compatibleVersionIds: t.array(t.string()),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  },
);

const capabilities = table(
  { name: "capabilities", public: true },
  {
    capabilityId: t.string().primaryKey(),
    canonicalOperation: t.string().index("btree"),
    description: t.string(),
    appIds: t.array(t.string()),
    origins: t.array(t.string()),
    /** Required permission classes (from requirements.permissions of the latest version). */
    requiredPermissions: t.array(t.string()),
    createdBy: t.identity(),
    latestVersion: t.u32(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  },
);

/** Capability <-> application link; the join key for origin-scoped subscriptions. */
const capabilityApps = table(
  { name: "capability_apps", public: true },
  {
    linkId: t.string().primaryKey(),
    capabilityId: t.string().index("btree"),
    appId: t.string().index("btree"),
    origin: t.string().index("btree"),
  },
);

/** Version metadata. The payload itself is in `capability_payloads`. */
const capabilityVersions = table(
  { name: "capability_versions", public: true },
  {
    /** `${capabilityId}@${version}` */
    versionId: t.string().primaryKey(),
    capabilityId: t.string().index("btree"),
    version: t.u32(),
    schemaVersion: t.string(),
    compilerVersion: t.string(),
    canonicalOperation: t.string(),
    origins: t.array(t.string()),
    interfaceFingerprints: t.array(t.string()),
    /** sha256 hex of the UTF-8 payload. */
    contentHash: t.string().index("btree"),
    byteSize: t.u32(),
    state: t.string(),
    previousState: t.string(),
    stateReason: t.string(),
    publisher: t.identity(),
    /** 0 when this version is not a repair of an earlier one. */
    parentVersion: t.u32(),
    /** Passing validations from authorized validators other than the publisher. */
    passValidations: t.u32(),
    failValidations: t.u32(),
    /** Outcome of the most recent independent validation ("" if none). */
    lastValidationOutcome: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
    stateChangedAt: t.timestamp(),
  },
);

const capabilityPayloads = table(
  { name: "capability_payloads", public: true },
  {
    versionId: t.string().primaryKey(),
    capabilityId: t.string().index("btree"),
    contentHash: t.string(),
    /** JSON of a PortableCapability, at most MAX_CAPABILITY_BYTES of UTF-8. */
    payload: t.string(),
  },
);

const activeSelections = table(
  { name: "active_selections", public: true },
  {
    /** `${capabilityId}|${variantId}` */
    selectionId: t.string().primaryKey(),
    capabilityId: t.string().index("btree"),
    variantId: t.string(),
    /** "" when no known-good version remains. */
    activeVersionId: t.string(),
    activeVersion: t.u32(),
    previousVersionId: t.string(),
    /** Increments on every change of this selection. */
    selectionVersion: t.u64(),
    reason: t.string(),
    updatedBy: t.identity(),
    updatedAt: t.timestamp(),
  },
);

const repairJobs = table(
  { name: "repair_jobs", public: true },
  {
    jobId: t.string().primaryKey(),
    capabilityId: t.string().index("btree"),
    versionId: t.string(),
    version: t.u32(),
    signatureKey: t.string().unique(),
    category: t.string(),
    subject: t.string(),
    observedFingerprint: t.string(),
    /** open | leased | proposed | validated | promoted | failed | abandoned */
    status: t.string().index("btree"),
    holder: t.option(t.identity()),
    holderLabel: t.string(),
    leaseExpiresAt: t.option(t.timestamp()),
    fencingToken: t.u64(),
    attempts: t.u32(),
    proposedVersionId: t.string(),
    reporters: t.u32(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  },
);

/** Private: distinct reporter identities per repair job (for the reporter count). */
const repairReporters = table(
  { name: "repair_reporters" },
  {
    key: t.string().primaryKey(),
    jobId: t.string().index("btree"),
    reporter: t.identity(),
    reportedAt: t.timestamp(),
  },
);

const validationRecords = table(
  { name: "validation_records", public: true },
  {
    recordId: t.u64().primaryKey().autoInc(),
    versionId: t.string().index("btree"),
    capabilityId: t.string().index("btree"),
    environment: t.string(),
    outcome: t.string(),
    category: t.string(),
    evidenceDigest: t.string(),
    detail: t.string(),
    validator: t.identity(),
    /** Validator differs from the version's publisher. */
    independent: t.bool(),
    createdAt: t.timestamp(),
  },
);

const reuseStats = table(
  { name: "reuse_stats", public: true },
  {
    versionId: t.string().primaryKey(),
    capabilityId: t.string().index("btree"),
    attempts: t.u64(),
    successes: t.u64(),
    updatedAt: t.timestamp(),
  },
);

const activity = table(
  { name: "activity", public: true },
  {
    activityId: t.u64().primaryKey(),
    kind: t.string(),
    actorLabel: t.string(),
    /** Primary origin of the subject ("" when not origin-scoped). */
    origin: t.string().index("btree"),
    capabilityId: t.string(),
    versionId: t.string(),
    version: t.u32(),
    detail: t.string(),
    at: t.timestamp(),
  },
);

const spacetimedb = schema({
  networkConfig,
  publishers,
  applications,
  uiVariants,
  capabilities,
  capabilityApps,
  capabilityVersions,
  capabilityPayloads,
  activeSelections,
  repairJobs,
  repairReporters,
  validationRecords,
  reuseStats,
  activity,
});
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type PublisherRow = NonNullable<ReturnType<Ctx["db"]["publishers"]["identity"]["find"]>>;
type VersionRow = NonNullable<ReturnType<Ctx["db"]["capabilityVersions"]["versionId"]["find"]>>;
type JobRow = NonNullable<ReturnType<Ctx["db"]["repairJobs"]["jobId"]["find"]>>;

// =============================================================================================
// Helpers
// =============================================================================================

function nowMicros(ctx: Ctx): bigint {
  return ctx.timestamp.microsSinceUnixEpoch;
}

function hex(id: Identity): string {
  return id.toHexString();
}

function config(ctx: Ctx) {
  const c = ctx.db.networkConfig.id.find(0);
  if (!c) throw new Error("network_config missing: the module was not initialized");
  return c;
}

function callerRow(ctx: Ctx): PublisherRow | null {
  return ctx.db.publishers.identity.find(ctx.sender) ?? null;
}

const ANY_ROLE: readonly PublisherRole[] = ["publisher", "validator", "repairer", "admin"];
const CAN_PUBLISH: readonly PublisherRole[] = ["publisher", "repairer", "admin"];
const CAN_VALIDATE: readonly PublisherRole[] = ["validator", "admin"];
const CAN_REPAIR: readonly PublisherRole[] = ["publisher", "repairer", "admin"];
const CAN_QUARANTINE: readonly PublisherRole[] = ["validator", "admin"];
const ADMIN: readonly PublisherRole[] = ["admin"];

function requireRole(ctx: Ctx, roles: readonly PublisherRole[], action: string): PublisherRow {
  const row = callerRow(ctx);
  if (!row) throw new SenderError(`not authorized to ${action}: identity is not registered`);
  if (row.status !== "authorized") throw new SenderError(`not authorized to ${action}: publisher status is ${row.status}`);
  if (!isRole(row.role) || !roles.includes(row.role)) throw new SenderError(`not authorized to ${action}: role ${row.role} is not allowed`);
  return row;
}

function actorLabel(ctx: Ctx): string {
  const row = callerRow(ctx);
  return row ? row.displayName : `anon-${hex(ctx.sender).slice(0, 8)}`;
}

function logActivity(
  ctx: Ctx,
  kind: string,
  f: { detail: string; origin?: string; capabilityId?: string; versionId?: string; version?: number },
): void {
  const cfg = config(ctx);
  const seq = cfg.activitySeq + 1n;
  ctx.db.networkConfig.id.update({ ...cfg, activitySeq: seq });
  ctx.db.activity.insert({
    activityId: seq,
    kind,
    actorLabel: sanitizeText(actorLabel(ctx), 64),
    origin: f.origin ?? "",
    capabilityId: f.capabilityId ?? "",
    versionId: f.versionId ?? "",
    version: f.version ?? 0,
    detail: sanitizeText(f.detail, 240),
    at: ctx.timestamp,
  });
  const cutoff = seq - BigInt(ACTIVITY_LIMIT);
  if (cutoff > 0n) ctx.db.activity.activityId.delete(cutoff);
}

function appIdFor(origin: string): string {
  return `app-${sha256Hex(origin).slice(0, 16)}`;
}

function versionIdFor(capabilityId: string, version: number): string {
  return `${capabilityId}@${version}`;
}

function selectionIdFor(capabilityId: string, variantId: string): string {
  return `${capabilityId}|${variantId}`;
}

function primaryOrigin(ctx: Ctx, capabilityId: string): string {
  const cap = ctx.db.capabilities.capabilityId.find(capabilityId);
  return cap?.origins[0] ?? "";
}

function requireVersion(ctx: Ctx, versionId: string): VersionRow {
  const v = ctx.db.capabilityVersions.versionId.find(versionId);
  if (!v) throw new SenderError(`unknown capability version ${sanitizeText(versionId, 140)}`);
  return v;
}

function transition(ctx: Ctx, v: VersionRow, to: PublicationState, reason: string): VersionRow {
  if (!canTransition(v.state, to)) throw new SenderError(`illegal publication transition ${v.state} -> ${to}`);
  const next: VersionRow = {
    ...v,
    previousState: v.state,
    state: to,
    stateReason: sanitizeText(reason, 200),
    stateChangedAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  };
  ctx.db.capabilityVersions.versionId.update(next);
  return next;
}

function versionsOf(ctx: Ctx, capabilityId: string): VersionRow[] {
  return [...ctx.db.capabilityVersions.capabilityId.filter(capabilityId)];
}

/** Highest-numbered version still ACTIVE (promoted, known-good), excluding `exceptVersionId`. */
function knownGoodFallback(ctx: Ctx, capabilityId: string, exceptVersionId: string, below?: number): VersionRow | null {
  let best: VersionRow | null = null;
  for (const v of versionsOf(ctx, capabilityId)) {
    if (v.versionId === exceptVersionId || v.state !== "ACTIVE") continue;
    if (below !== undefined && v.version >= below) continue;
    if (!best || v.version > best.version) best = v;
  }
  return best;
}

function setSelection(ctx: Ctx, capabilityId: string, target: VersionRow | null, reason: string): void {
  const selectionId = selectionIdFor(capabilityId, DEFAULT_VARIANT);
  const cur = ctx.db.activeSelections.selectionId.find(selectionId);
  const row = {
    selectionId,
    capabilityId,
    variantId: DEFAULT_VARIANT,
    activeVersionId: target?.versionId ?? "",
    activeVersion: target?.version ?? 0,
    previousVersionId: cur?.activeVersionId ?? "",
    selectionVersion: (cur?.selectionVersion ?? 0n) + 1n,
    reason: sanitizeText(reason, 200),
    updatedBy: ctx.sender,
    updatedAt: ctx.timestamp,
  };
  if (cur) ctx.db.activeSelections.selectionId.update(row);
  else ctx.db.activeSelections.insert(row);
}

function updateVariantCompatibility(ctx: Ctx, v: VersionRow, add: boolean): void {
  const fps = new Set(v.interfaceFingerprints);
  for (const link of ctx.db.capabilityApps.capabilityId.filter(v.capabilityId)) {
    for (const variant of [...ctx.db.uiVariants.appId.filter(link.appId)]) {
      const has = variant.compatibleVersionIds.includes(v.versionId);
      if (add && !has && fps.has(variant.fingerprint)) {
        const ids = [...variant.compatibleVersionIds, v.versionId].slice(-MAX_COMPATIBLE_VERSIONS);
        ctx.db.uiVariants.variantId.update({ ...variant, compatibleVersionIds: ids, updatedAt: ctx.timestamp });
      } else if (!add && has) {
        ctx.db.uiVariants.variantId.update({
          ...variant,
          compatibleVersionIds: variant.compatibleVersionIds.filter((id) => id !== v.versionId),
          updatedAt: ctx.timestamp,
        });
      }
    }
  }
}

/** Remove a version from active selection (falling back to the previous known-good version). */
function deselect(ctx: Ctx, v: VersionRow, reason: string): void {
  updateVariantCompatibility(ctx, v, false);
  const sel = ctx.db.activeSelections.selectionId.find(selectionIdFor(v.capabilityId, DEFAULT_VARIANT));
  if (sel && sel.activeVersionId === v.versionId) {
    const fallback = knownGoodFallback(ctx, v.capabilityId, v.versionId);
    setSelection(ctx, v.capabilityId, fallback, fallback ? `fallback to v${fallback.version}: ${reason}` : `no known-good version: ${reason}`);
  }
  // A repair whose proposed fix is pulled goes back to the queue.
  for (const job of [...ctx.db.repairJobs.capabilityId.filter(v.capabilityId)]) {
    if (job.proposedVersionId === v.versionId && (job.status === "proposed" || job.status === "validated" || job.status === "promoted")) {
      ctx.db.repairJobs.jobId.update({ ...job, status: "open", proposedVersionId: "", holder: undefined, leaseExpiresAt: undefined, updatedAt: ctx.timestamp });
    }
  }
}

function setJobStatusForProposed(ctx: Ctx, v: VersionRow, status: "validated" | "promoted"): void {
  for (const job of [...ctx.db.repairJobs.capabilityId.filter(v.capabilityId)]) {
    if (job.proposedVersionId === v.versionId && job.status !== status && job.status !== "promoted") {
      ctx.db.repairJobs.jobId.update({ ...job, status, updatedAt: ctx.timestamp });
    }
  }
}

/** Independent passing validation from a currently authorized validator, not superseded by a fail. */
function hasIndependentPass(ctx: Ctx, v: VersionRow): boolean {
  const records = [...ctx.db.validationRecords.versionId.filter(v.versionId)].sort((a, b) => (a.recordId < b.recordId ? -1 : 1));
  let pass = false;
  for (const r of records) {
    if (!r.independent || r.validator.equals(v.publisher)) continue;
    const validator = ctx.db.publishers.identity.find(r.validator);
    if (!validator || validator.status !== "authorized" || !isRole(validator.role) || !CAN_VALIDATE.includes(validator.role)) continue;
    // The most recent independent result decides: a later fail cancels an earlier pass.
    pass = r.outcome === "pass";
  }
  return pass;
}

// =============================================================================================
// Lifecycle
// =============================================================================================

export const init = spacetimedb.init((ctx) => {
  ctx.db.networkConfig.insert({ id: 0, owner: ctx.sender, activitySeq: 0n, createdAt: ctx.timestamp });
  ctx.db.publishers.insert({
    identity: ctx.sender,
    displayName: "network-owner",
    role: "admin",
    status: "authorized",
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
});

// =============================================================================================
// Publishers
// =============================================================================================

export const registerPublisher = spacetimedb.reducer({ displayName: t.string(), role: t.string() }, (ctx, { displayName, role }) => {
  const name = sanitizeText(displayName, 64);
  if (name.length === 0) throw new SenderError("displayName is required");
  if (!isRole(role)) throw new SenderError(`unknown role ${sanitizeText(role, 32)}`);
  const existing = callerRow(ctx);
  if (existing) {
    // Only a pending registration may change its requested role; status never changes here.
    const next = { ...existing, displayName: name, role: existing.status === "pending" ? role : existing.role, updatedAt: ctx.timestamp };
    ctx.db.publishers.identity.update(next);
    return;
  }
  ctx.db.publishers.insert({ identity: ctx.sender, displayName: name, role, status: "pending", createdAt: ctx.timestamp, updatedAt: ctx.timestamp });
  logActivity(ctx, "publisher.registered", { detail: `${name} requested role ${role}` });
});

export const authorizePublisher = spacetimedb.reducer({ target: t.identity(), role: t.string() }, (ctx, { target, role }) => {
  requireRole(ctx, ADMIN, "authorize publishers");
  if (!isRole(role)) throw new SenderError(`unknown role ${sanitizeText(role, 32)}`);
  const row = ctx.db.publishers.identity.find(target);
  if (!row) throw new SenderError("target identity has not registered");
  if (target.equals(config(ctx).owner) && role !== "admin") throw new SenderError("the network owner always stays admin");
  ctx.db.publishers.identity.update({ ...row, role, status: "authorized", updatedAt: ctx.timestamp });
  logActivity(ctx, "publisher.authorized", { detail: `${row.displayName} authorized as ${role}` });
});

export const suspendPublisher = spacetimedb.reducer({ target: t.identity() }, (ctx, { target }) => {
  requireRole(ctx, ADMIN, "suspend publishers");
  const row = ctx.db.publishers.identity.find(target);
  if (!row) throw new SenderError("target identity has not registered");
  if (target.equals(config(ctx).owner)) throw new SenderError("the network owner cannot be suspended");
  ctx.db.publishers.identity.update({ ...row, status: "suspended", updatedAt: ctx.timestamp });
  logActivity(ctx, "publisher.suspended", { detail: `${row.displayName} suspended` });
});

// =============================================================================================
// Applications
// =============================================================================================

export const registerApplication = spacetimedb.reducer({ origin: t.string(), routeFamilies: t.array(t.string()) }, (ctx, { origin, routeFamilies }) => {
  requireRole(ctx, ANY_ROLE, "register applications");
  const norm = normalizeOrigin(origin);
  if (norm === null) throw new SenderError("origin must be scheme://host[:port] (http or https)");
  if (routeFamilies.length > 128) throw new SenderError("at most 128 route families");
  const families = routeFamilies.map(requireRouteFamily);
  const existing = ctx.db.applications.origin.find(norm);
  if (existing) {
    const merged = [...new Set([...existing.routeFamilies, ...families])].slice(0, 256);
    ctx.db.applications.appId.update({ ...existing, routeFamilies: merged, updatedAt: ctx.timestamp });
    return;
  }
  const appId = appIdFor(norm);
  ctx.db.applications.insert({
    appId,
    origin: norm,
    siteId: hostOf(norm),
    routeFamilies: [...new Set(families)],
    registeredBy: ctx.sender,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
  logActivity(ctx, "application.registered", { origin: norm, detail: `registered ${hostOf(norm)} (${families.length} route families)` });
});

// =============================================================================================
// Capabilities
// =============================================================================================

export const proposeCapability = spacetimedb.reducer(
  { payload: t.string(), contentHash: t.string(), byteSize: t.u32() },
  (ctx, { payload, contentHash, byteSize }) => {
    const publisher = requireRole(ctx, CAN_PUBLISH, "propose capabilities");
    const bytes = utf8Bytes(payload);
    if (bytes.length > MAX_CAPABILITY_BYTES) throw new SenderError(`payload is ${bytes.length} bytes; the limit is ${MAX_CAPABILITY_BYTES}`);
    if (bytes.length !== byteSize) throw new SenderError(`byteSize ${byteSize} does not match the payload (${bytes.length} bytes)`);
    const actualHash = sha256Hex(bytes);
    if (actualHash !== contentHash.toLowerCase()) throw new SenderError("contentHash does not match the payload");

    const summary = checkPayload(payload, (o) => ctx.db.applications.origin.find(o) != null);
    if (summary.publisherId !== hex(ctx.sender)) {
      throw new SenderError("payload.publisherId must be the authenticated identity of the caller");
    }
    const versionId = versionIdFor(summary.capabilityId, summary.version);
    if (ctx.db.capabilityVersions.versionId.find(versionId)) throw new SenderError(`version ${summary.version} of ${summary.capabilityId} already exists`);
    if (summary.parentVersion > 0 && !ctx.db.capabilityVersions.versionId.find(versionIdFor(summary.capabilityId, summary.parentVersion))) {
      throw new SenderError(`parent version ${summary.parentVersion} does not exist`);
    }

    const existingCap = ctx.db.capabilities.capabilityId.find(summary.capabilityId);
    if (existingCap && existingCap.canonicalOperation !== summary.canonicalOperation) {
      throw new SenderError("a new version must keep the capability's canonical operation");
    }

    const origins = [...new Set(summary.applications.map((a) => a.origin))];
    const appIds: string[] = [];
    for (const app of summary.applications) {
      const appRow = ctx.db.applications.origin.find(app.origin);
      if (!appRow) throw new SenderError(`application origin ${app.origin} is not registered`);
      appIds.push(appRow.appId);
      const linkId = `${summary.capabilityId}|${appRow.appId}`;
      if (!ctx.db.capabilityApps.linkId.find(linkId)) {
        ctx.db.capabilityApps.insert({ linkId, capabilityId: summary.capabilityId, appId: appRow.appId, origin: app.origin });
      }
      const fingerprint = sanitizeText(app.interfaceFingerprint, 128);
      const variantId = `${appRow.appId}:${sha256Hex(`${fingerprint}\n${app.roleClass}\n${app.locale}\n${app.featureVariant}`).slice(0, 16)}`;
      const variant = ctx.db.uiVariants.variantId.find(variantId);
      const families = app.routeFamilies.filter((r) => r.length <= 128).slice(0, 64);
      if (variant) {
        ctx.db.uiVariants.variantId.update({ ...variant, routeFamilies: [...new Set([...variant.routeFamilies, ...families])].slice(0, 128), updatedAt: ctx.timestamp });
      } else {
        ctx.db.uiVariants.insert({
          variantId,
          appId: appRow.appId,
          origin: app.origin,
          fingerprint,
          roleClass: sanitizeText(app.roleClass, 32),
          locale: sanitizeText(app.locale, 32),
          featureVariant: sanitizeText(app.featureVariant, 64),
          routeFamilies: families,
          compatibleVersionIds: [],
          createdAt: ctx.timestamp,
          updatedAt: ctx.timestamp,
        });
      }
    }

    const capRow = {
      capabilityId: summary.capabilityId,
      canonicalOperation: summary.canonicalOperation,
      description: sanitizeText(summary.description, 300),
      appIds: [...new Set([...(existingCap?.appIds ?? []), ...appIds])],
      origins: [...new Set([...(existingCap?.origins ?? []), ...origins])],
      requiredPermissions: summary.permissions.map((p) => sanitizeText(p, 64)),
      createdBy: existingCap?.createdBy ?? ctx.sender,
      latestVersion: Math.max(existingCap?.latestVersion ?? 0, summary.version),
      createdAt: existingCap?.createdAt ?? ctx.timestamp,
      updatedAt: ctx.timestamp,
    };
    if (existingCap) ctx.db.capabilities.capabilityId.update(capRow);
    else ctx.db.capabilities.insert(capRow);

    ctx.db.capabilityVersions.insert({
      versionId,
      capabilityId: summary.capabilityId,
      version: summary.version,
      schemaVersion: summary.schemaVersion,
      compilerVersion: sanitizeText(summary.compilerVersion, 64),
      canonicalOperation: summary.canonicalOperation,
      origins,
      interfaceFingerprints: summary.interfaceFingerprints,
      contentHash: actualHash,
      byteSize: bytes.length,
      state: "PROPOSED",
      previousState: "",
      stateReason: "proposed",
      publisher: ctx.sender,
      parentVersion: summary.parentVersion,
      passValidations: 0,
      failValidations: 0,
      lastValidationOutcome: "",
      createdAt: ctx.timestamp,
      updatedAt: ctx.timestamp,
      stateChangedAt: ctx.timestamp,
    });
    ctx.db.capabilityPayloads.insert({ versionId, capabilityId: summary.capabilityId, contentHash: actualHash, payload });
    logActivity(ctx, "capability.proposed", {
      origin: origins[0] ?? "",
      capabilityId: summary.capabilityId,
      versionId,
      version: summary.version,
      detail: `${publisher.displayName} proposed v${summary.version}${summary.parentVersion ? ` (repairs v${summary.parentVersion})` : ""}, ${bytes.length} bytes`,
    });
  },
);

export const recordValidationResult = spacetimedb.reducer(
  { versionId: t.string(), environment: t.string(), outcome: t.string(), category: t.string(), evidenceDigest: t.string(), detail: t.string() },
  (ctx, args) => {
    const validator = requireRole(ctx, CAN_VALIDATE, "record validation results");
    let v = requireVersion(ctx, args.versionId);
    if (v.state === "REVOKED") throw new SenderError("version is revoked");
    if (args.outcome !== "pass" && args.outcome !== "fail") throw new SenderError('outcome must be "pass" or "fail"');
    const environment = requireToken("environment", args.environment);
    const category = requireToken("category", args.category);
    const evidenceDigest = requireDigest(args.evidenceDigest);
    if (args.detail.length > 500) throw new SenderError("detail is limited to 500 characters");
    const independent = !ctx.sender.equals(v.publisher);
    ctx.db.validationRecords.insert({
      recordId: 0n,
      versionId: v.versionId,
      capabilityId: v.capabilityId,
      environment,
      outcome: args.outcome,
      category,
      evidenceDigest,
      detail: sanitizeText(args.detail, 500),
      validator: ctx.sender,
      independent,
      createdAt: ctx.timestamp,
    });
    if (v.state === "PROPOSED") v = transition(ctx, v, "VALIDATING", `validation by ${validator.displayName}`);
    if (independent) {
      v = {
        ...v,
        passValidations: v.passValidations + (args.outcome === "pass" ? 1 : 0),
        failValidations: v.failValidations + (args.outcome === "fail" ? 1 : 0),
        lastValidationOutcome: args.outcome,
        updatedAt: ctx.timestamp,
      };
      ctx.db.capabilityVersions.versionId.update(v);
      if (args.outcome === "pass" && (v.state === "VALIDATING" || v.state === "QUARANTINED")) {
        v = transition(ctx, v, "VERIFIED", `independent pass in ${environment}`);
        setJobStatusForProposed(ctx, v, "validated");
      }
    }
    logActivity(ctx, "validation.recorded", {
      origin: v.origins[0] ?? "",
      capabilityId: v.capabilityId,
      versionId: v.versionId,
      version: v.version,
      detail: `${validator.displayName}: ${args.outcome} in ${environment} (${category})${independent ? "" : " [self-validation, not counted]"}`,
    });
  },
);

export const promoteCapabilityVersion = spacetimedb.reducer(
  { versionId: t.string(), canary: t.bool(), expectedSelectionVersion: t.option(t.u64()) },
  (ctx, { versionId, canary, expectedSelectionVersion }) => {
    const admin = requireRole(ctx, ADMIN, "promote capability versions");
    let v = requireVersion(ctx, versionId);
    if (v.state !== "VERIFIED" && v.state !== "CANARY") throw new SenderError(`only VERIFIED or CANARY versions can be promoted (state is ${v.state})`);
    if (!hasIndependentPass(ctx, v)) {
      throw new SenderError("promotion requires a passing validation from an authorized validator other than the publisher");
    }
    const sel = ctx.db.activeSelections.selectionId.find(selectionIdFor(v.capabilityId, DEFAULT_VARIANT));
    const currentSelectionVersion = sel?.selectionVersion ?? 0n;
    if (expectedSelectionVersion !== undefined && expectedSelectionVersion !== currentSelectionVersion) {
      throw new SenderError(`stale promotion: selection version is ${currentSelectionVersion}, expected ${expectedSelectionVersion}`);
    }
    if (sel && sel.activeVersionId !== "" && v.version <= sel.activeVersion) {
      throw new SenderError(`out-of-order promotion: v${v.version} is not newer than active v${sel.activeVersion}`);
    }
    if (v.state === "VERIFIED") v = transition(ctx, v, "CANARY", `canary by ${admin.displayName}`);
    if (canary) {
      logActivity(ctx, "capability.canary", { origin: v.origins[0] ?? "", capabilityId: v.capabilityId, versionId: v.versionId, version: v.version, detail: `v${v.version} entered canary` });
      return;
    }
    v = transition(ctx, v, "ACTIVE", `promoted by ${admin.displayName}`);
    setSelection(ctx, v.capabilityId, v, `promoted v${v.version}`);
    updateVariantCompatibility(ctx, v, true);
    setJobStatusForProposed(ctx, v, "promoted");
    logActivity(ctx, "capability.promoted", {
      origin: v.origins[0] ?? "",
      capabilityId: v.capabilityId,
      versionId: v.versionId,
      version: v.version,
      detail: `v${v.version} is now active${sel && sel.activeVersionId ? ` (was v${sel.activeVersion})` : ""}`,
    });
  },
);

export const quarantineCapabilityVersion = spacetimedb.reducer({ versionId: t.string(), reason: t.string() }, (ctx, { versionId, reason }) => {
  const actor = requireRole(ctx, CAN_QUARANTINE, "quarantine capability versions");
  const v = transition(ctx, requireVersion(ctx, versionId), "QUARANTINED", reason || `quarantined by ${actor.displayName}`);
  deselect(ctx, v, "quarantined");
  logActivity(ctx, "capability.quarantined", {
    origin: v.origins[0] ?? "",
    capabilityId: v.capabilityId,
    versionId: v.versionId,
    version: v.version,
    detail: `v${v.version} quarantined: ${reason}`,
  });
});

export const revokeCapabilityVersion = spacetimedb.reducer({ versionId: t.string(), reason: t.string() }, (ctx, { versionId, reason }) => {
  requireRole(ctx, ADMIN, "revoke capability versions");
  const v = transition(ctx, requireVersion(ctx, versionId), "REVOKED", reason || "revoked");
  deselect(ctx, v, "revoked");
  logActivity(ctx, "capability.revoked", { origin: v.origins[0] ?? "", capabilityId: v.capabilityId, versionId: v.versionId, version: v.version, detail: `v${v.version} revoked: ${reason}` });
});

export const restorePreviousVersion = spacetimedb.reducer({ capabilityId: t.string(), reason: t.string() }, (ctx, { capabilityId, reason }) => {
  requireRole(ctx, ADMIN, "restore capability versions");
  const sel = ctx.db.activeSelections.selectionId.find(selectionIdFor(capabilityId, DEFAULT_VARIANT));
  if (!sel || sel.activeVersionId === "") throw new SenderError("capability has no active version to roll back from");
  const current = requireVersion(ctx, sel.activeVersionId);
  const fallback = knownGoodFallback(ctx, capabilityId, current.versionId, current.version);
  if (!fallback) throw new SenderError("no previous known-good version to restore");
  const q = transition(ctx, current, "QUARANTINED", `rolled back to v${fallback.version}: ${reason}`);
  updateVariantCompatibility(ctx, q, false);
  setSelection(ctx, capabilityId, fallback, `restored v${fallback.version}: ${reason}`);
  logActivity(ctx, "capability.restored", {
    origin: primaryOrigin(ctx, capabilityId),
    capabilityId,
    versionId: fallback.versionId,
    version: fallback.version,
    detail: `restored v${fallback.version} (v${current.version} quarantined): ${reason}`,
  });
});

export const reportReuse = spacetimedb.reducer({ versionId: t.string(), ok: t.bool() }, (ctx, { versionId, ok }) => {
  requireRole(ctx, ANY_ROLE, "report reuse");
  const v = requireVersion(ctx, versionId);
  const cur = ctx.db.reuseStats.versionId.find(versionId);
  const row = {
    versionId,
    capabilityId: v.capabilityId,
    attempts: (cur?.attempts ?? 0n) + 1n,
    successes: (cur?.successes ?? 0n) + (ok ? 1n : 0n),
    updatedAt: ctx.timestamp,
  };
  if (cur) ctx.db.reuseStats.versionId.update(row);
  else ctx.db.reuseStats.insert(row);
});

// =============================================================================================
// Repair jobs and leases
// =============================================================================================

interface ReportResult {
  jobId: string;
  existing: boolean;
  reporters: number;
}

function reportFailureCore(
  ctx: Ctx,
  a: { capabilityId: string; version: number; category: string; subject: string; observedFingerprint: string },
): ReportResult {
  const reporter = requireRole(ctx, ANY_ROLE, "report compatibility failures");
  const v = requireVersion(ctx, versionIdFor(a.capabilityId, a.version));
  if (!(FAILURE_CATEGORIES as readonly string[]).includes(a.category)) throw new SenderError(`unknown failure category ${sanitizeText(a.category, 32)}`);
  if (a.subject.length === 0 || a.subject.length > 256 || findSecret(a.subject) !== null || /[\u0000-\u001f]/.test(a.subject)) {
    throw new SenderError("subject must be a portable control key or route family (1-256 chars, no secrets)");
  }
  if (a.observedFingerprint.length > 128) throw new SenderError("observedFingerprint is limited to 128 characters");
  const signatureKey = sha256Hex(`${v.capabilityId}\n${v.version}\n${a.category}\n${a.subject}`);
  const jobId = `rj-${signatureKey.slice(0, 24)}`;
  const reporterKey = `${jobId}|${hex(ctx.sender)}`;
  const isNewReporter = !ctx.db.repairReporters.key.find(reporterKey);
  if (isNewReporter) ctx.db.repairReporters.insert({ key: reporterKey, jobId, reporter: ctx.sender, reportedAt: ctx.timestamp });

  const job = ctx.db.repairJobs.signatureKey.find(signatureKey);
  if (job) {
    const reopen = job.status === "failed" || job.status === "abandoned";
    const next: JobRow = {
      ...job,
      status: reopen ? "open" : job.status,
      reporters: job.reporters + (isNewReporter ? 1 : 0),
      observedFingerprint: a.observedFingerprint || job.observedFingerprint,
      updatedAt: ctx.timestamp,
    };
    ctx.db.repairJobs.jobId.update(next);
    return { jobId, existing: true, reporters: next.reporters };
  }
  ctx.db.repairJobs.insert({
    jobId,
    capabilityId: v.capabilityId,
    versionId: v.versionId,
    version: v.version,
    signatureKey,
    category: a.category,
    subject: sanitizeText(a.subject, 256),
    observedFingerprint: a.observedFingerprint,
    status: "open",
    holder: undefined,
    holderLabel: "",
    leaseExpiresAt: undefined,
    fencingToken: 0n,
    attempts: 0,
    proposedVersionId: "",
    reporters: 1,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
  logActivity(ctx, "repair.reported", {
    origin: v.origins[0] ?? "",
    capabilityId: v.capabilityId,
    versionId: v.versionId,
    version: v.version,
    detail: `${reporter.displayName} reported ${a.category} on ${a.subject}`,
  });
  return { jobId, existing: false, reporters: 1 };
}

interface LeaseResult {
  jobId: string;
  ok: boolean;
  fencingToken: bigint;
  holder: string;
  expiresAtMicros: bigint;
  reason: string;
}

function clampLease(ms: number): bigint {
  return BigInt(Math.min(MAX_LEASE_MS, Math.max(MIN_LEASE_MS, Math.floor(ms))));
}

function requireJob(ctx: Ctx, jobId: string): JobRow {
  const job = ctx.db.repairJobs.jobId.find(jobId);
  if (!job) throw new SenderError(`unknown repair job ${sanitizeText(jobId, 64)}`);
  return job;
}

function leaseActive(ctx: Ctx, job: JobRow): boolean {
  return job.status === "leased" && job.leaseExpiresAt !== undefined && job.leaseExpiresAt.microsSinceUnixEpoch > nowMicros(ctx);
}

/** Holder checks shared by renew/finish/release: current fencing token, same holder, unexpired. */
function requireHolder(ctx: Ctx, job: JobRow, fencingToken: bigint): void {
  if (fencingToken !== job.fencingToken) throw new SenderError(`stale fencing token ${fencingToken} (current is ${job.fencingToken})`);
  if (job.status !== "leased" || job.holder === undefined || !job.holder.equals(ctx.sender)) throw new SenderError("caller does not hold the repair lease");
  if (!leaseActive(ctx, job)) throw new SenderError("repair lease has expired");
}

function claimCore(ctx: Ctx, a: { jobId: string; leaseMs: number }): LeaseResult {
  const repairer = requireRole(ctx, CAN_REPAIR, "claim repair leases");
  const job = requireJob(ctx, a.jobId);
  if (job.status === "leased" && leaseActive(ctx, job)) throw new SenderError("repair lease is held by another holder");
  if (job.status !== "open" && job.status !== "leased") throw new SenderError(`repair job is ${job.status} and cannot be claimed`);
  const expires = new Timestamp(nowMicros(ctx) + clampLease(a.leaseMs) * 1000n);
  const next: JobRow = {
    ...job,
    status: "leased",
    holder: ctx.sender,
    holderLabel: repairer.displayName,
    leaseExpiresAt: expires,
    fencingToken: job.fencingToken + 1n,
    attempts: job.attempts + 1,
    updatedAt: ctx.timestamp,
  };
  ctx.db.repairJobs.jobId.update(next);
  logActivity(ctx, "repair.claimed", {
    origin: primaryOrigin(ctx, job.capabilityId),
    capabilityId: job.capabilityId,
    versionId: job.versionId,
    version: job.version,
    detail: `${repairer.displayName} claimed repair (token ${next.fencingToken}, attempt ${next.attempts})`,
  });
  return { jobId: job.jobId, ok: true, fencingToken: next.fencingToken, holder: hex(ctx.sender), expiresAtMicros: expires.microsSinceUnixEpoch, reason: "" };
}

function renewCore(ctx: Ctx, a: { jobId: string; fencingToken: bigint; leaseMs: number }): LeaseResult {
  requireRole(ctx, CAN_REPAIR, "renew repair leases");
  const job = requireJob(ctx, a.jobId);
  requireHolder(ctx, job, a.fencingToken);
  const expires = new Timestamp(nowMicros(ctx) + clampLease(a.leaseMs) * 1000n);
  ctx.db.repairJobs.jobId.update({ ...job, leaseExpiresAt: expires, updatedAt: ctx.timestamp });
  return { jobId: job.jobId, ok: true, fencingToken: job.fencingToken, holder: hex(ctx.sender), expiresAtMicros: expires.microsSinceUnixEpoch, reason: "" };
}

function finishCore(ctx: Ctx, a: { jobId: string; fencingToken: bigint; proposedVersionId: string }): void {
  const repairer = requireRole(ctx, CAN_REPAIR, "finish repair jobs");
  const job = requireJob(ctx, a.jobId);
  requireHolder(ctx, job, a.fencingToken);
  const proposed = requireVersion(ctx, a.proposedVersionId);
  if (proposed.capabilityId !== job.capabilityId) throw new SenderError("proposed version belongs to a different capability");
  if (proposed.version <= job.version) throw new SenderError("proposed version must be newer than the failing version");
  if (!proposed.publisher.equals(ctx.sender)) throw new SenderError("the lease holder must have published the proposed version");
  if (proposed.state === "QUARANTINED" || proposed.state === "REVOKED") throw new SenderError(`proposed version is ${proposed.state}`);
  const status = proposed.state === "ACTIVE" ? "promoted" : proposed.state === "VERIFIED" || proposed.state === "CANARY" ? "validated" : "proposed";
  ctx.db.repairJobs.jobId.update({ ...job, status, proposedVersionId: proposed.versionId, leaseExpiresAt: undefined, updatedAt: ctx.timestamp });
  logActivity(ctx, "repair.finished", {
    origin: primaryOrigin(ctx, job.capabilityId),
    capabilityId: job.capabilityId,
    versionId: proposed.versionId,
    version: proposed.version,
    detail: `${repairer.displayName} proposed v${proposed.version} to repair v${job.version}`,
  });
}

function releaseCore(ctx: Ctx, a: { jobId: string; fencingToken: bigint }): void {
  const repairer = requireRole(ctx, CAN_REPAIR, "release repair leases");
  const job = requireJob(ctx, a.jobId);
  requireHolder(ctx, job, a.fencingToken);
  ctx.db.repairJobs.jobId.update({ ...job, status: "open", holder: undefined, holderLabel: "", leaseExpiresAt: undefined, updatedAt: ctx.timestamp });
  logActivity(ctx, "repair.released", {
    origin: primaryOrigin(ctx, job.capabilityId),
    capabilityId: job.capabilityId,
    versionId: job.versionId,
    version: job.version,
    detail: `${repairer.displayName} released the repair lease`,
  });
}

const failureArgs = { capabilityId: t.string(), version: t.u32(), category: t.string(), subject: t.string(), observedFingerprint: t.string() };

export const reportCompatibilityFailure = spacetimedb.reducer(failureArgs, (ctx, a) => {
  reportFailureCore(ctx, a);
});
export const claimRepairLease = spacetimedb.reducer({ jobId: t.string(), leaseMs: t.u32() }, (ctx, a) => {
  claimCore(ctx, a);
});
export const renewRepairLease = spacetimedb.reducer({ jobId: t.string(), fencingToken: t.u64(), leaseMs: t.u32() }, (ctx, a) => {
  renewCore(ctx, a);
});
export const finishRepairJob = spacetimedb.reducer({ jobId: t.string(), fencingToken: t.u64(), proposedVersionId: t.string() }, (ctx, a) => {
  finishCore(ctx, a);
});
export const releaseRepairLease = spacetimedb.reducer({ jobId: t.string(), fencingToken: t.u64() }, (ctx, a) => {
  releaseCore(ctx, a);
});

// Procedures: the same transactional logic as the reducers above (run inside `withTx`), but
// they return the outcome to the caller (job id, fencing token, lease expiry), which reducers
// cannot do. A SenderError rolls the transaction back and is reported as `ok: false`.

const ReportFailureResult = t.object("ReportFailureResult", { jobId: t.string(), existing: t.bool(), reporters: t.u32() });
const RepairLeaseResult = t.object("RepairLeaseResult", {
  jobId: t.string(),
  ok: t.bool(),
  fencingToken: t.u64(),
  holder: t.string(),
  expiresAtMicros: t.i64(),
  reason: t.string(),
});
const RepairFinishResult = t.object("RepairFinishResult", { ok: t.bool(), reason: t.string() });

function senderMessage(e: unknown): string | null {
  return e instanceof SenderError ? e.message : null;
}

export const reportCompatibilityFailureResult = spacetimedb.procedure(failureArgs, ReportFailureResult, (ctx, a) =>
  ctx.withTx((tx) => reportFailureCore(tx, a)),
);

export const claimRepairLeaseResult = spacetimedb.procedure({ jobId: t.string(), leaseMs: t.u32() }, RepairLeaseResult, (ctx, a) => {
  try {
    return ctx.withTx((tx) => claimCore(tx, a));
  } catch (e) {
    const reason = senderMessage(e);
    if (reason === null) throw e;
    return { jobId: a.jobId, ok: false, fencingToken: 0n, holder: "", expiresAtMicros: 0n, reason };
  }
});

export const renewRepairLeaseResult = spacetimedb.procedure(
  { jobId: t.string(), fencingToken: t.u64(), leaseMs: t.u32() },
  RepairLeaseResult,
  (ctx, a) => {
    try {
      return ctx.withTx((tx) => renewCore(tx, a));
    } catch (e) {
      const reason = senderMessage(e);
      if (reason === null) throw e;
      return { jobId: a.jobId, ok: false, fencingToken: a.fencingToken, holder: "", expiresAtMicros: 0n, reason };
    }
  },
);

export const finishRepairJobResult = spacetimedb.procedure(
  { jobId: t.string(), fencingToken: t.u64(), proposedVersionId: t.string() },
  RepairFinishResult,
  (ctx, a) => {
    try {
      ctx.withTx((tx) => finishCore(tx, a));
      return { ok: true, reason: "" };
    } catch (e) {
      const reason = senderMessage(e);
      if (reason === null) throw e;
      return { ok: false, reason };
    }
  },
);

// =============================================================================================
// Views
// =============================================================================================

/** The caller's own publisher row (status/role), so a client knows whether it may publish. */
export const myPublisher = spacetimedb.view({ name: "my_publisher", public: true }, t.option(publishers.rowType), (ctx) =>
  ctx.db.publishers.identity.find(ctx.sender) ?? undefined,
);

const NetworkSummaryRow = t.row("NetworkSummaryRow", {
  applications: t.u64(),
  capabilities: t.u64(),
  versions: t.u64(),
  selections: t.u64(),
  publishers: t.u64(),
  repairJobs: t.u64(),
  validations: t.u64(),
});

/** Global counts for the dashboard (constant-time `count()` lookups, shared by all viewers). */
export const networkSummary = spacetimedb.anonymousView({ name: "network_summary", public: true }, t.array(NetworkSummaryRow), (ctx) => [
  {
    applications: ctx.db.applications.count(),
    capabilities: ctx.db.capabilities.count(),
    versions: ctx.db.capabilityVersions.count(),
    selections: ctx.db.activeSelections.count(),
    publishers: ctx.db.publishers.count(),
    repairJobs: ctx.db.repairJobs.count(),
    validations: ctx.db.validationRecords.count(),
  },
]);
