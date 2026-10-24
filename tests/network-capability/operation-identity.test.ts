import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunConfigSchema, type EventPayload } from "@overclock/contracts";
import type { CapabilityCandidate, INetworkClient, PortableCapability } from "@overclock/network-contracts";
import { analyzeCapability, canonicalOperation, normalizeGoal, sha256, withArtifactHash } from "../../packages/network-capability/src/index";
import { importCapability } from "../../services/engine/src/network";
import { exportFixture, GOAL, overTheWire, setupEnv, type Env } from "./fixtures";

/**
 * A capability may run only for the operation it was learned for. These tests drive the engine's
 * import path against a real arena with a fake registry client, including a registry that returns
 * the wrong artifact, and check that a conflicting request never gets an executable plan.
 */

let env: Env;
let cap: PortableCapability;

beforeAll(async () => {
  env = await setupEnv();
  cap = exportFixture(env).capability;
}, 120_000);
afterAll(async () => {
  await env?.close();
});

function candidate(c: PortableCapability, claimedOperation = c.intent.canonicalOperation): CapabilityCandidate {
  return { capabilityId: c.capabilityId, versionId: `${c.capabilityId}@${c.version}`, version: c.version, canonicalOperation: claimedOperation, origins: c.applications.map((a) => a.origin), interfaceFingerprints: [], state: "ACTIVE", contentHash: c.provenance.artifactHash, bytes: 1000, publisherId: c.publisherId, validations: 1, successfulReuses: 0, updatedAt: 0 };
}

/** A registry client that returns `candidates` for any lookup and `artifact` for any fetch. */
function registry(candidates: CapabilityCandidate[], artifact: PortableCapability) {
  const calls = { lookups: 0, fetches: 0 };
  const client = {
    config: { lookupTimeoutMs: 1000 },
    identity: "c0ffee0000000000",
    async lookup() {
      calls.lookups++;
      return { candidates, source: "local-cache" as const, ms: 1 };
    },
    async fetchArtifact() {
      calls.fetches++;
      return { capability: overTheWire(artifact), source: "local-cache" as const, ms: 1 };
    },
  };
  // The import path uses only lookup and fetchArtifact; a full client needs a SpacetimeDB connection.
  return { client: client as unknown as INetworkClient, calls };
}

async function importFor(goal: string, client: INetworkClient, records = env.records) {
  const events: EventPayload[] = [];
  const config = RunConfigSchema.parse({ goal, applications: env.apps, records, mode: "overclock" });
  const imported = await importCapability({ client, config, browser: env.browser, storageState: env.operator, signal: new AbortController().signal, emit: (e) => events.push(e) });
  return { imported, events, refused: events.flatMap((e) => (e.type === "network.import" ? (e.refused ?? []) : [])) };
}

const conflicting = [
  ["a different target literal", GOAL.replace("Checked by Overclock", "Rejected by Overclock")],
  ["a different numeric threshold", `${GOAL}\nOnly orders over 100 dollars.`, `${GOAL}\nOnly orders over 200 dollars.`],
  ["a different condition", GOAL.replace("look up its support ticket and mark", "look up its support ticket and, if it is open, mark")],
] as const;

describe("capability reuse requires the same operation", () => {
  it("imports and rebinds the capability for the same instructions over different records (legitimate reuse)", async () => {
    const { client } = registry([candidate(cap)], cap);
    const reversed = [...env.records].reverse();
    const { imported, refused } = await importFor(GOAL, client, reversed);
    expect(refused).toEqual([]);
    expect(imported?.outcome).toBe("EXACT_COMPATIBLE");
  }, 60_000);

  for (const [what, a, b] of conflicting) {
    it(`never imports a capability for a request with ${what}`, async () => {
      // The registry offers a capability learned for instructions A to a runtime asking for B.
      const learned = b === undefined ? cap : exportFixture(env, { goal: a }).capability;
      const request = b ?? a;
      expect(canonicalOperation(request, ["orderId"])).not.toBe(learned.intent.canonicalOperation);
      const { client, calls } = registry([candidate(learned)], learned);
      const { imported } = await importFor(request, client);
      expect(imported).toBeNull();
      expect(calls.fetches).toBe(0); // no candidate for this operation: nothing fetched, nothing rebound
    }, 60_000);
  }

  it("refuses an artifact whose operation differs from what the registry claimed", async () => {
    const request = GOAL.replace("Checked by Overclock", "Rejected by Overclock");
    // A buggy or hostile registry labels the "Checked" capability with the requester's operation.
    const { client, calls } = registry([candidate(cap, canonicalOperation(request, ["orderId"]))], cap);
    const { imported, refused } = await importFor(request, client);
    expect(imported).toBeNull();
    expect(calls.fetches).toBe(1);
    expect(refused.join(" ")).toMatch(/different operation/);
  }, 60_000);

  it("rejects a capability published under the superseded lossy identity, even for its own instructions", async () => {
    const lossy = sha256(`${normalizeGoal(GOAL)}\n${["orderId"].join(",")}`);
    const legacy = withArtifactHash({ ...cap, intent: { ...cap.intent, canonicalOperation: lossy } });
    expect(analyzeCapability(legacy).issues.some((i) => i.severity === "error" && i.code === "operation-identity")).toBe(true);
    // Offered under its old identity, it never matches; relabelled with the new one, its artifact doesn't.
    const old = registry([candidate(legacy)], legacy);
    expect((await importFor(GOAL, old.client)).imported).toBeNull();
    const relabelled = registry([candidate(legacy, canonicalOperation(GOAL, ["orderId"]))], legacy);
    const r = await importFor(GOAL, relabelled.client);
    expect(r.imported).toBeNull();
    expect(r.refused.join(" ")).toMatch(/different operation/);
  }, 60_000);
});
