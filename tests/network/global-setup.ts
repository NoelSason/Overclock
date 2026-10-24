import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { NetworkClient } from "../../packages/network-client/src/index";
import {
  LOCAL_ENDPOINT,
  NETWORK_STATE_DIR,
  authorizeAsOwner,
  cliServerFor,
  deleteDatabase,
  ensureCli,
  ensureLocalServer,
  publishModule,
} from "../../scripts/network-lib";

export interface NetworkTestEnv {
  endpoint: string;
  database: string;
  server: string;
  /** Data dir holding the token of an identity the owner authorized as admin. */
  adminDataDir: string;
  /** Root for per-client data dirs (removed on teardown). */
  scratchDir: string;
}

declare module "vitest" {
  export interface ProvidedContext {
    networkTest: NetworkTestEnv;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const endpoint = process.env["OVERCLOCK_NETWORK_TEST_ENDPOINT"]?.trim() || LOCAL_ENDPOINT;
  const server = cliServerFor(endpoint);
  const database = `overclock-net-test-${randomBytes(4).toString("hex")}`;
  const scratchDir = mkdtempSync(join(tmpdir(), "overclock-net-test-"));

  await ensureCli();
  await ensureLocalServer(endpoint);
  await publishModule({ database, server, clean: true });

  // Bootstrap: the CLI identity published the database, so `init` made it the admin. Use it to
  // authorize one client identity as admin; tests then use that client for admin actions.
  const adminDataDir = join(scratchDir, "admin");
  const admin = await NetworkClient.connect({
    enabled: true,
    endpoint,
    database,
    mode: "network-read-and-contribute",
    publishEnabled: true,
    lookupTimeoutMs: 1000,
    dataDir: adminDataDir,
    runtimeLabel: "test-admin",
  });
  await admin.registerPublisher("test-admin", "admin");
  await authorizeAsOwner({ database, server, identityHex: admin.identity!, role: "admin" });
  await admin.close();

  project.provide("networkTest", { endpoint, database, server, adminDataDir, scratchDir });
  console.log(`[network-test] database ${database} on ${endpoint}`);

  return async () => {
    const metrics: Record<string, unknown> = {};
    for (const f of readdirSync(scratchDir).filter((n) => n.startsWith("metrics-") && n.endsWith(".json"))) {
      metrics[f.slice("metrics-".length, -".json".length)] = JSON.parse(readFileSync(join(scratchDir, f), "utf8"));
    }
    if (Object.keys(metrics).length > 0) {
      for (const [name, m] of Object.entries(metrics)) console.log(`[network-metrics] ${name} ${JSON.stringify(m)}`);
      mkdirSync(NETWORK_STATE_DIR, { recursive: true });
      writeFileSync(join(NETWORK_STATE_DIR, "last-test-metrics.json"), `${JSON.stringify({ endpoint, database, at: new Date().toISOString(), metrics }, null, 2)}\n`);
    }
    const deleted = await deleteDatabase({ database, server });
    rmSync(scratchDir, { recursive: true, force: true });
    console.log(`[network-test] ${deleted ? "deleted" : "could not delete"} database ${database}`);
  };
}
