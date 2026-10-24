/**
 * Authorize a registered runtime identity as the database owner (the CLI identity that
 * published the module, which `init` made the network admin).
 *
 *   tsx scripts/network-authorize.ts --identity <hex> --role publisher|validator|repairer|admin
 *       [--database <name>] [--server local|maincloud|<url>]
 *
 * The runtime must have called registerPublisher() first. Its identity is NetworkClient.identity.
 */

import { argValue, authorizeAsOwner, cliServerFor, LOCAL_ENDPOINT } from "./network-lib";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const identityHex = argValue(argv, "--identity");
  const role = argValue(argv, "--role");
  const database = argValue(argv, "--database") ?? (process.env["OVERCLOCK_NETWORK_DATABASE"]?.trim() || "overclock-network");
  const server = argValue(argv, "--server") ?? cliServerFor(process.env["OVERCLOCK_NETWORK_ENDPOINT"]?.trim() || LOCAL_ENDPOINT);
  if (!identityHex || !/^(0x)?[0-9a-f]{64}$/i.test(identityHex)) throw new Error("--identity <64 hex chars> is required");
  if (!role || !["publisher", "validator", "repairer", "admin"].includes(role)) throw new Error("--role must be publisher, validator, repairer, or admin");
  await authorizeAsOwner({ database, server, identityHex, role });
  console.log(`authorized ${identityHex.slice(0, 14)}… as ${role} on ${database} (${server})`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
