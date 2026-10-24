import { canonicalGoalText, canonicalRecordFields, type AppBinding, type AppControl, type AppModel, type DslPlan } from "@overclock/contracts";
import { CAPABILITY_SCHEMA_VERSION, type PortableApplication, type PortableCapability, type PortableControl, type PortablePage } from "@overclock/network-contracts";
import { routePattern } from "@overclock/perception";
import { baseKey, describeControl, pageOf, qualifiers, regionMap, type ControlDescriptor } from "./describe";
import { sha256, shortHash, withArtifactHash } from "./hash";
import { controlRefs, gotoTemplates, mapControlRefs, submitContexts, templateRoute } from "./plan";
import { CapabilityRejectedError, sanitizeCapability, scrubText, type Finding } from "./sanitize";

export interface ExportInput {
  /** A validated plan that ran successfully, referencing this runtime's app-model control ids. */
  plan: DslPlan;
  /** App models the plan was compiled against. */
  models: AppModel[];
  apps: AppBinding[];
  goal: string;
  /** Record field names of the run's input (`$rec.<field>`), e.g. ["orderId"]. */
  recordFields: string[];
  /** Verified write receipts in the publishing run. */
  verifiedReceipts: number;
  compilerVersion: string;
  /** The run's input records: used only to detect record values that leaked into the artifact; never exported. */
  records?: Record<string, unknown>[] | undefined;
  capabilityId?: string | undefined;
  version?: number | undefined;
  /** Version this one repairs. */
  parentVersion?: number | undefined;
  /** Ignored by the server (it uses the authenticated identity); kept for local bookkeeping. */
  publisherId?: string | undefined;
  createdAt?: number | undefined;
  /** Coarse, non-sensitive role class per app name (default: "writer" for apps the plan writes, else "reader"). */
  roleClass?: Record<string, string> | undefined;
  locale?: string | undefined;
  featureVariant?: string | undefined;
}

export interface ExportReport {
  redactions: number;
  warnings: string[];
  findings: Finding[];
}

export interface ExportResult {
  capability: PortableCapability;
  report: ExportReport;
}

/**
 * Lowercase, quoted literals and numbers replaced with placeholders, whitespace collapsed. For
 * the human-readable description only (it keeps record values out of the artifact). It is lossy
 * by design: "approved" and "rejected" normalize alike, so it must never identify an operation.
 */
