/**
 * Local Overclock Network: start SpacetimeDB if needed, publish the module, regenerate bindings.
 *
 *   tsx scripts/network-dev.ts [--clean] [--database <name>] [--no-generate]
 *
 *   --clean        destroy the database's data and republish from scratch (`--delete-data=always`)
 *   --database     database name (default: OVERCLOCK_NETWORK_DATABASE or overclock-network)
 *   --no-generate  skip regenerating packages/network-client/src/generated
 *
 * The endpoint comes from OVERCLOCK_NETWORK_ENDPOINT (default ws://127.0.0.1:3000) and must be
 * local; use scripts/network-deploy.ts for Maincloud. The CLI identity that publishes is the
 * database owner, which the module's `init` bootstraps as the network admin.
 */

import {
  LOCAL_ENDPOINT,
  argValue,
  cliServerFor,
  ensureCli,
  ensureLocalServer,
  generateBindings,
  isLocalEndpoint,
  publishModule,
} from "./network-lib";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const endpoint = process.env["OVERCLOCK_NETWORK_ENDPOINT"]?.trim() || LOCAL_ENDPOINT;
  const database = argValue(argv, "--database") ?? (process.env["OVERCLOCK_NETWORK_DATABASE"]?.trim() || "overclock-network");
  const clean = argv.includes("--clean");
  if (!isLocalEndpoint(endpoint)) {
    throw new Error(`network-dev only targets a local server; OVERCLOCK_NETWORK_ENDPOINT is ${endpoint}. Use scripts/network-deploy.ts for Maincloud.`);
  }

  await ensureCli();
  const { started } = await ensureLocalServer(endpoint);
  console.log(started ? `started SpacetimeDB on ${endpoint}` : `SpacetimeDB already running on ${endpoint}`);

  const server = cliServerFor(endpoint);
  const out = await publishModule({ database, server, clean });
  const summary = out.split("\n").find((l) => /Created new database|Updated database|identity:/i.test(l));
  console.log(`published ${database}${clean ? " (clean)" : ""}${summary ? `: ${summary.trim()}` : ""}`);

  if (!argv.includes("--no-generate")) {
    await generateBindings();
    console.log("regenerated packages/network-client/src/generated");
  }
  console.log(`\nOVERCLOCK_NETWORK_ENABLED=true\nOVERCLOCK_NETWORK_ENDPOINT=${endpoint}\nOVERCLOCK_NETWORK_DATABASE=${database}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
