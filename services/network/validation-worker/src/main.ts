import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { AppBinding } from "@overclock/contracts";
import { BrowserManager, SessionManager, type Credentials } from "@overclock/browser-runtime";
import type { INetworkClient, NetworkConfig } from "@overclock/network-contracts";
import { validateProposedCapability } from "./validate";
import { startValidationWorker } from "./worker";

/**
 * Runnable entry for the validation worker.
 *
 *   One-shot (no network):
 *     tsx services/network/validation-worker/src/main.ts --file cap.json --arena http://127.0.0.1:4100
 *     tsx services/network/validation-worker/src/main.ts --file cap.json --apps '[{"name":"Orders","origin":"http://127.0.0.1:4102"}]'
 *
 *   Network (watches PROPOSED versions and records results):
 *     tsx services/network/validation-worker/src/main.ts --network --arena http://127.0.0.1:4100
 *   The INetworkClient implementation is loaded from OVERCLOCK_NETWORK_CLIENT_MODULE
 *   (default "@overclock/network-client"), export `createNetworkClient(config)`.
 *
 * Credentials come from the environment only: OVERCLOCK_APP_CREDENTIALS (JSON by origin) or
 * ARENA_USERNAME / ARENA_PASSWORD. Every validator browser context blocks mutations.
 */

function credentialsFor(_app: string, origin: string): Credentials | undefined {
  try {
    const table = process.env.OVERCLOCK_APP_CREDENTIALS ? (JSON.parse(process.env.OVERCLOCK_APP_CREDENTIALS) as Record<string, Credentials>) : {};
    const t = table[new URL(origin).origin];
    if (t) return { username: t.username, password: t.password };
  } catch {
    // fall through to the arena defaults
  }
  return { username: process.env.ARENA_USERNAME || "operator", password: process.env.ARENA_PASSWORD || "overclock-arena" };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function resolveApps(): Promise<AppBinding[]> {
  const json = arg("--apps") ?? process.env.OVERCLOCK_VALIDATOR_APPS;
  if (json) return JSON.parse(json) as AppBinding[];
  const arena = arg("--arena");
  if (!arena) throw new Error("pass --apps '<json>' or --arena <adminOrigin>");
  const health = (await (await fetch(`${arena}/api/health`)).json()) as { origins: Record<string, string> };
  return Object.entries(health.origins).map(([name, origin]) => ({ name, origin }));
}

function networkConfig(): NetworkConfig {
  return {
    enabled: true,
    endpoint: process.env.OVERCLOCK_NETWORK_ENDPOINT || "ws://127.0.0.1:3000",
    database: process.env.OVERCLOCK_NETWORK_DATABASE || "overclock-network",
    mode: "network-read",
    publishEnabled: false,
    lookupTimeoutMs: Number(process.env.OVERCLOCK_NETWORK_LOOKUP_TIMEOUT_MS || 500),
    dataDir: process.env.OVERCLOCK_DATA_DIR || ".data/validator",
    runtimeLabel: process.env.OVERCLOCK_RUNTIME_LABEL || "validator",
  };
}

export async function main(): Promise<void> {
  const apps = await resolveApps();
  const browser = new BrowserManager({ headless: true });
  const sessions = new SessionManager(browser, credentialsFor);
  const environment = process.env.OVERCLOCK_VALIDATOR_ENV || "local-validator";
  try {
    const file = arg("--file");
    if (file) {
      const capability: unknown = JSON.parse(readFileSync(file, "utf8"));
      const names = new Set(((capability as { applications?: { name: string }[] }).applications ?? []).map((a) => a.name));
      const used = apps.filter((a) => names.has(a.name));
      const report = await validateProposedCapability({ capability, apps: used, browser, storageState: await sessions.storageStateFor(used), environment });
      // Print only the sanitized result and evidence; rebinding details hold local data.
      console.log(JSON.stringify({ result: report.result, evidence: report.evidence, limitations: report.limitations, ms: report.ms }, null, 2));
      process.exitCode = report.result.outcome === "pass" ? 0 : 1;
      return;
    }
    if (!process.argv.includes("--network")) throw new Error("pass --file <capability.json> or --network");
    const modName = process.env.OVERCLOCK_NETWORK_CLIENT_MODULE || "@overclock/network-client";
    const mod = (await import(modName)) as { createNetworkClient?: (c: NetworkConfig) => INetworkClient | Promise<INetworkClient> };
    if (typeof mod.createNetworkClient !== "function") throw new Error(`${modName} does not export createNetworkClient(config)`);
    const client = await mod.createNetworkClient(networkConfig());
    const worker = await startValidationWorker({
      client,
      browser,
      apps,
      environment,
      storageStateFor: (a) => sessions.storageStateFor(a),
      onResult: (r) => console.log(`[validator] ${r.result.versionId} ${r.result.outcome} ${r.result.category} (${r.ms} ms)`),
      onSkip: (v, reason) => console.log(`[validator] skipped ${v}: ${reason}`),
    });
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await worker.stop();
    await client.close();
  } finally {
    await browser.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`[validator] ${(err as Error).message}`);
    process.exit(1);
  });
}