export function normalizeGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<![\p{L}\p{N}])'[^'\n]*'(?![\p{L}\p{N}])/gu, "<str>")
    .replace(/\d+(?:[.,:]\d+)*/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Scheme of operation identities. "op2" hashes the exact goal text (canonicalGoalText) and the
 * record schema. Capabilities published before it carry a bare 64-hex hash of the lossy
 * normalized goal; analysis rejects those, so no runtime imports them.
 */
export const OPERATION_SCHEME = "op2";

/**
 * Operation identity: two tasks share it only when their instructions are the same text
 * (presentation aside) over the same record fields. Different record ids and values don't change
 * it; any different literal, number, or condition does. A hash, so the goal itself (which may
 * contain business values) never leaves the runtime.
 */
export function canonicalOperation(goal: string, recordFields: string[]): string {
  return `${OPERATION_SCHEME}:${sha256(JSON.stringify({ goal: canonicalGoalText(goal), recordFields: canonicalRecordFields(recordFields) }))}`;
}

/** True when an operation identity uses the current, exact scheme. */
export function isExactOperationIdentity(op: string): boolean {
  return new RegExp(`^${OPERATION_SCHEME}:[0-9a-f]{64}$`).test(op);
}

export function normalizeOrigin(o: string): string {
  return new URL(o).origin;
}

/** Path template with named params for a route family, e.g. "/orders/:id/edit" -> "/orders/{orderId}/edit". */
export function pathTemplateFor(routeFamily: string, templates: string[], recordFields: string[]): string {
  const segs = routeFamily.split("/");
  const names: (string | undefined)[] = [];
  for (const t of templates) {
    const tsegs = (t.split(/[?#]/)[0] ?? "").split("/");
    if (tsegs.length !== segs.length) continue;
    tsegs.forEach((ts, i) => {
      if (segs[i] !== ":id") return;
      // {$rec.f} or {encode($rec.f)}: URL-encoding doesn't change which record field fills the segment.
      const m = /^\{\s*(?:\$rec\.([A-Za-z_][A-Za-z0-9_]*)|encode\(\s*\$rec\.([A-Za-z_][A-Za-z0-9_]*)\s*\))\s*\}$/.exec(ts);
      const field = m?.[1] ?? m?.[2];
      if (field && recordFields.includes(field)) names[i] ??= field;
    });
  }
  let n = 0;
  const used = new Set<string>();
  return segs
    .map((s, i) => {
      if (s !== ":id") return s;
      let name = names[i];
      if (!name || used.has(name)) {
        n++;
        name = n === 1 ? "id" : `id${n}`;
      }
      used.add(name);
      return `{${name}}`;
    })
    .join("/");
}

function hrefRoute(href: string | undefined, origin: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, origin);
    if (u.origin !== new URL(origin).origin) return null;
    return routePattern(u.toString());
  } catch {
    return null;
  }
}

/**
 * How a fresh runtime finds a concrete instance of a parameterized page: a list-page table whose
 * link column points at the route (preferred), else any observed link to it.
 */
function reachViaFor(model: AppModel, routeFamily: string, tableKeyOf: (pageRoute: string, headers: string[]) => string | undefined): PortablePage["reachVia"] {
  const candidates: { route: string; score: number; tableKey?: string | undefined }[] = [];
  for (const p of model.pages) {
    if (p.routePattern === routeFamily) continue;
    const parameterized = p.routePattern.includes(":id");
    for (const t of p.tables) {
      if (t.sampleLinks.some((l) => hrefRoute(l, model.origin) === routeFamily)) candidates.push({ route: p.routePattern, score: parameterized ? 1 : 3, tableKey: tableKeyOf(p.routePattern, t.headers) });
    }
    for (const id of p.controlIds) {
      const c = model.controls[id];
      if (c && (c.kind === "link" || c.kind === "button") && hrefRoute(c.detail, model.origin) === routeFamily) candidates.push({ route: p.routePattern, score: parameterized ? 2 : 2.5 });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.route.localeCompare(b.route));
  const best = candidates[0];
  if (!best) return undefined;
  return best.tableKey ? { routeFamily: best.route, tableKey: best.tableKey } : { routeFamily: best.route };
}

/**
 * Export a plan that ran successfully as a Portable Execution Capability. The artifact is built
 * from structural observations (labels, roles, form schemas, table headers, route families),
 * never from traces, so there is little to redact; the sanitizer still runs over the result and
 * the export fails if anything credential-like or record-specific remains in the procedure.
 */
export function exportCapability(input: ExportInput): ExportResult {
  const warnings: string[] = [];
  let redactions = 0;
  const controlsById = new Map<string, { c: AppControl; model: AppModel }>();
  for (const m of input.models) for (const [id, c] of Object.entries(m.controls)) controlsById.set(id, { c, model: m });
  const modelOf = new Map(input.models.map((m) => [m.app, m]));
  const bindingOf = new Map(input.apps.map((a) => [a.name, a]));

  // ---- portable keys for every referenced control
  const refs = controlRefs(input.plan);
  const order: string[] = [];
  for (const r of refs) if (!order.includes(r.ref)) order.push(r.ref);
  const descriptors = new Map<string, ControlDescriptor>();
  for (const id of order) {
    const hit = controlsById.get(id);
    if (!hit) throw new Error(`Plan references control "${id}", which is not in the app models it was compiled against`);
    const d = describeControl(hit.c, hit.model);
    redactions += d.redactions;
    descriptors.set(id, d);
  }
  const keyOf = new Map<string, string>();
  const byBase = new Map<string, string[]>();
  for (const id of order) {
    const b = baseKey(descriptors.get(id)!);
    (byBase.get(b) ?? byBase.set(b, []).get(b)!).push(id);
  }
  for (const [b, ids] of byBase) {
    if (ids.length === 1) {
      keyOf.set(ids[0]!, b);
      continue;
    }
    // Same base key for different controls: qualify by context, then by ordinal.
    const taken = new Set<string>();
    ids.forEach((id, i) => {
      const d = descriptors.get(id)!;
      let k = b;
      for (const q of qualifiers(d)) {
        const cand = `${b}${q}`;
        if (!taken.has(cand) && ids.every((other) => other === id || !qualifiers(descriptors.get(other)!).includes(q))) {
          k = cand;
          break;
        }
      }
      if (k === b || taken.has(k)) k = `${b}~${i + 1}`;
      taken.add(k);
      keyOf.set(id, k);
    });
  }

  const controls: PortableControl[] = order.map((id) => {
    const d = descriptors.get(id)!;
    const pc: PortableControl = { key: keyOf.get(id)!, app: d.app, routeFamily: d.routeFamily, kind: d.kind, role: d.role, name: d.name, strategies: d.strategies };
    if (d.label !== undefined) pc.label = d.label;
    if (d.type !== undefined) pc.type = d.type;
    if (d.param !== undefined) pc.param = d.param;
    if (d.options) pc.options = d.options;
    if (d.headers) pc.headers = d.headers;
    if (d.formSignature) pc.formSignature = d.formSignature;
    if (d.inDialog) pc.inDialog = true;
    if (d.tabPanel !== undefined) pc.tabPanel = d.tabPanel;
    if (d.effect) pc.effect = d.effect;
    if (d.regionFingerprint) pc.regionFingerprint = d.regionFingerprint;
    return pc;
  });

  // ---- procedure with portable keys; free text dropped or scrubbed
  const plan = mapControlRefs(input.plan, (ref) => keyOf.get(ref) ?? ref);
  for (const phase of plan.phases)
    for (const s of phase.steps)
      if (s.note !== undefined) {
        if (s.note.trim()) redactions++;
        delete s.note;
      }
  const scrub = (s: string) => {
    const r = scrubText(s);
    redactions += r.count;
    return r.text;
  };
  plan.strategy = { name: scrub(plan.strategy.name), summary: scrub(plan.strategy.summary), rationale: "" };
  if (input.plan.strategy.rationale.trim()) redactions++;
  if (plan.assumptions.length || plan.risks.length) redactions += plan.assumptions.length + plan.risks.length;
  plan.assumptions = [];
  plan.risks = [];
  plan.outcomes = plan.outcomes.map((o) => ({ id: o.id, description: scrub(o.description) }));

  // ---- pages: every route family the plan touches
  const touched = new Map<string, Set<string>>();
  const touch = (app: string, route: string | null) => {
    if (!route) return;
    (touched.get(app) ?? touched.set(app, new Set()).get(app)!).add(route);
  };
  for (const d of descriptors.values()) touch(d.app, d.routeFamily);
  const gotos = gotoTemplates(input.plan);
  for (const g of gotos) touch(g.app, templateRoute(g.url));
  const templatesByApp = new Map<string, string[]>();
  for (const g of gotos) (templatesByApp.get(g.app) ?? templatesByApp.set(g.app, []).get(g.app)!).push(g.url);
  for (const sc of submitContexts(input.plan)) {
    if (!sc.app) continue;
    touch(sc.app, templateRoute(sc.step.verify.url));
    (templatesByApp.get(sc.app) ?? templatesByApp.set(sc.app, []).get(sc.app)!).push(sc.step.verify.url);
  }
  const tableKeyOf = (app: string) => (pageRoute: string, headers: string[]) => {
    const want = headers.join(" | ");
    for (const [id, k] of keyOf) {
      const d = descriptors.get(id)!;
      if (d.app === app && d.routeFamily === pageRoute && d.kind === "table" && controlsById.get(id)?.c.detail === want) return k;
    }
    return undefined;
  };
  const pages: PortablePage[] = [];
  const applications: PortableApplication[] = [];
  const writesByApp = new Map<string, { write: boolean; irreversible: boolean }>();
  for (const sc of submitContexts(input.plan)) {
    if (!sc.app) continue;
    const w = writesByApp.get(sc.app) ?? { write: false, irreversible: false };
    w.write = true;
    const c = controlsById.get(sc.step.control)?.c;
    if (sc.step.irreversible || c?.effectGuess === "irreversible") w.irreversible = true;
    writesByApp.set(sc.app, w);
  }
  for (const [app, routes] of [...touched].sort(([a], [b]) => a.localeCompare(b))) {
    const model = modelOf.get(app);
    const binding = bindingOf.get(app);
    if (!model || !binding) throw new Error(`Plan touches app "${app}", which has no model or binding`);
    const appPages: PortablePage[] = [];
    for (const route of [...routes].sort()) {
      const p = pageOf(model, route);
      if (!p) {
        warnings.push(`${app} route family ${route} is used by the plan but was never observed; it cannot be rebound`);
        continue;
      }
      const page: PortablePage = {
        app,
        routeFamily: route,
        pathTemplate: pathTemplateFor(route, templatesByApp.get(app) ?? [], input.recordFields),
        pageFingerprint: p.fingerprint,
        regionFingerprints: regionMap(model, p),
        loadMsP50: p.loadMs.p50,
      };
      if (route.includes(":id")) {
        const via = reachViaFor(model, route, tableKeyOf(app));
        if (via) page.reachVia = via;
        else warnings.push(`${app} ${route}: no observed list table or link reaches this page; rebinding needs a record value for its params`);
      }
      const lt = model.features.listTables.find((t) => t.page === route);
      if (lt) page.paginated = lt.paginated;
      appPages.push(page);
    }
    pages.push(...appPages);
    const w = writesByApp.get(app);
    applications.push({
      name: app,
      origin: normalizeOrigin(binding.origin),
      routeFamilies: appPages.map((p) => p.routeFamily),
      interfaceFingerprint: interfaceFingerprint(appPages.map((p) => p.pageFingerprint)),
      roleClass: input.roleClass?.[app] ?? (w?.write ? "writer" : "reader"),
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.featureVariant ? { featureVariant: input.featureVariant } : {}),
    });
  }
  for (const a of input.apps) if (!touched.has(a.name)) warnings.push(`App binding ${a.name} is not used by the plan and is not part of the capability`);

  // ---- requirements and verification
  const permissions: string[] = [];
  for (const a of applications) {
    permissions.push(`${a.name}:read`);
    const w = writesByApp.get(a.name);
    if (w?.write) permissions.push(`${a.name}:write`);
    if (w?.irreversible) permissions.push(`${a.name}:irreversible`);
  }
  const portableSubmits = submitContexts(plan);
  const expectedEffects: PortableCapability["requirements"]["expectedEffects"] = [];
  const rules: PortableCapability["verification"]["rules"] = [];
  for (const sc of portableSubmits) {
    const pc = controls.find((c) => c.key === sc.step.control);
    const effect = sc.step.irreversible || pc?.effect === "irreversible" ? "irreversible" : "remote-write";
    for (const w of sc.step.writes) expectedEffects.push({ effect, resource: w, stepId: sc.step.id });
    rules.push({ stepId: sc.step.id, url: sc.step.verify.url, fields: sc.step.verify.fields.map((f) => ({ name: f.name, control: f.control, equals: f.equals })) });
  }

  const opSig = canonicalOperation(input.goal, input.recordFields);
  const firstLine = input.goal.split("\n").find((l) => l.trim()) ?? "";
  const description = scrubText(normalizeGoal(firstLine)).text.slice(0, 200);
  const origins = applications.map((a) => a.origin);
  const draft: PortableCapability = {
    schemaVersion: CAPABILITY_SCHEMA_VERSION,
    capabilityId: input.capabilityId ?? `cap_${shortHash(`${opSig}|${applications.map((a) => `${a.name}@${a.origin}`).join(",")}`, 24)}`,
    version: input.version ?? 1,
    publisherId: input.publisherId ?? "unassigned",
    applications,
    intent: { canonicalOperation: opSig, description, inputSchema: { recordFields: [...input.recordFields] } },
    procedure: { format: "overclock-procedure-dsl", compilerVersion: input.compilerVersion, plan },
    controls,
    pages,
    requirements: { permissions, allowedOrigins: origins, expectedEffects },
    verification: { rules },
    provenance: {
      artifactHash: "",
      createdAt: input.createdAt ?? Date.now(),
      verifiedReceipts: input.verifiedReceipts,
      ...(input.parentVersion !== undefined ? { parentVersion: input.parentVersion } : {}),
    },
  };
  const hashed = withArtifactHash(draft);
  const s = sanitizeCapability(hashed, { records: input.records });
  if (!s.ok) throw new CapabilityRejectedError(s.rejected);
  return { capability: s.capability, report: { redactions: redactions + s.redactions, warnings, findings: s.findings } };
}

export function interfaceFingerprint(pageFingerprints: string[]): string {
  return shortHash([...pageFingerprints].sort().join("|"), 16);
}
