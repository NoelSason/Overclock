import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DisabledNetworkClient,
  NetworkDisabledError,
  createNetworkClient,
  networkConfigFromEnv,
} from "../../packages/network-client/src/index";
import { client } from "./helpers";

describe("config and disabled mode", () => {
  it("reads config from the environment with safe defaults", () => {
    const off = networkConfigFromEnv("/tmp/rt", {});
    expect(off).toMatchObject({ enabled: false, endpoint: "ws://127.0.0.1:3100", database: "overclock-network", mode: "network-read", publishEnabled: false, lookupTimeoutMs: 500 });
    const on = networkConfigFromEnv("/tmp/rt", {
      OVERCLOCK_NETWORK_ENABLED: "true",
      OVERCLOCK_NETWORK_ENDPOINT: "https://maincloud.spacetimedb.com",
      OVERCLOCK_NETWORK_DATABASE: "overclock-network-x",
      OVERCLOCK_NETWORK_MODE: "network-read-and-contribute",
      OVERCLOCK_NETWORK_PUBLISH_ENABLED: "1",
      OVERCLOCK_NETWORK_LOOKUP_TIMEOUT_MS: "250",
      OVERCLOCK_RUNTIME_LABEL: "runtime-b",
    });
    expect(on).toEqual({
      enabled: true,
      endpoint: "https://maincloud.spacetimedb.com",
      database: "overclock-network-x",
      mode: "network-read-and-contribute",
      publishEnabled: true,
      lookupTimeoutMs: 250,
      dataDir: "/tmp/rt",
      runtimeLabel: "runtime-b",
    });
  });

  it("returns NO_CAPABILITY instantly and throws NetworkDisabledError elsewhere", async () => {
    const c = await createNetworkClient(networkConfigFromEnv("/tmp/rt", {}));
    expect(c).toBeInstanceOf(DisabledNetworkClient);
    const t0 = performance.now();
    const r = await c.lookup({ origins: ["https://a.example"], signatures: [] });
    expect(performance.now() - t0).toBeLessThan(5);
    expect(r).toEqual({ candidates: [], source: "negative-cache", ms: 0 });
    await expect(c.fetchArtifact("x@1")).rejects.toBeInstanceOf(NetworkDisabledError);
    await expect(c.watchOrigins(["https://a.example"])).rejects.toBeInstanceOf(NetworkDisabledError);
    await expect(c.claimRepair("j", 1000)).rejects.toBeInstanceOf(NetworkDisabledError);
    expect(c.isConnected()).toBe(false);
    expect(c.activeVersion("x")).toBeNull();
  });

  it("persists one identity per runtime in <dataDir>/network-token with 0600 permissions", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "overclock-net-token-"));
    const first = await client("token-a", { dataDir });
    const id = first.identity;
    await first.close();
    expect(statSync(join(dataDir, "network-token")).mode & 0o777).toBe(0o600);
    const second = await client("token-a", { dataDir });
    expect(second.identity).toBe(id);
    const other = await client("token-b");
    expect(other.identity).not.toBe(id);
    await Promise.all([second.close(), other.close()]);
    rmSync(dataDir, { recursive: true, force: true });
  });
});
