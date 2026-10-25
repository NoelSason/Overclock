import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, repoRoot } from "@overclock/telemetry";
import { ManagerWithHistory } from "./historical";
import { ENGINE_VERSION, EngineRunManager } from "./manager";
import { EngineRuntime, engineConfigFromEnv } from "./runtime";
import { createEngineServer } from "./server";
import { EngineStore } from "./store";
import { ClaudeProvider, type ClaudeRole } from "@overclock/models";
import { BrowserAgentService } from "./agent";
import { GOOGLE_CALLBACK_PATH, GoogleAccount } from "./google";
import { ExtensionAccess, unpackedExtensionId, type ExtensionStatus } from "./extension";
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
// Trusted without a code: the extension built in this repo (its unpacked id follows from the
// folder it's loaded from), OVERCLOCK_EXTENSION_ID, and any extension that paired with a code before.
const access = new ExtensionAccess({
  file: join(config.dataDir, "extension-access.json"),
  trusted: [unpackedExtensionId(join(repoRoot(), "apps", "extension", "dist")), ...(process.env.OVERCLOCK_EXTENSION_ID ? [process.env.OVERCLOCK_EXTENSION_ID] : [])],
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
// In-browser tasks from the extension ("Ask"): Haiku by default (OVERCLOCK_AGENT_ROLE=planner for Opus).
// The user's Google account for in-browser tasks (Gmail read-only, Docs it creates); tokens stay in the data dir.
const google = new GoogleAccount({
  clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
  clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  file: join(config.dataDir, "google-account.json"),
  redirectUri: () => `http://127.0.0.1:${config.port}${GOOGLE_CALLBACK_PATH}`,
});
const agent = new BrowserAgentService({
  model: (ledger) => new ClaudeProvider(runtime.claudeConfig, ledger),
  available: () => !!process.env.ANTHROPIC_API_KEY,
  role: (process.env.OVERCLOCK_AGENT_ROLE as ClaudeRole) || "helper",
  maxSteps: Number(process.env.OVERCLOCK_AGENT_MAX_STEPS) || 60,
  budgetUsd: Number(process.env.OVERCLOCK_AGENT_BUDGET_USD) || 0.5,
  ledger: runtime.ledger,
  google,
  log: (line) => console.log(line),
});
const extension = {
  workflows,
  agent,
  google,
  access,
  extensionId: process.env.OVERCLOCK_EXTENSION_ID || undefined,
  // Answers without launching a browser: the side panel polls this, and in-browser tasks never
  // use Overclock's own Chromium. Workflow runs launch it on first use.
  status: async (): Promise<ExtensionStatus> => {
    const applications = workflows.applications();
    const loopback = applications.length > 0 && applications.every((a) => /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(a.origin));
    return {
      version: ENGINE_VERSION,
      browser: { kind: "overclock-chromium", visible: !config.headless, available: true },
      planning: { available: !!process.env.ANTHROPIC_API_KEY },
      network: { enabled: runtime.network.enabled, connected: runtime.network.enabled ? (await runtime.network.client()) !== null : false },
      environment: { label: process.env.OVERCLOCK_ENVIRONMENT_LABEL || (loopback ? "Demonstration apps on this computer (Overclock arena)" : "Applications configured on this engine"), applications },
      agent: { available: agent.available(), model: agent.modelName() },
      google: google.status(),
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
