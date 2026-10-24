import { join } from "node:path";
import { loadEnv, repoRoot } from "@overclock/telemetry";
import { ManagerWithHistory } from "./historical";
import { EngineRunManager } from "./manager";
import { EngineRuntime, engineConfigFromEnv } from "./runtime";
import { createEngineServer } from "./server";
import { EngineStore } from "./store";

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
