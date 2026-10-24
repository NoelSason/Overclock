import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_CAPABILITY_BYTES, type CapabilityChange } from "@overclock/network-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CapabilityTooLargeError, NetworkRejectedError, sha256Hex, type NetworkClient } from "../../packages/network-client/src/index";
import {
  adminClient,
  authorizedClient,
  client,
  failValidation,
  passValidation,
  proposeVerified,
  rawConnection,
  recordMetrics,
  sampleCapability,
  summarize,
  testOrigin,
  uid,
  waitFor,
} from "./helpers";

/**
 * Registry: publish -> validate -> promote -> propagate, authorization, payload checks,
 * promotion rules, quarantine, and concurrent subscribers. Real SpacetimeDB, separate identities.
 */

let admin: NetworkClient;
let publisher: NetworkClient;
let validator: NetworkClient;
let reader: NetworkClient;
const origin = testOrigin();
const metrics = { propagationServerMs: [] as number[], propagationE2eMs: [] as number[], lookupMs: [] as number[], fetchNetworkMs: [] as number[], fetchLocalMs: [] as number[] };

beforeAll(async () => {
  admin = await adminClient();
  publisher = await authorizedClient(admin, "publisher-a", "publisher");
  validator = await authorizedClient(admin, "validator-v", "validator");
  reader = await client("reader-b", { publishEnabled: false });
  await publisher.registerApplication(origin, ["/orders/:id"]);
  await reader.watchOrigins([origin]);
});

afterAll(async () => {
  recordMetrics("registry", {
    propagationServerMs: summarize(metrics.propagationServerMs),
    propagationE2eMs: summarize(metrics.propagationE2eMs),
    lookupMs: summarize(metrics.lookupMs),
    fetchNetworkMs: summarize(metrics.fetchNetworkMs),
    fetchLocalMs: summarize(metrics.fetchLocalMs),
  });
  await Promise.all([admin, publisher, validator, reader].map((c) => c?.close()));
});

function nextChange(c: NetworkClient, pred: (ch: CapabilityChange) => boolean, timeoutMs = 10_000): Promise<CapabilityChange> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("no matching capability change"));
    }, timeoutMs);
    const off = c.onCapabilityChange((ch) => {
      if (!pred(ch)) return;
      clearTimeout(timer);
      off();
      resolve(ch);
    });
  });
}

describe("publish, validate, promote, propagate", () => {
  it("B receives the promoted version live, then fetches and verifies the artifact", async () => {
    const capabilityId = `orders-review-${uid()}`;
    const { versionId, state } = await publisher.proposeCapability(sampleCapability({ capabilityId, version: 1, origin }));
    expect(state).toBe("PROPOSED");
    await validator.recordValidation(passValidation(versionId));

    const promoted = nextChange(reader, (ch) => ch.versionId === versionId && ch.state === "ACTIVE");
    const sentAt = performance.timeOrigin + performance.now();
    const result = await admin.promote(versionId);
    expect(result.state).toBe("ACTIVE");
    const change = await promoted;
    expect(change.previousState).toBe("CANARY");
    expect(change.receivedAt).toBeGreaterThanOrEqual(change.committedAt - 5);
    metrics.propagationServerMs.push(change.receivedAt - change.committedAt);
    metrics.propagationE2eMs.push(change.receivedAt - sentAt);

    expect(reader.activeVersion(capabilityId)?.versionId).toBe(versionId);
    for (let i = 0; i < 200; i++) {
      const r = await reader.lookup({ origins: [origin], canonicalOperation: `op:${capabilityId}`, signatures: [] });
      expect(r.source).toBe("local-cache");
      expect(r.candidates[0]?.versionId).toBe(versionId);
      metrics.lookupMs.push(r.ms);
    }
    const byFingerprint = await reader.lookup({
      origins: [origin],
      signatures: [{ origin, routeFamily: "/orders/:id", pageFingerprint: `pfp-${capabilityId}`, regionFingerprints: {} }],
    });
    expect(byFingerprint.candidates.map((c) => c.versionId)).toContain(versionId);

    const candidate = reader.activeVersion(capabilityId)!;
    const fetched = await reader.fetchArtifact(versionId);
    expect(fetched.source).toBe("network");
    expect(fetched.capability.publisherId).toBe(publisher.identity);
    expect(fetched.capability.capabilityId).toBe(capabilityId);
    metrics.fetchNetworkMs.push(fetched.ms);
    const cached = readFileSync(join(reader.config.dataDir, "capabilities", `${candidate.contentHash}.json`), "utf8");
    expect(sha256Hex(cached)).toBe(candidate.contentHash);

    for (let i = 0; i < 20; i++) {
      const again = await reader.fetchArtifact(versionId);
      expect(again.source).toBe("local-cache");
      metrics.fetchLocalMs.push(again.ms);
    }
    const stats = reader.stats();
    expect(stats.localHits).toBeGreaterThanOrEqual(200);
    expect(stats.fetchMs.count).toBe(21);
  });
});

