import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, repoRoot } from "@overclock/telemetry";
import { ManagerWithHistory } from "./historical";
import { EngineRunManager } from "./manager";
import { EngineRuntime, engineConfigFromEnv } from "./runtime";
import { createEngineServer } from "./server";
import { EngineStore } from "./store";
import { ExtensionAccess, type ExtensionStatus } from "./extension";
import { WorkflowService, type WorkflowApp } from "./workflows";

/** OVERCLOCK_EXTENSION_APPS: a JSON list of {name, origin} a new task from the extension may use. */
function extensionApps(raw: string | undefined): WorkflowApp[] {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? list.filter((a): a is WorkflowApp => typeof a?.name === "string" && typeof a?.origin === "string") : [];
  } catch {
    return [];
  }
}

// tsx turns on source-mapped stack traces. Playwright captures a stack for every browser call,
// and mapping those frames cost the engine's main thread several seconds per 500-record run (CPU
// profile, 2026-10-24). Stacks then show compiled positions; OVERCLOCK_SOURCE_MAPS=1 restores them.
if (process.env.OVERCLOCK_SOURCE_MAPS !== "1") process.setSourceMapsEnabled(false);

loadEnv();
const config = engineConfigFromEnv();
const store = new EngineStore(join(config.dataDir, "engine.db"));
const runtime = new EngineRuntime(config);
const live = new EngineRunManager(runtime, store);
const manager = new ManagerWithHistory(live, store);
// The Chrome extension's gateway (/api/x/*): pairing code on the console and in the data dir.
const pairingFile = join(config.dataDir, "extension-pairing-code");
let listening = false;
const access = new ExtensionAccess({
  onCode: (code, expiresAt) => {
    try {
      writeFileSync(pairingFile, `${code}\n`, { mode: 0o600 });
    } catch {
      // the console line below is enough
    }
    if (listening) console.log(`Chrome extension pairing code: ${code} (single use, valid until ${new Date(expiresAt).toLocaleTimeString()})`);
  },
});
const workflows = new WorkflowService({
  cache: runtime.cache,
  network: () => runtime.network.client(),
  planningAvailable: !!process.env.ANTHROPIC_API_KEY,
  extraApplications: extensionApps(process.env.OVERCLOCK_EXTENSION_APPS),
});
const extension = {
  workflows,
  access,
  extensionId: process.env.OVERCLOCK_EXTENSION_ID || undefined,
  status: async (): Promise<ExtensionStatus> => {
    const health = await live.health();
    const applications = workflows.applications();
    const loopback = applications.length > 0 && applications.every((a) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(a.origin));
    return {
      version: health.version,
      browser: { kind: "overclock-chromium", visible: !config.headless, available: health.capabilities.browser.available },
      planning: { available: health.capabilities.anthropic.available },
      network: { enabled: runtime.network.enabled, connected: runtime.network.enabled ? (await runtime.network.client()) !== null : false },
      environment: { label: process.env.OVERCLOCK_ENVIRONMENT_LABEL || (loopback ? "Demonstration apps on this computer (Overclock arena)" : "Applications configured on this engine"), applications },
    };
  },
};
const server = await createEngineServer({ manager, benchmarksDir: join(repoRoot(), "benchmarks", "results"), host: config.host, port: config.port, extension });
listening = true;
console.log(`Overclock engine (${config.runtimeLabel}) listening on ${server.url}  data=${config.dataDir}`);
console.log(`Chrome extension pairing code: ${access.currentCode()} (single use; also in ${pairingFile})`);
// Launch the browser pool at startup, as a long-running engine has it warm anyway; a run that
// starts first waits on the same launches. OVERCLOCK_WARM_BROWSERS=0 launches on first use instead.
if (process.env.OVERCLOCK_WARM_BROWSERS !== "0") void runtime.browser.warm().catch((err: unknown) => console.warn(`browser warm-up failed: ${err instanceof Error ? err.message : String(err)}`));

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) process.exit(1);
  stopping = true;
  await live.cancelAll();
  await server.close();
  await runtime.close();
  store.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
