import type { BenchmarkAggregate, BenchmarkRunRecord } from "@overclock/contracts";

/**
 * Aggregation math for benchmark reports. Every statistic is computed from recorded runs only;
 * an empty sample yields NaN (rendered "n/a"), never a substitute value.
 */

/** Linear-interpolation percentile (the common "type 7" definition). `q` is in [0, 1]. Empty input → NaN. */
export function percentile(xs: readonly number[], q: number): number {
  if (!(q >= 0 && q <= 1)) throw new RangeError(`percentile q must be in [0, 1], got ${q}`);
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = s[lo]!;
  const b = s[hi]!;
  return a + (b - a) * (pos - lo);
}

export function median(xs: readonly number[]): number {
  return percentile(xs, 0.5);
}

export function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/** p95 needs at least this many samples; with fewer it is reported as unavailable. */
export const P95_MIN_N = 5;

export function p95(xs: readonly number[]): number | null {
  return xs.length >= P95_MIN_N ? percentile(xs, 0.95) : null;
}

/**
 * A run counts as failed when the harness recorded an error, or when either the engine summary
 * or the checker result is missing (no ground truth means no accuracy claim).
 */
export function isFailedRun(r: BenchmarkRunRecord): boolean {
  return typeof r.error === "string" || r.summary === null || r.check === null;
}

/** Checker accuracy for one run: correctRecords / totalRecords. */
export function runAccuracy(r: BenchmarkRunRecord): number {
  if (!r.check || r.check.totalRecords <= 0) return NaN;
  return r.check.correctRecords / r.check.totalRecords;
}

/** Runs are only pooled when every one of these matches. */
export interface GroupKey {
  suite: string;
  label: string;
  template: string;
  seed: number;
  records: number;
  cache: "cold" | "warm";
  holdout: boolean;
}

export function keyOf(r: BenchmarkRunRecord): GroupKey {
  return { suite: r.suite, label: r.label, template: r.template, seed: r.seed, records: r.records, cache: r.cache, holdout: r.holdout };
}

export function keyString(k: GroupKey): string {
  return [k.suite, k.label, k.template, k.seed, k.records, k.cache, k.holdout ? "holdout" : "dev"].join("|");
}

export interface RunGroup {
  key: GroupKey;
  runs: BenchmarkRunRecord[];
  /** Position of the group's first run in the input, used to keep plan order in reports. */
  firstIndex: number;
}

/** Group runs by suite, label, scenario (template + seed), records, cache state, and holdout. */
export function groupRuns(runs: readonly BenchmarkRunRecord[]): RunGroup[] {
  const groups = new Map<string, RunGroup>();
  runs.forEach((r, i) => {
    const key = keyOf(r);
    const ks = keyString(key);
    const g = groups.get(ks);
    if (g) g.runs.push(r);
    else groups.set(ks, { key, runs: [r], firstIndex: i });
  });
  return [...groups.values()];
}

/** BenchmarkAggregate plus the fields the report needs to place and compare it. */
export interface AggregateRow extends BenchmarkAggregate {
  suite: string;
  template: string;
  seed: number;
  /** Runs attempted = n (completed) + failedRuns. */
  attempted: number;
  /** Total cost / total checker-correct records over completed runs; null when nothing was correct. */
  costPerCorrectUsd: number | null;
  discoveryMs: { median: number };
  compileMs: { median: number };
  executionMs: { median: number };
  /** Median of wallMs − (discovery + compile + execution) per run; negative means the phases overlap. */
  unattributedMs: { median: number };
  /** maxWorkers from the run configs when every run in the group used the same value. */
  maxWorkers: number | null;
  firstIndex: number;
}

/**
 * Aggregate one group. `n` counts completed runs; every median is over completed runs only.
 * Failed runs are counted in `failedRuns`. `verifiedButWrong` sums over every run that has a
 * checker result, failed or not, because a false VERIFIED claim matters either way.
 */