describe("authorization and identity", () => {
  it("rejects proposals from pending and unregistered identities", async () => {
    const pending = await client("pending-p");
    await pending.registerPublisher("pending-p", "publisher");
    expect(pending.myPublisher()?.status).toBe("pending");
    await expect(pending.proposeCapability(sampleCapability({ capabilityId: `x-${uid()}`, version: 1, origin }))).rejects.toThrow(/not authorized.*pending/);
    const stranger = await client("stranger");
    await expect(stranger.proposeCapability(sampleCapability({ capabilityId: `x-${uid()}`, version: 1, origin }))).rejects.toThrow(/not registered/);
    // A pending publisher cannot authorize itself either.
    await expect(pending.authorizePublisher(pending.identity!, "admin")).rejects.toThrow(/not authorized/);
    await Promise.all([pending.close(), stranger.close()]);
  });

  it("never lets a client spoof the publisher id", async () => {
    // Through the client: the field is overwritten with the authenticated identity.
    const capabilityId = `spoof-${uid()}`;
    const { versionId } = await publisher.proposeCapability(sampleCapability({ capabilityId, version: 1, origin, publisherId: validator.identity! }));
    await waitFor(() => reader.versionInfo(versionId) !== null, 5000, "version row");
    expect(reader.versionInfo(versionId)?.publisherId).toBe(publisher.identity);

    // Raw reducer call with someone else's id: rejected by the module.
    const raw = await rawConnection(publisher.config.dataDir);
    const forged = JSON.stringify(sampleCapability({ capabilityId: `spoof-${uid()}`, version: 1, origin, publisherId: validator.identity! }));
    await expect(raw.reducers.proposeCapability({ payload: forged, contentHash: sha256Hex(forged), byteSize: Buffer.byteLength(forged) })).rejects.toThrow(
      /publisherId must be the authenticated identity/,
    );
    raw.disconnect();
  });
});

