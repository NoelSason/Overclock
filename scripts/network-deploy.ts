/**
 * Deploy the Overclock Network module to SpacetimeDB Maincloud (optional; local stays the default
 * for development and every test).
 *
 *   tsx scripts/network-deploy.ts [--database <name>] [--break-clients] [--clean] [--no-generate]
 *
 *   --database       Maincloud database name (default: OVERCLOCK_NETWORK_DATABASE or
 *                    overclock-network). Names are global on Maincloud; if one is taken by another
 *                    account the publish fails with 401/403, so pick a suffixed name.
 *   --break-clients  allow a schema change that breaks existing clients
 *   --clean          DESTROY all data in the Maincloud database and republish from scratch
 *   --no-generate    skip regenerating packages/network-client/src/generated
 *
 * Auth: run `spacetime login` yourself first (interactive browser login). This script never
 * reads, prints, or stores the CLI token; it only checks `spacetime login show`.
 *
 * The CLI identity that publishes becomes the database owner, which the module's `init`
 * bootstraps as the network admin. Authorize runtimes with scripts/network-authorize.ts.
 */

import { MAINCLOUD_ENDPOINT, argValue, cliLoggedIn, ensureCli, ensureModuleDeps, generateBindings, MODULE_PATH, spacetime } from "./network-lib";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const database = argValue(argv, "--database") ?? (process.env["OVERCLOCK_NETWORK_DATABASE"]?.trim() || "overclock-network");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(database)) throw new Error(`invalid database name ${database}: use lowercase letters and digits separated by dashes`);

  await ensureCli();
  const login = await cliLoggedIn();
  if (!login.loggedIn) {
    console.error("The spacetime CLI is not logged in. Run this yourself (it opens a browser), then rerun the deploy:\n\n  spacetime login\n");
    process.exit(2);
  }
  console.log(`CLI logged in as ${login.identity} (this identity will own the database and is its network admin)`);

  await ensureModuleDeps();
  const yes = ["remote", "skip-login"];
  const args = ["publish", database, "--server", "maincloud", "--module-path", MODULE_PATH, "--no-config"];
  if (argv.includes("--break-clients")) yes.push("break-clients");
  if (argv.includes("--clean")) {
    args.push("--delete-data=always");
    yes.push("delete-data");
  }
  args.push(`--yes=${yes.join(",")}`);

  const r = await spacetime(args, { allowFail: true, timeoutMs: 600_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code !== 0) {
    if (/40[13]|not authorized|unauthorized|forbidden/i.test(out)) {
      console.error(`Publishing ${database} was refused. Maincloud database names are global; if another account owns this name, rerun with a suffix, for example:\n\n  tsx scripts/network-deploy.ts --database ${database}-${login.identity?.slice(0, 6) ?? "x"}\n`);
    }
    console.error(out.trim().slice(-3000));
    process.exit(1);
  }
  const line = out.split("\n").find((l) => /Created new database|Updated database|identity:/i.test(l));
  console.log(line ? line.trim() : `published ${database}`);

  if (!argv.includes("--no-generate")) {
    await generateBindings();
    console.log("regenerated packages/network-client/src/generated");
  }

  console.log(`
Put these in .env for each runtime (each runtime keeps its own identity in <dataDir>/network-token):

OVERCLOCK_NETWORK_ENABLED=true
OVERCLOCK_NETWORK_ENDPOINT=${MAINCLOUD_ENDPOINT}
OVERCLOCK_NETWORK_DATABASE=${database}

Dashboard: https://spacetimedb.com/${database}
Authorize a runtime: tsx scripts/network-authorize.ts --server maincloud --database ${database} --identity <hex> --role publisher`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
