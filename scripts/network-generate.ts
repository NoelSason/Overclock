/**
 * Regenerate the TypeScript client bindings for the Overclock Network module.
 *
 *   tsx scripts/network-generate.ts
 *
 * Equivalent to:
 *   spacetime generate --lang typescript \
 *     --out-dir packages/network-client/src/generated \
 *     --module-path services/network/spacetimedb
 *
 * Generation reads the module source (it builds the module locally); no server is needed.
 */

import { BINDINGS_DIR, ensureCli, generateBindings } from "./network-lib";

async function main(): Promise<void> {
  await ensureCli();
  await generateBindings();
  console.log(`bindings written to ${BINDINGS_DIR}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