describe("payload checks in the reducer", () => {
  it("rejects oversize payloads (client-side and in the reducer)", async () => {
    const big = sampleCapability({ capabilityId: `big-${uid()}`, version: 1, origin, description: "x".repeat(MAX_CAPABILITY_BYTES + 1024) });
    await expect(publisher.proposeCapability(big)).rejects.toBeInstanceOf(CapabilityTooLargeError);
    const raw = await rawConnection(publisher.config.dataDir);
    const payload = JSON.stringify({ ...big, publisherId: publisher.identity });
    await expect(raw.reducers.proposeCapability({ payload, contentHash: sha256Hex(payload), byteSize: Buffer.byteLength(payload) })).rejects.toThrow(/limit is 262144/);
    raw.disconnect();
  });

  it("processes near-limit payloads in bounded time (no super-linear scans)", async () => {
    // Long runs of word characters, dots, and "cookie:" prefixes used to drive unbounded
    // patterns quadratic; the reducer must stay fast right up to the size limit.
    const description = `${"a.".repeat(60_000)}${" cookie:x".repeat(8_000)}`;
    const cap = sampleCapability({ capabilityId: `near-limit-${uid()}`, version: 1, origin, description });
    const t0 = performance.now();
    await publisher.proposeCapability(cap);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("rejects hash and size mismatches", async () => {
    const raw = await rawConnection(publisher.config.dataDir);
    const payload = JSON.stringify({ ...sampleCapability({ capabilityId: `h-${uid()}`, version: 1, origin }), publisherId: publisher.identity });
    await expect(raw.reducers.proposeCapability({ payload, contentHash: sha256Hex(`${payload} `), byteSize: Buffer.byteLength(payload) })).rejects.toThrow(/contentHash/);
    await expect(raw.reducers.proposeCapability({ payload, contentHash: sha256Hex(payload), byteSize: 7 })).rejects.toThrow(/byteSize/);
    raw.disconnect();
  });

  it("rejects other-origin URLs, unregistered origins, script URLs, and secrets", async () => {
    const cases: Array<[string, Parameters<typeof sampleCapability>[0], RegExp]> = [
      ["absolute URL to another origin", { capabilityId: `o-${uid()}`, version: 1, origin, gotoUrl: "https://evil.example/collect?o={$rec.orderId}" }, /goto step .* url|outside the allowed origins/],
      ["unregistered application origin", { capabilityId: `o-${uid()}`, version: 1, origin: testOrigin() }, /is not registered/],
      ["javascript: URL", { capabilityId: `o-${uid()}`, version: 1, origin, gotoUrl: "javascript:alert(1)" }, /script URL|must be a path/],
      ["bearer token", { capabilityId: `o-${uid()}`, version: 1, origin, description: "call with Authorization: Bearer abcdefghijklmnopqrstuvwxyz" }, /credential or secret/],
      ["sk- key", { capabilityId: `o-${uid()}`, version: 1, origin, description: "use key sk-ant-REDACTEDREDACTED1234" }, /credential or secret/],
      ["password=", { capabilityId: `o-${uid()}`, version: 1, origin, description: "login with password=hunter2" }, /credential or secret/],
      ["cookie", { capabilityId: `o-${uid()}`, version: 1, origin, description: "send Cookie: session=abcdef0123456789" }, /credential or secret/],
    ];
    for (const [name, spec, re] of cases) {
      const err = await publisher.proposeCapability(sampleCapability(spec)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err, name).toBeInstanceOf(NetworkRejectedError);
      expect((err as Error).message, name).toMatch(re);
    }
  });
});

describe("promotion rules", () => {
  it("fails without an independent validation", async () => {
    const capabilityId = `indep-${uid()}`;
    // (a) No validation at all.
    const v1 = (await publisher.proposeCapability(sampleCapability({ capabilityId, version: 1, origin }))).versionId;
    await expect(admin.promote(v1)).rejects.toThrow(/only VERIFIED or CANARY/);

    // (b) Self-validation by the publisher (the admin publishes and validates its own version).
    const v2 = (await admin.proposeCapability(sampleCapability({ capabilityId, version: 2, origin }))).versionId;
    await admin.recordValidation(passValidation(v2));
    await expect(admin.promote(v2)).rejects.toThrow(/only VERIFIED or CANARY versions can be promoted \(state is VALIDATING\)/);

    // (c) Verified by a validator who is then suspended: the pass no longer counts.
    const v3validator = await authorizedClient(admin, "validator-temp", "validator");
    const v3 = (await publisher.proposeCapability(sampleCapability({ capabilityId, version: 3, origin }))).versionId;
    await v3validator.recordValidation(passValidation(v3));
    await admin.suspendPublisher(v3validator.identity!);
    await expect(admin.promote(v3)).rejects.toThrow(/passing validation from an authorized validator other than the publisher/);

    // (d) A later independent fail cancels an earlier pass.
    const v4 = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 4, origin }));
    await validator.recordValidation(failValidation(v4));
    await expect(admin.promote(v4)).rejects.toThrow(/passing validation/);
    await v3validator.close();
  });

  it("fails for out-of-order and stale promotions", async () => {
    const capabilityId = `order-${uid()}`;
    const v1 = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 1, origin }));
    const v2 = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 2, origin }));
    await admin.promote(v2);
    await expect(admin.promote(v1)).rejects.toThrow(/out-of-order promotion: v1 is not newer than active v2/);

    const v3 = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 3, origin }));
    await expect(admin.promote(v3, { expectedSelectionVersion: 0 })).rejects.toThrow(/stale promotion: selection version is 1, expected 0/);
    await expect(admin.promote(v3, { expectedSelectionVersion: 1 })).resolves.toEqual({ state: "ACTIVE" });
  });
});

