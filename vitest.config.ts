import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 120_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "adversarial",
          include: ["tests/adversarial/**/*.test.ts"],
          environment: "node",
          testTimeout: 180_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: "performance",
          include: ["tests/performance/**/*.test.ts"],
          environment: "node",
          testTimeout: 600_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
