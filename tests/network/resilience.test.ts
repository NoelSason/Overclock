import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NetworkClient, NetworkUnavailableError } from "../../packages/network-client/src/index";
import { TcpProxy, adminClient, authorizedClient, configFor, env, proposeVerified, recordMetrics, sampleCapability, testOrigin, uid, waitFor } from "./helpers";

/**
 * Network loss: a client behind a TCP proxy loses its connection, keeps answering from its cache
 * without throwing into callers that don't need the network, flips isConnected, reconnects, and
 * catches up on changes committed while it was offline.
 */

let admin: NetworkClient;
let publisher: NetworkClient;
let validator: NetworkClient;
let proxy: TcpProxy;
const origin = testOrigin();

beforeAll(async () => {
  admin = await adminClient();
  publisher = await authorizedClient(admin, "rs-publisher", "publisher");
  validator = await authorizedClient(admin, "rs-validator", "validator");
  await publisher.registerApplication(origin, ["/orders/:id"]);
  const target = new URL(env().endpoint);
  proxy = new TcpProxy(target.hostname, Number(target.port || 3100));
  await proxy.start();
});

afterAll(async () => {
  await Promise.all([admin, publisher, validator].map((c) => c?.close()));
  await proxy?.stop();
});

describe("disconnects", () => {
  it("do not throw into callers, flip isConnected, and reconnect with backoff", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);

    const capabilityId = `resil-${uid()}`;
    const v1 = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 1, origin }));
    await admin.promote(v1);

    const edge = await NetworkClient.connect(configFor("rs-edge", { endpoint: proxy.endpoint(), publishEnabled: false }), {
      reconnectMinDelayMs: 500,
      reconnectMaxDelayMs: 1000,
    });
    const statuses: boolean[] = [];
    edge.onStatus((c) => statuses.push(c));
    await edge.watchOrigins([origin]);
    const query = { origins: [origin], canonicalOperation: `op:${capabilityId}`, signatures: [] };
    expect((await edge.lookup(query)).candidates[0]?.versionId).toBe(v1);

    proxy.cut();
    await waitFor(() => !edge.isConnected(), 5000, "disconnect detected");
    expect(statuses).toContain(false);

    // Reads keep working from the cache; nothing throws.
    const offline = await edge.lookup(query);
    expect(offline.candidates[0]?.versionId).toBe(v1);
    expect(edge.activeVersion(capabilityId)?.versionId).toBe(v1);
    expect(edge.stats().connected).toBe(false);
    // Callers that do need the network get a typed error.
    await expect(edge.reportReuse(v1, true)).rejects.toBeInstanceOf(NetworkUnavailableError);

    // A change committed while the edge is offline is delivered after it reconnects.
    const v2 = await proposeVerified(publisher, validator, sampleCapability({ capabilityId, version: 2, origin }));
    await admin.promote(v2);
    const caughtUp = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("v2 ACTIVE change not delivered after reconnect")), 20_000);
      const off = edge.onCapabilityChange((ch) => {
        if (ch.versionId === v2 && ch.state === "ACTIVE") {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
    caughtUp.catch(() => {});
    await new Promise((r) => setTimeout(r, 1200)); // stay down across at least one retry
    expect(edge.isConnected()).toBe(false);

    const restoredAt = Date.now();
    proxy.restore();
    await waitFor(() => edge.isConnected(), 15_000, "reconnect");
    const reconnectMs = Date.now() - restoredAt;
    await caughtUp;
    await waitFor(() => edge.activeVersion(capabilityId)?.versionId === v2, 5000, "cache caught up");
    expect(statuses.at(-1)).toBe(true);
    recordMetrics("resilience", { reconnectAfterRestoreMs: reconnectMs, statusTransitions: statuses });

    await edge.close();
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
  });

  it("connect() fails fast with NetworkUnavailableError when the server is unreachable", async () => {
    proxy.cut();
    const t0 = Date.now();
    await expect(NetworkClient.connect(configFor("rs-down", { endpoint: proxy.endpoint() }), { connectTimeoutMs: 1500 })).rejects.toBeInstanceOf(NetworkUnavailableError);
    expect(Date.now() - t0).toBeLessThan(3000);
    proxy.restore();
  });
});