describe("quarantine", () => {
  it("removes the version from active selection and falls back to the previous known-good one", async () => {
    const capabilityId = `quar-${uid()}`;
    const v1 = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 1, origin }));
    await admin.promote(v1);
    const v2 = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 2, origin }));
    const active2 = nextChange(reader, (ch) => ch.versionId === v2 && ch.state === "ACTIVE");
    await admin.promote(v2);
    await active2;
    const query = { origins: [origin], canonicalOperation: `op:${capabilityId}`, signatures: [] };
    expect((await reader.lookup(query)).candidates[0]?.versionId).toBe(v2);

    const quarantined = nextChange(reader, (ch) => ch.versionId === v2 && ch.state === "QUARANTINED");
    await validator.quarantine(v2, "verification mismatch on 3 runtimes");
    expect((await quarantined).previousState).toBe("ACTIVE");
    await waitFor(() => reader.activeVersion(capabilityId)?.versionId === v1, 5000, "fallback to v1");
    const after = await reader.lookup(query);
    expect(after.candidates.map((c) => c.versionId)).toEqual([v1]);

    await validator.quarantine(v1, "also broken");
    await waitFor(() => reader.activeVersion(capabilityId) === null, 5000, "no active version");
    const none = await reader.lookup(query);
    expect(none.candidates).toEqual([]);
    expect((await reader.lookup(query)).source).toBe("negative-cache");

    // A quarantined version is not promotable until an independent re-validation verifies it.
    await expect(admin.promote(v2)).rejects.toThrow(/only VERIFIED or CANARY/);
    await validator.recordValidation(passValidation(v2));
    await expect(admin.promote(v2)).resolves.toEqual({ state: "ACTIVE" });
    await waitFor(() => reader.activeVersion(capabilityId)?.versionId === v2, 5000, "re-promoted v2");
  });
});

describe("concurrent subscribers", () => {
  it("all observe the same promoted version", async () => {
    const capabilityId = `fanout-${uid()}`;
    const subscribers = await Promise.all([1, 2, 3, 4].map((i) => client(`sub-${i}`, { publishEnabled: false })));
    await Promise.all(subscribers.map((s) => s.watchOrigins([origin])));
    const versionId = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 1, origin }));
    const changes = subscribers.map((s) => nextChange(s, (ch) => ch.versionId === versionId && ch.state === "ACTIVE"));
    const sentAt = performance.timeOrigin + performance.now();
    await admin.promote(versionId);
    const seen = await Promise.all(changes);
    for (const ch of seen) {
      metrics.propagationServerMs.push(ch.receivedAt - ch.committedAt);
      metrics.propagationE2eMs.push(ch.receivedAt - sentAt);
    }
    expect(new Set(seen.map((c) => c.versionId))).toEqual(new Set([versionId]));
    expect(new Set(seen.map((c) => c.committedAt)).size).toBe(1);
    expect(subscribers.map((s) => s.activeVersion(capabilityId)?.versionId)).toEqual([versionId, versionId, versionId, versionId]);
    await Promise.all(subscribers.map((s) => s.close()));
  });
});

