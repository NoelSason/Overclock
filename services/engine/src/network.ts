import { join } from "node:path";
import type { AppModel, DslPlan, EventPayload, RunConfig } from "@overclock/contracts";
import type { BrowserManager, StorageState } from "@overclock/browser-runtime";
import type { CompatibilityOutcome, INetworkClient, NetworkConfig } from "@overclock/network-contracts";
import { NetworkClient, networkConfigFromEnv } from "@overclock/network-client";
import { addReadGuards, inheritSubmitConditions } from "@overclock/compiler";
import { analyzeCapability, canonicalOperation, exportCapability, rebindCapability } from "@overclock/network-capability";

/** Outcomes a runtime may execute after rebinding; anything else falls back to cold discovery. */
const EXECUTABLE: readonly CompatibilityOutcome[] = ["EXACT_COMPATIBLE", "STRUCTURALLY_COMPATIBLE", "REQUIRES_REBINDING"];
export const COMPILER_VERSION = "overclock-compiler/0.1";
const CONNECT_TIMEOUT_MS = 8_000;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function recordFieldsOf(records: Record<string, unknown>[]): string[] {
  return [...new Set(records.flatMap((r) => Object.keys(r)))].sort();
}

/**
 * One Overclock Network client per engine process, connected on first use. Browser workers never
 * talk to the network; only the run controller does, before discovery and after verification.
 */
export class NetworkService {
  private pending: Promise<INetworkClient | null> | null = null;
  private lastError: string | null = null;
  readonly config: NetworkConfig;

  constructor(dataDir: string, runtimeLabel: string) {
    this.config = { ...networkConfigFromEnv(join(dataDir, "network")), runtimeLabel };
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Why the last connection attempt failed, if it did. */
  get error(): string | null {
    return this.lastError;
  }

  /** The connected client, or null when the network is disabled or unreachable (retried on the next call). */
  async client(): Promise<INetworkClient | null> {
    if (!this.config.enabled) return null;
    this.pending ??= this.connect().catch((err: unknown) => {
      this.lastError = message(err);
      this.pending = null;
      return null;
    });
    return this.pending;
  }

  private async connect(): Promise<INetworkClient> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`no connection to ${this.config.endpoint} within ${CONNECT_TIMEOUT_MS} ms`)), CONNECT_TIMEOUT_MS)));
    try {
      const c = await Promise.race([NetworkClient.connect(this.config), timeout]);
      // Every runtime registers (pending until an admin authorizes it); reuse reports need an authorized role too.
      if (!c.myPublisher()) await c.registerPublisher(this.config.runtimeLabel, "publisher").catch(() => undefined);
      this.lastError = null;
      return c;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    const c = await this.pending;
    this.pending = null;
    await c?.close();
  }
}

export interface ImportedCapability {
  plan: DslPlan;
  models: AppModel[];
  capabilityId: string;
  versionId: string;
  version: number;
  outcome: CompatibilityOutcome;
  /** Some write's submit button bound structurally: writes must pass a write canary first. */
  writeCanary: boolean;
}

interface Emitter {
  emit(e: EventPayload): void;
}

/**
 * network-read: look up an ACTIVE capability for this task, fetch and hash-verify it, rebind it
 * against this runtime's own mutation-blocked observation, and return the rebound plan when it
 * compiled and every write bound safely. Returns null (cold discovery follows) otherwise.
 */
