import path from "node:path";
import { defineConfig } from "@playwright/test";
import { ARENA_URL, DASHBOARD_PORT, DASHBOARD_URL, ENGINE_URL, EXTERNAL_ENGINE, REPLAY_ARENA_PORT, REPLAY_PORT } from "./env";

const root = path.resolve(import.meta.dirname, "../..");

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: /.*\.spec\.ts$/,
  outputDir: path.join(root, "test-results/e2e"),
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: DASHBOARD_URL,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1600, height: 1000 },
    trace: "retain-on-failure",
  },
  webServer: [
    ...(EXTERNAL_ENGINE
      ? []
      : [
          {
            // Test-only replay of a synthetic run; see tests/e2e/fixtures/replay-server.ts.
            command: `pnpm exec tsx tests/e2e/fixtures/replay-server.ts --port ${REPLAY_PORT} --arena-port ${REPLAY_ARENA_PORT} --speed 8`,
            url: `http://127.0.0.1:${REPLAY_PORT}/api/health`,
            cwd: root,
            reuseExistingServer: !process.env.CI,
            timeout: 30_000,
          },
        ]),
    {
      command: `pnpm --filter @overclock/dashboard exec next dev -p ${DASHBOARD_PORT}`,
      url: DASHBOARD_URL,
      cwd: root,
      env: { NEXT_PUBLIC_OVERCLOCK_URL: ENGINE_URL, NEXT_PUBLIC_ARENA_ADMIN_URL: ARENA_URL },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
