import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BenchmarkResultFile } from "@overclock/contracts";
import { aggregateRuns, comparable, computeSpeedup, isFailedRun, P95_MIN_N, type AggregateRow, type Speedup } from "./stats";
import {
  ABLATION_RUNGS,
  ablationLabel,
  baseSuite,
  CONDITION_DESCRIPTIONS,
  CONDITION_NAMES,
  EXTERNAL_LABEL,
  HOLDOUT_FREEZE_ENV,
  HOLDOUT_SCENARIOS,
  HOLDOUT_SEED_MIN,
  HOLDOUT_TEMPLATES,
  MODE_DESCRIPTIONS,
  MODE_LETTERS,
  MODE_NAMES,
  MODE_OVERRIDES,
  SUITE_BASELINES,
  SUITE_DESCRIPTIONS,
  type RunOverrides,
} from "./suites";

/**
 * Markdown report (docs/BENCHMARKS.md) built only from recorded result files. When there are no
 * results, the report says so and shows no numbers.
 */

export interface ReportOptions {
  /** Display names for `files`, by index (usually the file names). */
  names?: readonly string[];
  /** Files that could not be read, shown so nothing disappears silently. */
  skipped?: readonly { name: string; reason: string }[];
}

const NA = "n/a";
const E_LABEL = MODE_OVERRIDES.overclock.mode;
const C_LABEL = MODE_OVERRIDES.parallel.mode;
const D_LABEL = MODE_OVERRIDES.staged.mode;

// ---------------------------------------------------------------------------------------------
// Formatting

function fmtMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return NA;
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(ms)} ms`;
  if (abs < 120_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function fmtSignedMs(ms: number): string {
  if (!Number.isFinite(ms)) return NA;
  return `${ms > 0 ? "+" : ms < 0 ? "-" : "±"}${fmtMs(Math.abs(ms))}`;
}

function fmtPct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : NA;
}

function fmtSignedPct(x: number): string {
  if (!Number.isFinite(x)) return NA;
  return `${x > 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
}

function fmtPts(x: number): string {
  if (!Number.isFinite(x)) return NA;
  return `${x > 0 ? "+" : ""}${(x * 100).toFixed(1)} pts`;
}

function fmtNum(x: number, digits = 1): string {
  return Number.isFinite(x) ? x.toFixed(digits) : NA;
}

function fmtSignedNum(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return NA;
  return `${x > 0 ? "+" : ""}${x.toFixed(digits)}`;
}

function fmtUsd(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return NA;
  return Math.abs(x) < 1 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`;
}

function fmtSignedUsd(x: number): string {
  if (!Number.isFinite(x)) return NA;
  return `${x < 0 ? "-" : "+"}${fmtUsd(Math.abs(x))}`;
}

function fmtRatio(x: number | null): string {
  return x !== null && Number.isFinite(x) ? `${x.toFixed(2)}×` : NA;
}

function fmtInt(x: number): string {
  return Number.isFinite(x) ? String(Math.round(x)) : NA;
}

function scenarioName(template: string, seed: number): string {
  const short = /^t\d+/.exec(template)?.[0] ?? template;
  return `${short} seed ${seed}`;
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  return [`| ${headers.join(" | ")} |`, `|${headers.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)];
}

function p95Cell(r: AggregateRow): string {
  return r.wallMs.p95 === null ? `n/a (n=${r.n})` : fmtMs(r.wallMs.p95);
}

function firstVerifiedCell(r: AggregateRow): string {
  const base = fmtMs(r.firstVerifiedMs.median);
  return r.neverVerified > 0 ? `${base} (${r.neverVerified} never)` : base;
}

function machineName(m: BenchmarkResultFile["machine"]): string {
  return `${m.platform}, ${m.cpus} CPUs, ${m.memoryGb} GB, Node ${m.node}`;
}

function where(r: AggregateRow): string {
  return `${scenarioName(r.template, r.seed)}${r.holdout ? " (holdout)" : ""}, ${r.records} records, ${r.condition}, ${r.cache}, suite \`${r.suite}\``;
}

/** Everything that must match for two labels to be compared. */
function comparisonKey(r: AggregateRow): string {
  return [r.suite, r.template, r.seed, r.records, r.cache, r.condition, r.holdout ? "holdout" : "dev"].join("|");
}

function partition<T>(xs: readonly T[], key: (x: T) => string): T[][] {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const g = m.get(k);
    if (g) g.push(x);
    else m.set(k, [x]);
  }
  return [...m.values()];
}