export async function importCapability(o: Emitter & { client: INetworkClient; config: RunConfig; browser: BrowserManager; storageState: StorageState | undefined; signal: AbortSignal }): Promise<ImportedCapability | null> {
  const origins = o.config.applications.map((a) => new URL(a.origin).origin);
  const op = canonicalOperation(o.config.goal, recordFieldsOf(o.config.records));
  const look = await o.client.lookup({ origins, canonicalOperation: op, signatures: [] });
  // Only a capability for exactly this operation may run here. Lookup ranks by operation, but a
  // registry may also return interface-only matches, so the identity is checked, not assumed.
  const best = look.candidates.find((c) => c.canonicalOperation === op);
  o.emit({ type: "network.lookup", origins, outcome: best ? "FOUND" : "NO_CAPABILITY", source: look.source, candidates: look.candidates.length, ms: Math.round(look.ms), ...(best ? { capabilityId: best.capabilityId, version: best.version } : {}), ...(o.client.identity ? { identity: o.client.identity.slice(0, 16) } : {}) });
  if (!best) return null;

  let fetched: Awaited<ReturnType<INetworkClient["fetchArtifact"]>>;
  try {
    fetched = await o.client.fetchArtifact(best.versionId);
  } catch (err) {
    o.emit({ type: "log", level: "warn", message: `network: could not fetch ${best.versionId} (${message(err)}); discovering cold` });
    return null;
  }
  // Defense in depth: the registry and the validator are not trusted blindly either. The fetched
  // artifact must carry this task's exact operation identity (checked again after the hash check
  // the client ran), and pass static analysis, which also rejects superseded lossy identities.
  if (fetched.capability.intent.canonicalOperation !== op) {
    o.emit({ type: "network.import", capabilityId: best.capabilityId, version: best.version, outcome: "INCOMPATIBLE", bound: 0, unbound: 0, rebindMs: 0, fetchMs: Math.round(fetched.ms), source: fetched.source, refused: ["the capability was written for a different operation (its exact instructions or record fields differ from this task's)"] });
    o.emit({ type: "log", level: "warn", message: `network: ${best.versionId} is for a different operation; not reusing it, discovering cold` });
    return null;
  }
  const analysis = analyzeCapability(fetched.capability);
  if (!analysis.ok) {
    const errs = analysis.issues.filter((i) => i.severity === "error").slice(0, 3).map((i) => i.message);
    o.emit({ type: "network.import", capabilityId: best.capabilityId, version: best.version, outcome: "INCOMPATIBLE", bound: 0, unbound: 0, rebindMs: 0, fetchMs: Math.round(fetched.ms), source: fetched.source, refused: errs });
    o.emit({ type: "log", level: "warn", message: `network: ${best.versionId} failed static analysis here (${errs.join("; ")}); discovering cold` });
    return null;
  }
  const r = await rebindCapability({ capability: fetched.capability, apps: o.config.applications, browser: o.browser, storageState: o.storageState, signal: o.signal, records: o.config.records });
  const errors = r.issues.filter((i) => i.severity === "error");
  const executable = EXECUTABLE.includes(r.report.outcome) && r.report.writesSafe && r.program !== null && errors.length === 0;
  const outcome: CompatibilityOutcome = executable ? r.report.outcome : EXECUTABLE.includes(r.report.outcome) ? "REQUIRES_REPAIR" : r.report.outcome;
  const refused = executable
    ? []
    : [
        ...r.report.unbound.slice(0, 3).map((u) => `unbound ${u.key} (${u.reason})`),
        ...r.report.ambiguous.slice(0, 3).map((k) => `ambiguous ${k}`),
        ...r.details.flags.slice(0, 3),
        ...(r.report.writesSafe ? [] : ["writes not provably safe"]),
        ...errors.slice(0, 2).map((e) => e.message),
      ];
  const writeCanary = executable && r.report.writeCanary === true;
  o.emit({ type: "network.import", capabilityId: best.capabilityId, version: best.version, outcome, bound: r.report.bound, unbound: r.report.unbound.length, rebindMs: Math.round(r.report.ms), fetchMs: Math.round(fetched.ms), source: fetched.source, publisher: fetched.capability.publisherId, writeCanary, relabeled: r.details.relabeled, ...(refused.length ? { refused } : {}) });
  if (!executable) {
    o.emit({ type: "log", level: "warn", message: `network: ${best.versionId} is ${outcome} here (${refused.join("; ") || "no executable program"}); discovering cold` });
    return null;
  }
  if (r.details.relabeled.length) o.emit({ type: "log", level: "info", message: `network: the interface changed since publication; rebound ${r.details.relabeled.map((x) => `"${x.from}" -> "${x.to}" (${x.evidence})`).join(", ")}${writeCanary ? "; writes run behind a write canary" : ""}` });
  return { plan: r.plan, models: r.models, capabilityId: best.capabilityId, versionId: best.versionId, version: best.version, outcome, writeCanary };
}

/**
 * network-read-and-contribute: export the verified plan as a sanitized portable capability and
 * propose it. The server takes it through validation by an independent validator before any
 * other runtime can see it as ACTIVE.
 */
export async function publishCapability(o: Emitter & { client: INetworkClient; config: RunConfig; plan: DslPlan; models: AppModel[]; verifiedReceipts: number }): Promise<void> {
  const t0 = performance.now();
  const rejected = (capabilityId: string, version: number, reason: string, redactions = 0) =>
    o.emit({ type: "network.publish", capabilityId, version, state: "REJECTED", ms: Math.round(performance.now() - t0), redactions, bytes: 0, rejected: reason.slice(0, 300) });
  if (!o.client.config.publishEnabled) return rejected("-", 0, "publishing is disabled for this runtime (OVERCLOCK_NETWORK_PUBLISH_ENABLED=false)");
  // The artifact hash covers publisherId, and the client sends its own identity, so export with it.
  const publisherId = o.client.identity ?? undefined;
  // Publish what was executed: lowering added the same compare-and-swap guards to the run's program.
  const base = { plan: addReadGuards(inheritSubmitConditions(o.plan)).plan, models: o.models, apps: o.config.applications, goal: o.config.goal, recordFields: recordFieldsOf(o.config.records), verifiedReceipts: o.verifiedReceipts, compilerVersion: COMPILER_VERSION, records: o.config.records, publisherId };
  let exported: ReturnType<typeof exportCapability>;
  try {
    exported = exportCapability(base);
    // The capability id is derived from the operation and apps; take the first unused version number.
    let version = 1;
    while (o.client.versionInfo(`${exported.capability.capabilityId}@${version}`)) version++;
    if (version !== exported.capability.version) exported = exportCapability({ ...base, version });
  } catch (err) {
    return rejected("-", 0, `export refused: ${message(err)}`);
  }
  const cap = exported.capability;
  // The validator runs this same static analysis first; refusing here keeps a capability that
  // would fail it off the network, and records why in this run.
  const analysis = analyzeCapability(cap);
  if (!analysis.ok) return rejected(cap.capabilityId, cap.version, `static analysis: ${analysis.issues.filter((i) => i.severity === "error").slice(0, 3).map((i) => i.message).join("; ")}`, exported.report.redactions);
  try {
    for (const a of cap.applications) await o.client.registerApplication(a.origin, a.routeFamilies);
    const res = await o.client.proposeCapability(cap);
    o.emit({ type: "network.publish", capabilityId: cap.capabilityId, version: cap.version, state: res.state, ms: Math.round(performance.now() - t0), redactions: exported.report.redactions, bytes: Buffer.byteLength(JSON.stringify(cap)) });
  } catch (err) {
    rejected(cap.capabilityId, cap.version, message(err), exported.report.redactions);
  }
}
