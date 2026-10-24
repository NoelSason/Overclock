import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NetworkService } from "../../services/engine/src/network";

/** A port nothing listens on (bound, then released). */
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

const saved = { ...process.env };
const dirs: string[] = [];
afterEach(() => {
  process.env = { ...saved };
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("engine network service", () => {
  it("is off unless enabled, without touching the network", async () => {
    delete process.env.OVERCLOCK_NETWORK_ENABLED;
    const dir = mkdtempSync(join(tmpdir(), "oc-net-"));
    dirs.push(dir);
    const svc = new NetworkService(dir, "t");
    expect(svc.enabled).toBe(false);
    expect(await svc.client()).toBeNull();
    expect(svc.error).toBeNull();
  });

  it("returns no client, with a reason, when SpacetimeDB is unreachable (runs fall back to cold discovery)", async () => {
    process.env.OVERCLOCK_NETWORK_ENABLED = "true";
    process.env.OVERCLOCK_NETWORK_ENDPOINT = `ws://127.0.0.1:${await closedPort()}`;
    const dir = mkdtempSync(join(tmpdir(), "oc-net-"));
    dirs.push(dir);
    const svc = new NetworkService(dir, "t");
    const t0 = performance.now();
    expect(await svc.client()).toBeNull();
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(svc.error).toBeTruthy();
    await svc.close();
  }, 20_000);
});