function describeOverrides(o: RunOverrides): string {
  const parts: string[] = [`mode ${o.mode ?? "default"}`];
  if (o.intelligence) parts.push(`intelligence ${o.intelligence}`);
  if (o.concurrency) parts.push(`concurrency ${o.concurrency}`);
  if (o.maxWorkers !== undefined) parts.push(`max ${o.maxWorkers} workers`);
  if (o.initialWorkers !== undefined) parts.push(`initial ${o.initialWorkers}`);
  if (o.useJev === false) parts.push("JEV off");
  for (const [k, v] of Object.entries(o.ablation ?? {})) if (v === false) parts.push(`${k} off`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------------------------
// Cold-start headline: E vs C and E vs D on matched groups.

interface HeadToHead {
  e: AggregateRow;
  other: AggregateRow;
  otherName: string;
}

function headToHeads(rows: readonly AggregateRow[]): HeadToHead[] {
  const out: HeadToHead[] = [];
  const candidates = rows.filter((r) => r.cache === "cold" && (r.label === E_LABEL || r.label === C_LABEL || r.label === D_LABEL));
  for (const group of partition(candidates, comparisonKey)) {
    const e = group.find((r) => r.label === E_LABEL);
    if (!e || e.n === 0) continue;
    for (const [label, name] of [
      [C_LABEL, "C"],
      [D_LABEL, "D"],
    ] as const) {
      const other = group.find((r) => r.label === label);
      if (other && comparable(e, other).ok) out.push({ e, other, otherName: name });
    }
  }
  return out;
}

function headToHeadTable(h2h: readonly HeadToHead[]): string[] {
  return table(
    ["Scenario", "Records", "Condition", "Suite", "Comparison", "n (E / other)", "Median wall", "Wall speedup", "Median first verified", "Accuracy median", "Cost/run median"],
    h2h.map(({ e, other, otherName }) => {
      const s = computeSpeedup(other, e);
      return [
        scenarioName(e.template, e.seed),
        String(e.records),
        e.condition,
        `\`${e.suite}\``,
        `E vs ${otherName}`,
        `${e.n} / ${other.n}`,
        `${fmtMs(e.wallMs.median)} vs ${fmtMs(other.wallMs.median)}`,
        s.ok ? fmtRatio(s.value.wallRatio) : NA,
        `${firstVerifiedCell(e)} vs ${firstVerifiedCell(other)}`,
        `${fmtPct(e.accuracy.median)} vs ${fmtPct(other.accuracy.median)}`,
        `${fmtUsd(e.costUsd.median)} vs ${fmtUsd(other.costUsd.median)}`,
      ];
    }),
  );
}

/** Plain-language verdicts, including every case where E is not faster. */
function headToHeadVerdicts(h2h: readonly HeadToHead[]): string[] {
  const out: string[] = [];
  for (const { e, other, otherName } of h2h) {
    const ctx = `${scenarioName(e.template, e.seed)}${e.holdout ? " (holdout)" : ""}, ${e.records} records, ${e.condition} (n=${e.n} vs ${other.n})`;
    const ratio = other.wallMs.median / e.wallMs.median;
    if (e.wallMs.median < other.wallMs.median) out.push(`E is faster than ${otherName} on ${ctx}: ${fmtMs(e.wallMs.median)} vs ${fmtMs(other.wallMs.median)} median wall (${fmtRatio(ratio)}).`);
    else out.push(`**E is not faster than ${otherName}** on ${ctx}: ${fmtMs(e.wallMs.median)} vs ${fmtMs(other.wallMs.median)} median wall (${fmtRatio(ratio)}).`);
    const ef = e.firstVerifiedMs.median;
    const of = other.firstVerifiedMs.median;
    if (ef !== null && of !== null && ef >= of) out.push(`**E does not reach its first verified action sooner than ${otherName}** on ${ctx}: ${fmtMs(ef)} vs ${fmtMs(of)}.`);
    if (e.accuracy.median < other.accuracy.median) out.push(`**E is less accurate than ${otherName}** on ${ctx}: ${fmtPct(e.accuracy.median)} vs ${fmtPct(other.accuracy.median)} median accuracy.`);
  }
  return out;
}

function coldStartSection(rows: readonly AggregateRow[]): string[] {
  const L: string[] = ["## Cold start", ""];
  L.push(
    "The headline comparison: E (`overclock`, streaming) against C (`compiled-parallel`, fixed 8 workers) and D (`overclock-staged`, the same swarm but stage-gated). Every run is cold, and wall time starts when the instruction is submitted, so it includes discovery and planning. Pairs are formed only within one suite and only when template, seed, records, condition, and cache state all match.",
    "",
  );
  const h2h = headToHeads(rows.filter((r) => !r.holdout));
  if (!h2h.length) {
    L.push("No matched E vs C or E vs D groups yet.", "");
    return L;
  }
  L.push(...headToHeadTable(h2h), "");
  for (const v of headToHeadVerdicts(h2h)) L.push(`- ${v}`);
  L.push("");
  return L;
}

// ---------------------------------------------------------------------------------------------
// Aggregate tables

function aggregateTable(rows: readonly AggregateRow[]): string[] {
  return table(
    ["Label", "Scenario", "Records", "n", "Failed", "Wall median", "Wall p95", "First verified", "Accuracy median (min)", "Engine-verified", "Correct/min", "Cost/run", "Cost/correct", "Model calls", "Tokens", "Utilization"],
    rows.map((r) => [
      `\`${r.label}\``,
      scenarioName(r.template, r.seed),
      String(r.records),
      String(r.n),
      String(r.failedRuns),
      fmtMs(r.wallMs.median),
      p95Cell(r),
      firstVerifiedCell(r),
      `${fmtPct(r.accuracy.median)} (${fmtPct(r.accuracy.min)})`,
      fmtPct(r.verifiedPct.median),
      fmtNum(r.correctPerMin.median),
      fmtUsd(r.costUsd.median),
      fmtUsd(r.costPerCorrectUsd),
      fmtInt(r.modelCalls.median),
      fmtInt(r.tokens.median),
      fmtPct(r.utilization.median),
    ]),
  );
}

/** Tables split by cache state and condition, each reported separately. */
function splitTables(rows: readonly AggregateRow[]): string[] {
  const L: string[] = [];
  const conditions = [...new Set(rows.map((r) => r.condition))].sort((a, b) => conditionOrder(a) - conditionOrder(b) || a.localeCompare(b));
  for (const cache of ["cold", "warm"] as const) {
    for (const condition of conditions) {
      const part = rows.filter((r) => r.cache === cache && r.condition === condition);
      if (!part.length) continue;
      const title = cache === "cold" ? `**Cold start, ${condition}**` : `**Warm start, ${condition}** (cache reuse; not comparable with cold runs)`;
      L.push(title, "", ...aggregateTable(part), "");
    }
  }
  return L;
}

function conditionOrder(c: string): number {
  const i = (CONDITION_NAMES as readonly string[]).indexOf(c);
  return i === -1 ? CONDITION_NAMES.length : i;
}

function suiteSection(suite: string, rows: readonly AggregateRow[]): string[] {
  const L: string[] = [`### Suite \`${suite}\``, ""];
  const desc = SUITE_DESCRIPTIONS[baseSuite(suite)];
  if (desc) L.push(desc, "");
  L.push(...splitTables(rows));
  return L;
}

function holdoutSection(rows: readonly AggregateRow[], files: readonly BenchmarkResultFile[]): string[] {
  const L: string[] = ["## Holdout", ""];
  const holdout = rows.filter((r) => r.holdout);
  if (!holdout.length) {
    L.push(`No holdout results yet. Holdout runs start only when \`${HOLDOUT_FREEZE_ENV}\` names a code-freeze identifier.`, "");
    return L;
  }
  const freezes = [...new Set(files.flatMap((f) => f.notes.filter((n) => n.startsWith("Holdout code freeze:"))))];
  L.push("Scenarios never used during development. These numbers are the best evidence of how the system generalizes.", "");
  if (freezes.length) {
    for (const f of freezes) L.push(`- ${f}`);
    L.push("");
  }
  for (const [suite, suiteRows] of groupBySuite(holdout)) {
    L.push(`### Suite \`${suite}\``, "", ...splitTables(suiteRows));
  }
  const h2h = headToHeads(holdout);
  if (h2h.length) {
    L.push("**E vs C and E vs D on holdout scenarios**", "", ...headToHeadTable(h2h), "");
    for (const v of headToHeadVerdicts(h2h)) L.push(`- ${v}`);
    L.push("");
  }
  return L;
}

// ---------------------------------------------------------------------------------------------
// Speedups against each suite's baseline

/** Baseline for a comparable group: the first preferred label present with completed runs. */
function pickBaseline(suite: string, rows: readonly AggregateRow[]): AggregateRow | undefined {
  const prefs = SUITE_BASELINES[baseSuite(suite)] ?? SUITE_BASELINES.all ?? [];
  for (const label of prefs) {
    const row = rows.find((r) => r.label === label && r.n > 0);
    if (row) return row;
  }
  return undefined;
}

interface SuiteSpeedups {
  suite: string;
  speedups: Speedup[];
  refused: string[];
}

function suiteSpeedups(suite: string, rows: readonly AggregateRow[]): SuiteSpeedups {
  const out: SuiteSpeedups = { suite, speedups: [], refused: [] };
  for (const group of partition(rows, comparisonKey)) {
    const base = pickBaseline(suite, group);
    if (!base) continue;
    for (const r of group) {
      if (r === base) continue;
      const s = computeSpeedup(base, r);
      if (s.ok) out.speedups.push(s.value);
      else out.refused.push(`\`${r.label}\` vs \`${base.label}\` (${where(r)}): ${s.reason}`);
    }
  }
  return out;
}

function findRow(rows: readonly AggregateRow[], suite: string, label: string, sp: Speedup): AggregateRow | undefined {
  return rows.find(
    (r) => r.suite === suite && r.label === label && r.records === sp.records && r.cache === sp.cache && r.condition === sp.condition && r.holdout === sp.holdout && r.template === sp.template && r.seed === sp.seed,
  );
}

function speedupSection(all: readonly SuiteSpeedups[], rows: readonly AggregateRow[]): string[] {
  const L: string[] = ["## Speedups", ""];
  L.push("Each candidate is compared with its suite's baseline on the same scenario, record count, cache state, condition, and holdout status. Pairs that do not match are not compared.", "");
  let any = false;
  for (const s of all) {
    if (!s.speedups.length && !s.refused.length) continue;
    any = true;
    L.push(`### Suite \`${s.suite}\``, "");
    if (s.speedups.length) {
      L.push(
        ...table(
          ["Scenario", "Records", "Condition", "Cache", "Baseline (n)", "Candidate (n)", "Baseline median", "Candidate median", "Wall-time speedup", "First-verified speedup", "Correct/min ratio"],
          s.speedups.map((sp) => [
            scenarioName(sp.template, sp.seed) + (sp.holdout ? " (holdout)" : ""),
            String(sp.records),
            sp.condition,
            sp.cache,
            `\`${sp.baseline}\` (${sp.nBaseline})`,
            `\`${sp.candidate}\` (${sp.nCandidate})`,
            fmtMs(findRow(rows, s.suite, sp.baseline, sp)?.wallMs.median ?? NaN),
            fmtMs(findRow(rows, s.suite, sp.candidate, sp)?.wallMs.median ?? NaN),
            fmtRatio(sp.wallRatio),
            fmtRatio(sp.firstVerifiedRatio),
            fmtRatio(sp.correctPerMinRatio),
          ]),
        ),
        "",
      );
    }
    if (s.refused.length) {
      L.push("Not compared:", "");
      for (const r of s.refused) L.push(`- ${r}`);
      L.push("");
    }
  }
  if (!any) L.push("No suite has two comparable labels with completed runs yet.", "");
  return L;
}

// ---------------------------------------------------------------------------------------------
// Parallel scaling

interface ScalingPoint {
  row: AggregateRow;
  workers: number;
  speedup: number | null;
  efficiency: number | null;
}

function scalingPoints(rows: readonly AggregateRow[]): ScalingPoint[][] {
  const scaling = rows.filter((r) => baseSuite(r.suite) === "scaling" && r.maxWorkers !== null);
  return partition(scaling, comparisonKey).map((group) => {
    const sorted = [...group].sort((a, b) => (a.maxWorkers ?? 0) - (b.maxWorkers ?? 0));
    const one = sorted.find((r) => r.maxWorkers === 1 && r.n > 0);
    return sorted.map((row) => {
      const workers = row.maxWorkers ?? 0;
      const s = one && row !== one ? computeSpeedup(one, row) : null;
      const speedup = row === one ? 1 : s?.ok ? s.value.wallRatio : null;
      return { row, workers, speedup, efficiency: speedup !== null && workers > 0 ? speedup / workers : null };
    });
  });
}

function scalingSection(curves: readonly ScalingPoint[][]): string[] {
  const L: string[] = ["## Parallel scaling", ""];
  if (!curves.length) {
    L.push("No `scaling` suite results yet.", "");
    return L;
  }
  L.push(
    "Same compiled-parallel mode and single-planner intelligence at every point; only the fixed worker count changes. This isolates parallelism from compiler effects. Speedup is relative to the 1-worker median; efficiency = speedup ÷ workers.",
    "",
  );
  for (const curve of curves) {
    const first = curve[0];
    if (!first) continue;
    L.push(`### ${where(first.row)}`, "");
    L.push(
      ...table(
        ["Workers", "n", "Failed", "Wall median", "Wall p95", "Speedup vs 1 worker", "Efficiency", "Accuracy median", "Correct/min"],
        curve.map((p) => [
          String(p.workers),
          String(p.row.n),
          String(p.row.failedRuns),
          fmtMs(p.row.wallMs.median),
          p95Cell(p.row),
          fmtRatio(p.speedup),
          p.efficiency === null ? NA : fmtPct(p.efficiency),
          fmtPct(p.row.accuracy.median),
          fmtNum(p.row.correctPerMin.median),
        ]),
      ),
      "",
    );
  }
  return L;
}

// ---------------------------------------------------------------------------------------------
// Ablations

interface AblationDelta {
  suite: string;
  component: string;
  measuredBy: "addition" | "removal";
  without: AggregateRow;
  with: AggregateRow;
}

function ablationDeltas(rows: readonly AggregateRow[]): { deltas: AblationDelta[]; missing: string[] } {
  const deltas: AblationDelta[] = [];
  const missing: string[] = [];
  const ablationRows = rows.filter((r) => baseSuite(r.suite) === "ablations");
  for (const group of partition(ablationRows, comparisonKey)) {
    for (const rung of ABLATION_RUNGS) {
      const { compareTo, component, measuredBy } = rung;
      if (!compareTo || !component || !measuredBy) continue;
      const self = group.find((r) => r.label === ablationLabel(rung.name));
      const other = group.find((r) => r.label === ablationLabel(compareTo));
      if (!self || !other) {
        if (self || other) missing.push(`${component}: \`${ablationLabel(self ? compareTo : rung.name)}\` has no runs in this group`);
        continue;
      }
      const c = comparable(self, other);
      if (!c.ok) {
        missing.push(`${component}: ${c.reason}`);
        continue;
      }
      const [without, withC] = measuredBy === "addition" ? [other, self] : [self, other];
      deltas.push({ suite: self.suite, component, measuredBy, without, with: withC });
    }
  }
  return { deltas, missing };
}

function ablationSection(deltas: readonly AblationDelta[], missing: readonly string[]): string[] {
  const L: string[] = ["## Ablation deltas", ""];
  if (!deltas.length && !missing.length) {
    L.push("No `ablations` suite results yet.", "");
    return L;
  }
  L.push(
    "Each row is one component's marginal effect: the rung without it versus the rung with it. Ladder rungs add one component to the previous rung; the remaining components are measured by removing them from the full system (E). Negative Δ wall means the component made runs faster.",
    "",
  );
  if (deltas.length) {
    L.push(
      ...table(
        ["Component", "Measured by", "Without → with (n)", "Wall median without → with", "Δ wall", "Δ first verified", "Δ accuracy", "Δ correct/min", "Δ cost/run"],
        deltas.map((d) => {
          const dWall = d.with.wallMs.median - d.without.wallMs.median;
          const fw = d.with.firstVerifiedMs.median;
          const fo = d.without.firstVerifiedMs.median;
          return [
            d.component,
            d.measuredBy,
            `\`${d.without.label}\` (${d.without.n}) → \`${d.with.label}\` (${d.with.n})`,
            `${fmtMs(d.without.wallMs.median)} → ${fmtMs(d.with.wallMs.median)}`,
            `${fmtSignedMs(dWall)} (${fmtSignedPct(dWall / d.without.wallMs.median)})`,
            fw !== null && fo !== null ? fmtSignedMs(fw - fo) : NA,
            fmtPts(d.with.accuracy.median - d.without.accuracy.median),
            fmtSignedNum(d.with.correctPerMin.median - d.without.correctPerMin.median),
            fmtSignedUsd(d.with.costUsd.median - d.without.costUsd.median),
          ];
        }),
      ),
      "",
    );
  }
  if (missing.length) {
    L.push("Not measured:", "");
    for (const m of missing) L.push(`- ${m}`);
    L.push("");
  }
  return L;
}

// ---------------------------------------------------------------------------------------------
// Where time goes, and write safety

const STAGE_ORDER = ["discovery", "planning", "compilation", "critique", "probe", "execution", "optimization", "recovery"];
const STAGE_NAMES: Readonly<Record<string, string>> = {
  discovery: "Exploring",
  planning: "Planning",
  compilation: "Compiling",
  critique: "Critique",
  probe: "Probing",
  execution: "Executing",
  optimization: "Optimizing",
  recovery: "Recovering",
};

function stageRank(k: string): number {
  const i = STAGE_ORDER.indexOf(k);
  return i === -1 ? STAGE_ORDER.length : i;
}

function timeSection(rows: readonly AggregateRow[]): string[] {
  const L: string[] = ["## Where time goes", ""];
  const withRuns = rows.filter((r) => r.n > 0);
  if (!withRuns.length) {
    L.push("No completed runs yet.", "");
    return L;
  }
  const staged = withRuns.filter((r) => r.stageRuns > 0);
  const share = (ms: number | undefined, wall: number) => (ms === undefined ? "—" : wall > 0 && Number.isFinite(ms) ? `${fmtMs(ms)} (${fmtPct(ms / wall)})` : fmtMs(ms));
  const lead = (r: AggregateRow) => [`\`${r.suite}\``, `\`${r.label}\``, scenarioName(r.template, r.seed) + (r.holdout ? " (holdout)" : ""), String(r.records), r.condition, r.cache];
  if (staged.length) {
    const keys = [...new Set(staged.flatMap((r) => Object.keys(r.stageMs)))].sort((a, b) => stageRank(a) - stageRank(b) || a.localeCompare(b));
    L.push(
      "Median time per pipeline stage from the engine summary (`stageMs`), with each as a share of the median wall time. Stages can overlap in streaming mode, so shares can add up to more than 100%; overlap is the time thinking stages ran alongside browser execution. Recovery time is the summary's total recovery time. A dash means the stage did not appear in that group's runs.",
      "",
    );
    L.push(
      ...table(
        ["Suite", "Label", "Scenario", "Records", "Condition", "Cache", "n", "Wall median", ...keys.map((k) => STAGE_NAMES[k] ?? k), "Recovery time", "Overlap"],
        staged.map((r) => [
          ...lead(r),
          String(r.stageRuns),
          fmtMs(r.wallMs.median),
          ...keys.map((k) => share(r.stageMs[k], r.wallMs.median)),
          share(r.recoveryMs.median, r.wallMs.median),
          share(r.overlapMs.median, r.wallMs.median),
        ]),
      ),
      "",
    );
  }
  const unstaged = withRuns.filter((r) => r.stageRuns === 0 && r.label !== EXTERNAL_LABEL);
  if (unstaged.length) {
    L.push(
      staged.length
        ? "Groups whose runs reported no per-stage times, from the summary's discovery, compile, and execution fields:"
        : "No run reported per-stage times (`stageMs`). Medians of the summary's discovery, compile, and execution fields instead:",
      "",
    );
    L.push(
      ...table(
        ["Suite", "Label", "Scenario", "Records", "Condition", "Cache", "n", "Wall median", "Discovery", "Compile", "Execution", "Recovery time", "Overlap"],
        unstaged.map((r) => [
          ...lead(r),
          String(r.n),
          fmtMs(r.wallMs.median),
          share(r.phaseMs.discovery, r.wallMs.median),
          share(r.phaseMs.compile, r.wallMs.median),
          share(r.phaseMs.execution, r.wallMs.median),
          share(r.recoveryMs.median, r.wallMs.median),
          share(r.overlapMs.median, r.wallMs.median),
        ]),
      ),
      "",
    );
  }
  return L;
}

function writeSafetySection(rows: readonly AggregateRow[]): string[] {
  const L: string[] = ["## Duplicate and incorrect writes", ""];
  const checked = rows.filter((r) => r.writes.checkedRuns > 0);
  if (!checked.length) {
    L.push("No runs have a checker result yet.", "");
    return L;
  }
  L.push(
    "Totals from the arena checker over every run with a checker result, including failed runs, because damage counts either way. Incorrect records = total − correct. Duplicate writes are append-only side effects applied more than once; collateral writes changed entities the task never asked to change. Verified-but-wrong records were reported VERIFIED and skipped-but-wrong records were reported SKIPPED (no change needed), but the checker marks them incorrect. The rest of the incorrect records were reported FAILED or UNCONFIRMED.",
    "",
  );
  L.push(
    ...table(
      ["Suite", "Label", "Scenario", "Records", "Condition", "Cache", "Runs checked", "Incorrect records", "Duplicate writes", "Collateral writes", "Verified-but-wrong", "Skipped-but-wrong"],
      checked.map((r) => [
        `\`${r.suite}\``,
        `\`${r.label}\``,
        scenarioName(r.template, r.seed) + (r.holdout ? " (holdout)" : ""),
        String(r.records),
        r.condition,
        r.cache,
        String(r.writes.checkedRuns),
        String(r.writes.incorrectRecords),
        String(r.writes.duplicateWrites),
        String(r.writes.collateralWrites),
        String(r.verifiedButWrong),
        r.skippedButWrong === null ? NA : String(r.skippedButWrong),
      ]),
    ),
    "",
  );
  return L;
}

// ---------------------------------------------------------------------------------------------
// Limitations

function limitations(
  files: readonly BenchmarkResultFile[],
  names: readonly string[],
  rows: readonly AggregateRow[],
  speedups: readonly SuiteSpeedups[],
  curves: readonly ScalingPoint[][],
  deltas: readonly AblationDelta[],
): string[] {
  const L: string[] = ["## Limitations", ""];
  const found: string[] = [];

  found.push(...headToHeadVerdicts(headToHeads(rows)).filter((v) => v.startsWith("**")));

  for (const s of speedups) {
    for (const sp of s.speedups) {
      const base = findRow(rows, s.suite, sp.baseline, sp);
      const cand = findRow(rows, s.suite, sp.candidate, sp);
      if (!base || !cand) continue;
      if (sp.wallRatio < 1) {
        found.push(`**\`${sp.candidate}\` is slower than \`${sp.baseline}\`** on ${where(cand)}: median wall ${fmtMs(cand.wallMs.median)} vs ${fmtMs(base.wallMs.median)} (${fmtRatio(sp.wallRatio)}; n=${sp.nCandidate} vs ${sp.nBaseline}).`);
      }
      if (cand.accuracy.median < base.accuracy.median) {
        found.push(`**\`${sp.candidate}\` is less accurate than \`${sp.baseline}\`** on ${where(cand)}: median accuracy ${fmtPct(cand.accuracy.median)} vs ${fmtPct(base.accuracy.median)} (n=${sp.nCandidate} vs ${sp.nBaseline}).`);
      }
    }
  }

  for (const d of deltas) {
    const verb = d.measuredBy === "addition" ? "Adding" : "Keeping";
    if (d.with.wallMs.median > d.without.wallMs.median) {
      found.push(`**${verb} ${d.component} made runs slower** (${where(d.with)}): median wall ${fmtMs(d.with.wallMs.median)} with it vs ${fmtMs(d.without.wallMs.median)} without.`);
    }
    if (d.with.accuracy.median < d.without.accuracy.median) {
      found.push(`**${verb} ${d.component} lowered accuracy** (${where(d.with)}): median ${fmtPct(d.with.accuracy.median)} with it vs ${fmtPct(d.without.accuracy.median)} without.`);
    }
  }

  for (const curve of curves) {
    for (let i = 1; i < curve.length; i++) {
      const prev = curve[i - 1]!;
      const cur = curve[i]!;
      if (prev.row.n > 0 && cur.row.n > 0 && cur.row.wallMs.median > prev.row.wallMs.median) {
        found.push(`**More workers made runs slower**: ${cur.workers} workers took ${fmtMs(cur.row.wallMs.median)} median vs ${fmtMs(prev.row.wallMs.median)} with ${prev.workers} (${where(cur.row)}).`);
      }
    }
    for (const p of curve) {
      if (p.efficiency !== null && p.workers > 1 && p.efficiency < 0.5) {
        found.push(`Parallel efficiency at ${p.workers} workers is ${fmtPct(p.efficiency)} (speedup ${fmtRatio(p.speedup)} over 1 worker; ${where(p.row)}).`);
      }
    }
  }

  for (const r of rows) {
    if (r.skippedButWrong !== null && r.skippedButWrong > 0) found.push(`\`${r.label}\` reported ${r.skippedButWrong} incorrect record${r.skippedButWrong === 1 ? "" : "s"} as SKIPPED (no change needed): a wrong decision, not a failed write (${where(r)}).`);
    if (r.verifiedButWrong > 0) found.push(`**\`${r.label}\` reported ${r.verifiedButWrong} record${r.verifiedButWrong === 1 ? "" : "s"} as VERIFIED that the checker marks incorrect** (${where(r)}).`);
    if (r.writes.duplicateWrites > 0) found.push(`**\`${r.label}\` made ${r.writes.duplicateWrites} duplicate write${r.writes.duplicateWrites === 1 ? "" : "s"}** across ${r.writes.checkedRuns} checked runs (${where(r)}).`);
    if (r.writes.collateralWrites > 0) found.push(`**\`${r.label}\` made ${r.writes.collateralWrites} collateral write${r.writes.collateralWrites === 1 ? "" : "s"}** across ${r.writes.checkedRuns} checked runs (${where(r)}).`);
    if (r.failedRuns > 0) found.push(`\`${r.label}\`: ${r.failedRuns} of ${r.attempted} runs failed and are excluded from its medians (${where(r)}).`);
  }

  // Holdout vs development accuracy for the same label, record count, condition, and cache state.
  for (const h of rows.filter((r) => r.holdout && r.n > 0)) {
    for (const d of rows.filter((r) => !r.holdout && r.n > 0 && r.label === h.label && r.records === h.records && r.cache === h.cache && r.condition === h.condition)) {
      if (h.accuracy.median < d.accuracy.median) {
        found.push(
          `**\`${h.label}\` is less accurate on holdout** ${scenarioName(h.template, h.seed)} (${fmtPct(h.accuracy.median)}) than on development ${scenarioName(d.template, d.seed)} (${fmtPct(d.accuracy.median)}), ${h.records} records, ${h.condition}. Templates or seeds differ, so this is not a controlled comparison.`,
        );
      }
    }
  }

  files.forEach((f, i) => {
    for (const note of f.notes) if (/not executed|skipped|interrupted/i.test(note)) found.push(`\`${names[i] ?? f.suite}\`: ${note}`);
  });

  const machinesBySuite = new Map<string, Set<string>>();
  for (const f of files) {
    if (!f.runs.length) continue;
    const set = machinesBySuite.get(f.suite) ?? new Set<string>();
    set.add(machineName(f.machine));
    machinesBySuite.set(f.suite, set);
  }
  for (const [suite, set] of machinesBySuite) {
    if (set.size > 1) found.push(`Suite \`${suite}\` pools runs from ${set.size} different machines (${[...set].join("; ")}), so machine differences are mixed into its medians.`);
  }

  const thin = rows.filter((r) => r.n > 0 && r.n < 3);
  if (thin.length) found.push(`${thin.length} group${thin.length === 1 ? " has" : "s have"} fewer than 3 completed runs; those medians are single observations or pairs, not stable estimates.`);

  if (found.length) for (const f of found) L.push(`- ${f}`);
  else L.push("- No measured configuration was slower or less accurate than its baseline in these results.");
  L.push(
    `- Groups with fewer than ${P95_MIN_N} completed runs have no p95.`,
    "- All results come from the local synthetic arena on the machine listed for each file. The realistic-latency condition injects latency into the arena apps; it does not reproduce real sites' authentication, rate limits, or UI variety.",
    "- Model latency and cost depend on the provider at run time, so reruns vary.",
    "- Warm-start results measure cache reuse. They are not evidence for the compiler or the scheduler.",
    "",
  );
  if (rows.some((r) => r.label === EXTERNAL_LABEL)) {
    L.push("- External-baseline wall time and model usage are reported by its adapter, not by the engine; it reports no time to first verified action.", "");
  }
  return L;
}

// ---------------------------------------------------------------------------------------------
// Methodology

function methodology(): string[] {
  const L: string[] = ["## Methodology", ""];
  L.push("### Modes", "");
  L.push(
    ...table(
      ["", "CLI mode", "Label", "Intelligence", "Concurrency", "Workers", "What it is"],
      MODE_NAMES.map((m) => {
        const o = MODE_OVERRIDES[m];
        const workers = o.initialWorkers !== undefined ? `${o.initialWorkers}–${o.maxWorkers ?? "?"}` : `up to ${o.maxWorkers ?? "engine default"}`;
        return [MODE_LETTERS[m], `\`${m}\``, `\`${o.mode}\``, o.intelligence ?? "—", o.concurrency ?? "—", workers, MODE_DESCRIPTIONS[m]];
      }),
    ),
  );
  L.push("");
  L.push(
    "Every run also sets `thumbnails: false` and `cache: \"cold\"` (or `\"warm\"` for warm-start runs). The optional `external` label runs an external browser-agent baseline through an adapter on the same scenario and is judged by the same checker.",
    "",
  );
  L.push("### What is measured", "");
  L.push(
    "- **Wall time** comes from the engine's run summary and starts when the instruction is submitted, so it includes discovery and planning. Per-stage times (`stageMs`), overlap, and recovery time also come from the summary.",
    "- **Time to first verified action** is the summary's `firstVerifiedMs`: time from submission until the first useful action was read back and verified. Runs that never verified anything are counted separately, not as a number.",
    "- **Accuracy** is the arena checker's `correctRecords / totalRecords`, read from `GET /api/check` immediately after the run completes. The checker holds ground truth the engine never sees, so accuracy never depends on what the engine claims. **Engine-verified** is the engine's own claim, shown for contrast.",
    "- **Correct records per minute** = checker-correct records ÷ wall minutes.",
    "- **Cost** is the reported model cost per run. **Cost per correct record** = total cost ÷ total checker-correct records over a group's completed runs.",
    "- **Model calls**, **tokens**, and **utilization** are engine-reported.",
    "- **Duplicate writes**, **collateral writes**, and **incorrect records** come from the checker. **Verified-but-wrong** counts records the engine reported `VERIFIED` that the checker marks incorrect. All should be 0.",
    "",
  );
  L.push("### Conditions", "");
  L.push("Each condition is applied through the arena variations API after the scenario is prepared and before the run starts. It is identical for every mode. Conditions are reported separately and never pooled.", "");
  for (const c of CONDITION_NAMES) L.push(`- \`${c}\`: ${CONDITION_DESCRIPTIONS[c]}`);
  L.push("");
  L.push("### Fairness controls", "");
  L.push(
    "- Every run starts from the same arena state. A cold run loads the scenario fresh (`POST /api/scenario` with the same seed, template, and record count). A warm run resets that same scenario (`POST /api/reset`). The variations are then set to the run's condition, with everything else at defaults.",
    "- Before each run, the harness checks that the arena serves the requested seed, template, and record count, and the same dataset (by hash) as earlier runs with that key. A mismatch fails the run instead of producing an incomparable number.",
    "- Every mode gets the same goal, applications, and records (built from the scenario). Only the mode overrides above differ. Thumbnails are off for all runs, and browser settings are the engine's own, identical for every mode.",
    "- Every mode is judged by the same success criteria: the arena checker.",
    "- Runs execute one at a time, never concurrently. Trials are interleaved across labels and the label order rotates per trial, so drift in model latency or machine load spreads evenly.",
    "- Runs are ordered by importance (E vs C vs D at 25 records under both conditions first), so a budget cut removes the least important runs.",
    "",
  );
  L.push("### Cold start and warm start", "");
  L.push(
    "Cold runs ignore cached app models and compiled programs. In the `all` suite, every cold E trial is followed immediately by a warm run on a reset of the same scenario, which may reuse what the cold run cached. Warm results appear in their own tables and are never compared with cold results: a warm speedup measures cache reuse, not the compiler or the scheduler.",
    "",
  );
  L.push("### Holdout", "");
  L.push(
    `Scenarios using ${HOLDOUT_TEMPLATES.map((t) => `\`${t}\``).join(" or ")}, or a seed of ${HOLDOUT_SEED_MIN} or more, are holdout scenarios, never used while developing prompts, heuristics, or the optimizer. The \`holdout\` suite runs E, D, and C on ${HOLDOUT_SCENARIOS.map((s) => `\`${s.template}\` seed ${s.seed}`).join(" and ")}, cold, under both conditions. The harness refuses to run any holdout scenario unless \`${HOLDOUT_FREEZE_ENV}\` names a code-freeze identifier, and records that identifier in the result file. Holdout results are reported in their own section.`,
    "",
  );
  L.push("### Ablations", "");
  L.push(
    ...table(
      ["Rung", "Config", "Compared with", "Isolates"],
      ABLATION_RUNGS.map((r) => [
        `\`${ablationLabel(r.name)}\``,
        describeOverrides(r.overrides),
        r.compareTo ? `\`${ablationLabel(r.compareTo)}\`` : "—",
        r.component ? `${r.component} (${r.measuredBy === "removal" ? "by removal" : "by addition"})` : "baseline",
      ]),
    ),
  );
  L.push("");
  L.push("### Budget", "");
  L.push(
    "Each invocation has a spend cap (default $50, set with `--budget` or `OVERCLOCK_BENCH_BUDGET_USD`). Once the cumulative reported model cost reaches the cap, no new runs start. Runs that were not executed are listed in the result file's notes; they are never estimated or filled in.",
    "",
  );
  L.push("### Statistics", "");
  L.push(
    "- `n` is the number of completed runs in a group. A run is failed when it errored, timed out, ended in a status other than `completed`, or is missing the checker result (or, for engine runs, the engine summary). Failed runs are counted separately and excluded from every median.",
    `- Medians are over completed runs. p95 uses linear interpolation and is shown only when n ≥ ${P95_MIN_N}; otherwise the cell reads "n/a (n=…)".`,
    "- Runs pool only when suite, label, scenario (template and seed), record count, cache state, condition, and holdout status all match.",
    "- Speedups compare labels only within one suite and only when scenario, record count, cache state, condition, and holdout status match. Wall-time speedup = baseline median ÷ candidate median (above 1 means the candidate is faster). Correct/min ratio = candidate median ÷ baseline median.",
    "- Parallel scaling is reported in its own section, separate from compiler effects.",
    "",
  );
  return L;
}

