import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Overclock Network tests against a real local SpacetimeDB (no mocks).
 *
 *   vitest run --config tests/network/vitest.config.ts
 *
 * Global setup starts `spacetime start` if needed, publishes the module to a fresh ephemeral
 * database (overclock-net-test-<random>), and deletes it afterwards. Files run serially because
 * they share that database and the local server.
 */
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    name: "network",
    include: ["tests/network/**/*.test.ts"],
    environment: "node",
    globalSetup: ["tests/network/global-setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
