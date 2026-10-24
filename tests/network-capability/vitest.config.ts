import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Overclock Network capability layer: export, sanitize, analyze, rebind, validate.
 * Run: npx vitest run -c tests/network-capability/vitest.config.ts
 * Starts the arena in-process on ephemeral ports and drives headless Chromium.
 */
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    name: "network-capability",
    include: ["tests/network-capability/**/*.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
