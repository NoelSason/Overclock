import type { CheckResult } from "./scenario";
import type { RunConfigInput, RunSummary } from "./run";

/**
 * Benchmark result file format (benchmarks/results/<timestamp>-<suite>.json). Written by the
 * benchmark harness, rendered by the dashboard's benchmarks page and docs/BENCHMARKS.md.
 * Every number comes from an executed run; nothing is estimated.
 */
export interface BenchmarkRunRecord {
  suite: string;
  /** Mode or ablation label, e.g. "sequential-agent", "compiled-single", "overclock", "ablation:no-jev". */
  label: string;
  mode: string;
  scenarioId: string;
  template: string;
  seed: number;
  records: number;
  trial: number;
  cache: "cold" | "warm";
  holdout: boolean;
  runId: string | null;
  startedAt: number;
  /** What the engine claims. */
  summary: RunSummary | null;
  /** Independent ground truth from the arena checker. */
  check: CheckResult | null;
  wallMs: number;
  discoveryMs: number;
  compileMs: number;
  executionMs: number;
  /** Records the checker marks correct, per minute of wall time. */
  correctPerMin: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  workerUtilization: number;
  maxConcurrency: number;
  /** Records the engine reported VERIFIED that the checker marks incorrect (should be 0). */
  verifiedButWrong: number;
  /** Cold-start metrics (ms since submission); null when nothing happened. */
  firstActionMs: number | null;
  firstVerifiedMs: number | null;
  overlapMs: number;
  recoveryMs: number;
  duplicateWrites: number;
  collateralWrites: number;
  /** Network/app condition the run was measured under, e.g. "local" or "latency:150±100". */
  condition: string;
  config: RunConfigInput;
  error?: string | undefined;
}

export interface BenchmarkResultFile {
  version: 1;
  suite: string;
  createdAt: number;
  machine: { platform: string; cpus: number; memoryGb: number; node: string };
  budgetUsd: number;
  spentUsd: number;
  runs: BenchmarkRunRecord[];
  notes: string[];
}

export interface BenchmarkAggregate {
  label: string;
  n: number;
  cache: "cold" | "warm";
  holdout: boolean;
  records: number;
  wallMs: { median: number; p95: number | null; min: number; max: number };
  accuracy: { median: number; min: number };
  correctPerMin: { median: number };
  costUsd: { median: number };
  modelCalls: { median: number };
  verifiedButWrong: number;
  failedRuns: number;
  firstVerifiedMs: { median: number | null };
  condition: string;
}
