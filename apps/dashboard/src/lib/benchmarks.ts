import type { BenchmarkRunRecord } from "@overclock/contracts";
import { median, percentile } from "./stats";

/**
 * Benchmark aggregation, computed in the dashboard from raw runs. A median is reported only for
 * n ≥ 2 and p95 only for n ≥ 5; a single run is shown as its own value and flagged n=1.
 */

export interface Aggregate {
  label: string;
  records: number;
  n: number;
  failedRuns: number;
  wall: Measure;
  firstVerified: Measure;
  correctPerMin: Measure;
  cost: Measure;
  modelCalls: Measure;
  accuracy: Measure & { min: number | null; checked: number };
  verifiedButWrong: number;
  duplicateWrites: number;
  collateralWrites: number;
}

export interface Measure {
  /** n ≥ 2 */
  median: number | null;
  /** n ≥ 5 */
  p95: number | null;
  /** n === 1 */
  single: number | null;
  n: number;
}

export interface Section {
  key: string;
  condition: string;
  cache: "cold" | "warm";
  holdout: boolean;
  rows: Aggregate[];
  speedups: Speedup[];
}

export interface Speedup {
  comparison: "E vs C" | "E vs D";
  records: number;
  baselineLabel: string;
  nE: number;
  nBase: number;
  /** baseline median wall / E median wall; null unless both medians exist. */
  wall: number | null;
  /** baseline median first-verified / E median first-verified. */
  firstVerified: number | null;
}

function measure(values: number[]): Measure {
  const n = values.length;
  return { n, median: n >= 2 ? median(values) : null, p95: n >= 5 ? percentile(values, 95) : null, single: n === 1 ? values[0]! : null };
}

/** The value to display: the median when there is one, else the single run's value. */
export const shown = (m: Measure): number | null => m.median ?? m.single;

const isFailed = (r: BenchmarkRunRecord) => Boolean(r.error) || (r.summary !== null && r.summary.status !== "completed");

function aggregate(label: string, records: number, runs: BenchmarkRunRecord[]): Aggregate {
  const ok = runs.filter((r) => !isFailed(r));
  const checked = ok.filter((r) => r.check !== null);
  const acc = checked.map((r) => r.check!.accuracy);
  return {
    label,
    records,
    n: runs.length,
    failedRuns: runs.length - ok.length,
    wall: measure(ok.map((r) => r.wallMs)),
    firstVerified: measure(ok.map((r) => r.firstVerifiedMs).filter((v): v is number => v !== null)),
    correctPerMin: measure(checked.map((r) => r.correctPerMin)),
    cost: measure(ok.map((r) => r.costUsd)),
    modelCalls: measure(ok.map((r) => r.modelCalls)),
    accuracy: { ...measure(acc), min: acc.length ? Math.min(...acc) : null, checked: checked.length },
    verifiedButWrong: runs.reduce((s, r) => s + r.verifiedButWrong, 0),
    duplicateWrites: runs.reduce((s, r) => s + (r.duplicateWrites ?? 0), 0),
    collateralWrites: runs.reduce((s, r) => s + (r.collateralWrites ?? 0), 0),
  };
}

type Klass = "E" | "C" | "D";

/** Which mode a benchmark label represents for speedup comparisons (ablations excluded). */
export function labelClass(label: string): Klass | null {
  const l = label.toLowerCase();
  if (l.startsWith("ablation")) return null;
  if (l === "overclock") return "E";
  if (l === "staged" || l === "overclock-staged") return "D";
  if (l === "parallel" || l === "compiler+fixed-parallel" || l === "compiled-parallel") return "C";
  return null;
}

function speedups(rows: Aggregate[]): Speedup[] {
  const out: Speedup[] = [];
  const recordsSet = [...new Set(rows.map((r) => r.records))].sort((a, b) => a - b);
  for (const records of recordsSet) {
    const at = rows.filter((r) => r.records === records);
    const e = at.find((r) => labelClass(r.label) === "E");
    if (!e) continue;
    for (const [comparison, k] of [
      ["E vs C", "C"],
      ["E vs D", "D"],
    ] as const) {
      const base = at.find((r) => labelClass(r.label) === k);
      if (!base) continue;
      const ratio = (b: number | null, x: number | null) => (b !== null && x !== null && x > 0 ? b / x : null);
      out.push({ comparison, records, baselineLabel: base.label, nE: e.wall.n, nBase: base.wall.n, wall: ratio(base.wall.median, e.wall.median), firstVerified: ratio(base.firstVerified.median, e.firstVerified.median) });
    }
  }
  return out;
}

const LABEL_ORDER = ["sequential-agent", "compiled-single", "compiled-parallel", "parallel", "compiler+fixed-parallel", "staged", "overclock-staged", "overclock"];
const labelRank = (l: string) => {
  const i = LABEL_ORDER.indexOf(l);
  return i === -1 ? LABEL_ORDER.length + (l.startsWith("ablation") ? 1 : 0) : i;
};

/** Sections by (condition, cache, holdout); rows by (label, records). */
export function buildSections(runs: BenchmarkRunRecord[]): Section[] {
  const sections = new Map<string, { condition: string; cache: "cold" | "warm"; holdout: boolean; runs: BenchmarkRunRecord[] }>();
  for (const r of runs) {
    const condition = r.condition || "unspecified";
    const key = `${condition}|${r.cache}|${r.holdout ? "holdout" : "standard"}`;
    const s = sections.get(key) ?? { condition, cache: r.cache, holdout: r.holdout, runs: [] };
    s.runs.push(r);
    sections.set(key, s);
  }
  return [...sections.entries()]
    .sort(([, a], [, b]) => a.condition.localeCompare(b.condition) || Number(a.holdout) - Number(b.holdout) || a.cache.localeCompare(b.cache))
    .map(([key, s]) => {
      const groups = new Map<string, BenchmarkRunRecord[]>();
      for (const r of s.runs) {
        const g = `${r.label}|${r.records}`;
        groups.set(g, [...(groups.get(g) ?? []), r]);
      }
      const rows = [...groups.values()].map((g) => aggregate(g[0]!.label, g[0]!.records, g)).sort((a, b) => a.records - b.records || labelRank(a.label) - labelRank(b.label) || a.label.localeCompare(b.label));
      return { key, condition: s.condition, cache: s.cache, holdout: s.holdout, rows, speedups: speedups(rows) };
    });
}
