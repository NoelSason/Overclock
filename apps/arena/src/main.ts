import { startArena } from "./index";

/** `pnpm arena`: start the three arena apps and the judge console from environment settings. */
const arena = await startArena();
const s = arena.manager.publicScenario();
console.log("Overclock Arena is running");
console.log(`  Judge console   ${arena.adminOrigin}`);
console.log(`  Ledgerline CRM  ${arena.origins.CRM}`);
console.log(`  Parcelpoint     ${arena.origins.Orders}`);
console.log(`  Helpwell Desk   ${arena.origins.Support}`);
if (s) console.log(`  Scenario        ${s.scenarioId} (${s.records.length} records)`);

let stopping = false;
const stop = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal} received, shutting down…`);
  await arena.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop("SIGINT"));
process.on("SIGTERM", () => void stop("SIGTERM"));
