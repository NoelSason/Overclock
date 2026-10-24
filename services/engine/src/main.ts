import { join } from "node:path";
import { loadEnv, repoRoot } from "@overclock/telemetry";
import { ManagerWithHistory } from "./historical";
import { EngineRunManager } from "./manager";
import { EngineRuntime, engineConfigFromEnv } from "./runtime";
import { createEngineServer } from "./server";
import { EngineStore } from "./store";

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
const server = await createEngineServer({ manager, benchmarksDir: join(repoRoot(), "benchmarks", "results"), host: config.host, port: config.port });
console.log(`Overclock engine (${config.runtimeLabel}) listening on ${server.url}  data=${config.dataDir}`);

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