export function aggregateGroup(group: RunGroup): AggregateRow {
  const ok = group.runs.filter((r) => !isFailedRun(r));
  const wall = ok.map((r) => r.wallMs);
  const acc = ok.map(runAccuracy).filter((x) => !Number.isNaN(x));
  const totalCost = sum(ok.map((r) => r.costUsd));
  const totalCorrect = sum(ok.map((r) => r.check?.correctRecords ?? 0));
  const workers = new Set(group.runs.map((r) => r.config.maxWorkers));
  const onlyWorkers = workers.size === 1 ? [...workers][0] : undefined;
  return {
    label: group.key.label,
    suite: group.key.suite,
    template: group.key.template,
    seed: group.key.seed,
    records: group.key.records,
    cache: group.key.cache,
    holdout: group.key.holdout,
    n: ok.length,
    attempted: group.runs.length,
    failedRuns: group.runs.length - ok.length,
    wallMs: { median: median(wall), p95: p95(wall), min: wall.length ? Math.min(...wall) : NaN, max: wall.length ? Math.max(...wall) : NaN },
    accuracy: { median: median(acc), min: acc.length ? Math.min(...acc) : NaN },
    correctPerMin: { median: median(ok.map((r) => r.correctPerMin)) },
    costUsd: { median: median(ok.map((r) => r.costUsd)) },
    costPerCorrectUsd: totalCorrect > 0 ? totalCost / totalCorrect : null,
    modelCalls: { median: median(ok.map((r) => r.modelCalls)) },
    verifiedButWrong: sum(group.runs.filter((r) => r.check !== null).map((r) => r.verifiedButWrong)),
    discoveryMs: { median: median(ok.map((r) => r.discoveryMs)) },
    compileMs: { median: median(ok.map((r) => r.compileMs)) },
    executionMs: { median: median(ok.map((r) => r.executionMs)) },
    unattributedMs: { median: median(ok.map((r) => r.wallMs - (r.discoveryMs + r.compileMs + r.executionMs))) },
    maxWorkers: typeof onlyWorkers === "number" ? onlyWorkers : null,
    firstIndex: group.firstIndex,
  };
}

/** Aggregate every group, ordered by suite, then holdout, cache, records, and first appearance. */
export function aggregateRuns(runs: readonly BenchmarkRunRecord[]): AggregateRow[] {
  const suiteOrder = new Map<string, number>();
  runs.forEach((r, i) => {
    if (!suiteOrder.has(r.suite)) suiteOrder.set(r.suite, i);
  });
  return groupRuns(runs)
    .map(aggregateGroup)
    .sort(
      (a, b) =>
        (suiteOrder.get(a.suite) ?? 0) - (suiteOrder.get(b.suite) ?? 0) ||
        Number(a.holdout) - Number(b.holdout) ||
        Number(a.cache === "warm") - Number(b.cache === "warm") ||
        a.records - b.records ||
        a.template.localeCompare(b.template) ||
        a.seed - b.seed ||
        a.firstIndex - b.firstIndex,
    );
}

export type Comparability = { ok: true } | { ok: false; reason: string };

/**
 * Two aggregates are comparable only when they ran the same scenario (template + seed), the same
 * record count, the same cache state, and the same holdout status, and both have completed runs.
 */
export function comparable(a: AggregateRow, b: AggregateRow): Comparability {
  if (a.records !== b.records) return { ok: false, reason: `records differ (${a.records} vs ${b.records})` };
  if (a.cache !== b.cache) return { ok: false, reason: `cache state differs (${a.cache} vs ${b.cache})` };
  if (a.holdout !== b.holdout) return { ok: false, reason: "holdout status differs" };
  if (a.template !== b.template || a.seed !== b.seed) return { ok: false, reason: `scenario differs (${a.template}/${a.seed} vs ${b.template}/${b.seed})` };
  if (a.n === 0 || b.n === 0) return { ok: false, reason: "a group has no completed runs" };
  return { ok: true };
}

export interface Speedup {
  baseline: string;
  candidate: string;
  records: number;
  cache: "cold" | "warm";
  holdout: boolean;
  template: string;
  seed: number;
  nBaseline: number;
  nCandidate: number;
  /** baseline median wall / candidate median wall (> 1 means the candidate is faster). */
  wallRatio: number;
  /** candidate median correct/min / baseline median correct/min; null when the baseline's is 0. */
  correctPerMinRatio: number | null;
}

export type SpeedupResult = { ok: true; value: Speedup } | { ok: false; reason: string };

export function computeSpeedup(baseline: AggregateRow, candidate: AggregateRow): SpeedupResult {
  if (baseline.label === candidate.label && baseline.suite === candidate.suite) return { ok: false, reason: "same label" };
  const c = comparable(baseline, candidate);
  if (!c.ok) return c;
  if (!(candidate.wallMs.median > 0)) return { ok: false, reason: "candidate median wall time is not positive" };
  return {
    ok: true,
    value: {
      baseline: baseline.label,
      candidate: candidate.label,
      records: baseline.records,
      cache: baseline.cache,
      holdout: baseline.holdout,
      template: baseline.template,
      seed: baseline.seed,
      nBaseline: baseline.n,
      nCandidate: candidate.n,
      wallRatio: baseline.wallMs.median / candidate.wallMs.median,
      correctPerMinRatio: baseline.correctPerMin.median > 0 ? candidate.correctPerMin.median / baseline.correctPerMin.median : null,
    },
  };
}