describe("lookup sources and artifact cache", () => {
  it("auto-watches unknown origins, dedupes in-flight lookups, and bounds them by lookupTimeoutMs", async () => {
    const capabilityId = `src-${uid()}`;
    const versionId = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 1, origin }));
    await admin.promote(versionId);
    const query = { origins: [origin], canonicalOperation: `op:${capabilityId}`, signatures: [] };

    const fresh = await client("lookup-fresh", { publishEnabled: false });
    const [a, b] = await Promise.all([fresh.lookup(query), fresh.lookup(query)]);
    expect(a).toBe(b); // one in-flight lookup served both callers
    expect(a.source).toBe("network");
    expect(a.candidates[0]?.versionId).toBe(versionId);
    expect((await fresh.lookup(query)).source).toBe("local-cache");
    expect(fresh.stats()).toMatchObject({ lookups: 3, networkHits: 1, localHits: 1 });

    const impatient = await client("lookup-timeout", { publishEnabled: false, lookupTimeoutMs: 1 });
    const t = await impatient.lookup({ origins: [testOrigin()], signatures: [] });
    expect(t.source).toBe("timeout");
    expect(t.ms).toBeLessThan(50);
    await Promise.all([fresh.close(), impatient.close()]);
  });

  it("drops a corrupted cache entry and re-fetches from the network", async () => {
    const capabilityId = `cache-${uid()}`;
    const versionId = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 1, origin }));
    await admin.promote(versionId);
    await waitFor(() => reader.activeVersion(capabilityId) !== null, 5000, "active version");
    const first = await reader.fetchArtifact(versionId);
    expect(first.source).toBe("network");
    const hash = reader.activeVersion(capabilityId)!.contentHash;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(reader.config.dataDir, "capabilities", `${hash}.json`), '{"tampered":true}');
    const again = await reader.fetchArtifact(versionId);
    expect(again.source).toBe("network");
    expect(sha256Hex(readFileSync(join(reader.config.dataDir, "capabilities", `${hash}.json`), "utf8"))).toBe(hash);
    await expect(reader.fetchArtifact(`missing-${uid()}@1`)).rejects.toThrow(/does not exist/);
  });

  it("counts verified reuses per version", async () => {
    const capabilityId = `reuse-${uid()}`;
    const versionId = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 1, origin }));
    await admin.promote(versionId);
    await publisher.reportReuse(versionId, true);
    await validator.reportReuse(versionId, true);
    await publisher.reportReuse(versionId, false);
    await waitFor(() => reader.activeVersion(capabilityId)?.successfulReuses === 2, 5000, "reuse counters");
  });
});

describe("activity feed and admin rollbacks", () => {
  it("writes sanitized activity rows", async () => {
    const capabilityId = `act-${uid()}`;
    const versionId = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 1, origin }));
    const seen: string[] = [];
    const off = reader.onActivity((a) => {
      if (a.capabilityId === capabilityId) seen.push(`${a.kind}|${a.actor}|${a.detail}`);
    });
    await validator.quarantine(versionId, "mail ops@example.com, see https://evil.example/path?session=0123456789abcdef");
    await waitFor(() => seen.some((s) => s.startsWith("capability.quarantined")), 5000, "quarantine activity");
    off();
    const line = seen.find((s) => s.startsWith("capability.quarantined"))!;
    expect(line).toContain("validator-v");
    expect(line).toContain("[email]");
    expect(line).toContain("evil.example");
    expect(line).not.toMatch(/ops@example\.com|path\?|0123456789abcdef/);
  });

  it("restores the previous version and treats REVOKED as terminal", async () => {
    const capabilityId = `restore-${uid()}`;
    const v1 = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 1, origin }));
    await admin.promote(v1);
    const v2 = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 2, origin }));
    await admin.promote(v2);
    await expect(validator.restorePreviousVersion(capabilityId, "regression")).rejects.toThrow(/not authorized/);
    await admin.restorePreviousVersion(capabilityId, "regression in checkout");
    await waitFor(() => reader.activeVersion(capabilityId)?.versionId === v1, 5000, "restored v1");
    await waitFor(() => reader.versionInfo(v2)?.state === "QUARANTINED", 5000, "v2 quarantined");
    await expect(admin.restorePreviousVersion(capabilityId, "again")).rejects.toThrow(/no previous known-good version/);

    await admin.revoke(v2, "superseded");
    await waitFor(() => reader.versionInfo(v2)?.state === "REVOKED", 5000, "v2 revoked");
    await expect(validator.recordValidation(passValidation(v2))).rejects.toThrow(/version is revoked/);
    await expect(validator.quarantine(v2, "x")).rejects.toThrow(/illegal publication transition REVOKED -> QUARANTINED/);
    await expect(admin.promote(v2)).rejects.toThrow(/only VERIFIED or CANARY/);
  });
});