// ---------------------------------------------------------------------------------------------

function groupBySuite(rows: readonly AggregateRow[]): Map<string, AggregateRow[]> {
  const m = new Map<string, AggregateRow[]>();
  for (const r of rows) {
    const list = m.get(r.suite) ?? [];
    list.push(r);
    m.set(r.suite, list);
  }
  return m;
}

export function generateReport(files: readonly BenchmarkResultFile[], opts: ReportOptions = {}): string {
  const names = files.map((f, i) => opts.names?.[i] ?? `${new Date(f.createdAt).toISOString()} ${f.suite}`);
  const runs = files.flatMap((f) => f.runs);
  const L: string[] = ["# Overclock benchmarks", ""];

  if (!runs.length) {
    L.push(
      files.length
        ? `There ${files.length === 1 ? "is 1 result file" : `are ${files.length} result files`} in \`benchmarks/results/\`, but none contains an executed run, so this page reports no numbers.`
        : "No benchmark results yet. `benchmarks/results/` has no result files, so this page reports no numbers.",
      "",
      "To produce results, start the arena and engine (or pass `--spawn`) and run `pnpm benchmark:all`, or `tsx packages/benchmarks/src/cli.ts --suite <all|ablations|intelligence|scaling|holdout>`. Regenerate this page with `tsx packages/benchmarks/src/cli.ts --report`.",
      "",
    );
  } else {
    const failed = runs.filter(isFailedRun).length;
    const latest = Math.max(...files.map((f) => f.createdAt));
    L.push(
      `Generated from ${files.length} result file${files.length === 1 ? "" : "s"} with ${runs.length} executed run${runs.length === 1 ? "" : "s"} (${failed} failed). Latest result file: ${new Date(latest).toISOString()}.`,
      "",
      "Every number on this page comes from an executed run recorded in `benchmarks/results/`. Nothing is estimated, extrapolated, or filled in.",
      "",
    );
  }

  if (opts.skipped?.length) {
    L.push("Files that could not be read and are not included:", "");
    for (const s of opts.skipped) L.push(`- \`${s.name}\`: ${s.reason}`);
    L.push("");
  }

  if (runs.length) {
    const rows = aggregateRuns(runs);
    L.push(...coldStartSection(rows));
    L.push("## Results by suite", "");
    const dev = rows.filter((r) => !r.holdout);
    if (!dev.length) L.push("Only holdout runs so far; see the Holdout section.", "");
    for (const [suite, suiteRows] of groupBySuite(dev)) L.push(...suiteSection(suite, suiteRows));
    L.push(...holdoutSection(rows, files));
    const speedups = [...groupBySuite(rows)].map(([suite, suiteRows]) => suiteSpeedups(suite, suiteRows));
    L.push(...speedupSection(speedups, rows));
    const curves = scalingPoints(rows);
    L.push(...scalingSection(curves));
    const { deltas, missing } = ablationDeltas(rows);
    L.push(...ablationSection(deltas, missing));
    L.push(...timeSection(rows));
    L.push(...writeSafetySection(rows));
    L.push(...limitations(files, names, rows, speedups, curves, deltas));
  }

  if (files.length) {
    L.push("## Result files", "");
    L.push(
      ...table(
        ["File", "Suite", "Created", "Machine", "Runs", "Failed", "Spend / budget"],
        files.map((f, i) => [
          `\`${names[i] ?? ""}\``,
          `\`${f.suite}\``,
          new Date(f.createdAt).toISOString(),
          machineName(f.machine),
          String(f.runs.length),
          String(f.runs.filter(isFailedRun).length),
          `${fmtUsd(f.spentUsd)} / ${fmtUsd(f.budgetUsd)}`,
        ]),
      ),
      "",
    );
    const withNotes = files.map((f, i) => ({ f, name: names[i] ?? f.suite })).filter((x) => x.f.notes.length);
    if (withNotes.length) {
      L.push("Notes recorded by the harness:", "");
      for (const { f, name } of withNotes) for (const n of f.notes) L.push(`- \`${name}\`: ${n}`);
      L.push("");
    }
  }

  L.push(...methodology());
  return `${L.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------------------------
// Files

function isResultFile(v: unknown): v is BenchmarkResultFile {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.version === 1 && typeof o.suite === "string" && typeof o.createdAt === "number" && Array.isArray(o.runs) && Array.isArray(o.notes) && typeof o.machine === "object" && o.machine !== null;
}

export interface LoadedResults {
  files: BenchmarkResultFile[];
  names: string[];
  skipped: { name: string; reason: string }[];
}

/** Read every `*.json` result file directly inside `dir` (sorted by name). A missing dir is empty. */
export async function loadResultFiles(dir: string): Promise<LoadedResults> {
  const out: LoadedResults = { files: [], names: [], skipped: [] };
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }
  for (const name of entries.filter((e) => e.endsWith(".json")).sort()) {
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, name), "utf8"));
      if (!isResultFile(parsed)) {
        out.skipped.push({ name, reason: "not a version-1 BenchmarkResultFile" });
        continue;
      }
      out.files.push(parsed);
      out.names.push(name);
    } catch (err) {
      out.skipped.push({ name, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}

export async function writeReport(resultsDir: string, outPath: string): Promise<{ path: string; files: number; runs: number; skipped: number }> {
  const loaded = await loadResultFiles(resultsDir);
  const md = generateReport(loaded.files, { names: loaded.names, skipped: loaded.skipped });
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, md, "utf8");
  return { path: outPath, files: loaded.files.length, runs: loaded.files.reduce((a, f) => a + f.runs.length, 0), skipped: loaded.skipped.length };
}
