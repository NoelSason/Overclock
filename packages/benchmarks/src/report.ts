import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BenchmarkResultFile } from "@overclock/contracts";
import { aggregateRuns, comparable, computeSpeedup, isFailedRun, P95_MIN_N, type AggregateRow, type Speedup } from "./stats";
import {
  ABLATION_RUNGS,
  ablationLabel,
  baseSuite,
  HOLDOUT_SCENARIOS,
  HOLDOUT_SEED_MIN,
  HOLDOUT_TEMPLATE,
  MODE_DESCRIPTIONS,
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

function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return NA;
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

function machineName(m: BenchmarkResultFile["machine"]): string {
  return `${m.platform}, ${m.cpus} CPUs, ${m.memoryGb} GB, Node ${m.node}`;
}

function comparisonKey(r: AggregateRow): string {
  return [r.template, r.seed, r.records, r.cache, r.holdout ? "holdout" : "dev"].join("|");
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
  const parts: string[] = [`mode ${o.mode}`];
  if (o.intelligence) parts.push(`intelligence ${o.intelligence}`);
  if (o.concurrency) parts.push(`concurrency ${o.concurrency}`);
  if (o.maxWorkers !== undefined) parts.push(`max ${o.maxWorkers} workers`);
  if (o.initialWorkers !== undefined) parts.push(`initial ${o.initialWorkers}`);
  if (o.useJev === false) parts.push("JEV off");
  if (o.ablation?.competitiveSynthesis === false) parts.push("competitive synthesis off");
  return parts.join(", ");
}

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
      else out.refused.push(`${r.label} vs ${base.label} (${scenarioName(r.template, r.seed)}, ${r.records} records, ${r.cache}): ${s.reason}`);
    }
  }
  return out;
}

function methodology(): string[] {
  const L: string[] = [];
  L.push("## Methodology", "");
  L.push("### Modes", "");
  L.push(
    ...table(
      ["CLI mode", "Label", "Intelligence", "Concurrency", "Workers", "What it is"],
      MODE_NAMES.map((m) => {
        const o = MODE_OVERRIDES[m];
        const workers = o.initialWorkers !== undefined ? `${o.initialWorkers}–${o.maxWorkers ?? "?"}` : String(o.maxWorkers ?? "engine default");
        return [`\`${m}\``, `\`${o.mode}\``, o.intelligence ?? "—", o.concurrency ?? "—", workers, MODE_DESCRIPTIONS[m]];
      }),
    ),
  );
  L.push("");
  L.push("Every run also sets `thumbnails: false` and `cache: \"cold\"` (or `\"warm\"` for warm-start runs).", "");
  L.push("### What is measured", "");
  L.push(
    "- **Wall time**, plus discovery, compile, and execution time, come from the engine's run summary.",
    "- **Accuracy** is the arena checker's `correctRecords / totalRecords`, read from `GET /api/check` immediately after the run completes. The checker holds ground truth the engine never sees, so accuracy never depends on what the engine claims.",
    "- **Correct records per minute** = checker-correct records ÷ wall minutes.",
    "- **Cost** is the engine-reported model cost per run. **Cost per correct record** = total cost ÷ total checker-correct records over a group's completed runs.",
    "- **Model calls** and tokens are engine-reported.",
    "- **Verified-but-wrong** counts records the engine reported `VERIFIED` that the checker marks incorrect. It should be 0.",
    "",
  );
  L.push("### Fairness controls", "");
  L.push(
    "- Every run starts from the same arena state. A cold run loads the scenario fresh (`POST /api/scenario` with the same seed, template, and record count). A warm run resets that same scenario (`POST /api/reset`). Variations are set back to defaults before every run.",
    "- Before each run, the harness checks that the arena serves the requested seed, template, and record count, and the same dataset (by hash) as earlier runs with that key. A mismatch fails the run instead of producing an incomparable number.",
    "- Every mode gets the same goal, applications, and records (built from the scenario). Only the mode overrides above differ. Thumbnails are off for all runs, and browser settings are the engine's own, identical for every mode.",
    "- Every mode is judged by the same success criteria: the arena checker.",
    "- Runs execute one at a time, never concurrently. Trials are interleaved across labels (trial 1 of each label, then trial 2, …) so drift in model latency or machine load spreads evenly.",
    "",
  );
  L.push("### Cold start and warm start", "");
  L.push(
    "Cold runs ignore cached app models and compiled programs. In the `all` suite, every cold overclock trial is followed immediately by a warm run on a reset of the same scenario, which may reuse what the cold run cached. Warm results appear in their own tables and are never compared with cold results: a warm speedup measures cache reuse, not the compiler or the scheduler.",
    "",
  );
  L.push("### Holdout", "");
  L.push(
    `Scenarios using template \`${HOLDOUT_TEMPLATE}\` or a seed of ${HOLDOUT_SEED_MIN} or more are holdout scenarios, never used while developing prompts or heuristics. The \`holdout\` suite runs ${HOLDOUT_SCENARIOS.map((s) => `\`${s.template}\` seed ${s.seed}`).join(" and ")}. Holdout results are reported separately.`,
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
    "Each invocation has a spend cap (default $50, set with `--budget` or `OVERCLOCK_BENCH_BUDGET_USD`). Once the cumulative engine-reported model cost reaches the cap, no new runs start. Runs that were not executed are listed in the result file's notes; they are never estimated or filled in.",
    "",
  );
  L.push("### Statistics", "");
  L.push(
    "- `n` is the number of completed runs in a group. A run is failed when it errored, timed out, ended in a status other than `completed`, or is missing the engine summary or the checker result. Failed runs are counted separately and excluded from every median.",
    `- Medians are over completed runs. p95 uses linear interpolation and is shown only when n ≥ ${P95_MIN_N}; otherwise the cell reads "n/a (n=…)".`,
    "- Runs pool only when suite, label, scenario (template and seed), record count, cache state, and holdout status all match.",
    "- Speedups compare labels only within one suite and only when the scenario, record count, cache state, and holdout status match. Wall-time speedup = baseline median ÷ candidate median (above 1 means the candidate is faster). Correct/min ratio = candidate median ÷ baseline median.",
    "- Parallel scaling is reported in its own section, separate from compiler effects.",
    "",
  );
  return L;
}

function aggregateTable(rows: readonly AggregateRow[], showCache: boolean): string[] {
  const headers = ["Label", "Scenario", "Records", ...(showCache ? ["Cache"] : []), "n", "Failed", "Wall median", "Wall p95", "Accuracy median (min)", "Correct/min", "Cost/run", "Cost/correct", "Model calls", "Verified-but-wrong"];
  return table(
    headers,
    rows.map((r) => [
      `\`${r.label}\``,
      scenarioName(r.template, r.seed),
      String(r.records),
      ...(showCache ? [r.cache] : []),
      String(r.n),
      String(r.failedRuns),
      fmtMs(r.wallMs.median),
      p95Cell(r),
      `${fmtPct(r.accuracy.median)} (${fmtPct(r.accuracy.min)})`,
      fmtNum(r.correctPerMin.median),
      fmtUsd(r.costUsd.median),
      fmtUsd(r.costPerCorrectUsd),
      fmtNum(r.modelCalls.median, 0),
      String(r.verifiedButWrong),
    ]),
  );
}

function suiteSection(suite: string, rows: readonly AggregateRow[]): string[] {
  const L: string[] = [`### Suite \`${suite}\``, ""];
  const desc = SUITE_DESCRIPTIONS[baseSuite(suite)];
  if (desc) L.push(desc, "");
  const cold = rows.filter((r) => !r.holdout && r.cache === "cold");
  const warm = rows.filter((r) => !r.holdout && r.cache === "warm");
  const holdout = rows.filter((r) => r.holdout);
  if (cold.length) L.push("**Cold start**", "", ...aggregateTable(cold, false), "");
  if (warm.length) L.push("**Warm start** (cache reuse; not comparable with cold runs)", "", ...aggregateTable(warm, false), "");
  if (holdout.length) L.push("**Holdout scenarios**", "", ...aggregateTable(holdout, true), "");
  return L;
}

function speedupSection(all: readonly SuiteSpeedups[], rowsBySuite: ReadonlyMap<string, AggregateRow[]>): string[] {
  const L: string[] = ["## Speedups", ""];
  L.push("Each candidate is compared with the suite's baseline on the same scenario, record count, cache state, and holdout status. Pairs that do not match are not compared.", "");
  let any = false;
  for (const s of all) {
    if (!s.speedups.length && !s.refused.length) continue;
    any = true;
    L.push(`### Suite \`${s.suite}\``, "");
    if (s.speedups.length) {
      const rows = rowsBySuite.get(s.suite) ?? [];
      const find = (label: string, sp: Speedup) =>
        rows.find((r) => r.label === label && r.records === sp.records && r.cache === sp.cache && r.holdout === sp.holdout && r.template === sp.template && r.seed === sp.seed);
      L.push(
        ...table(
          ["Scenario", "Records", "Cache", "Baseline (n)", "Candidate (n)", "Baseline median", "Candidate median", "Wall-time speedup", "Correct/min ratio"],
          s.speedups.map((sp) => [
            scenarioName(sp.template, sp.seed) + (sp.holdout ? " (holdout)" : ""),
            String(sp.records),
            sp.cache,
            `\`${sp.baseline}\` (${sp.nBaseline})`,
            `\`${sp.candidate}\` (${sp.nCandidate})`,
            fmtMs(find(sp.baseline, sp)?.wallMs.median ?? NaN),
            fmtMs(find(sp.candidate, sp)?.wallMs.median ?? NaN),
            fmtRatio(sp.wallRatio),
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

interface ScalingPoint {
  row: AggregateRow;
  workers: number;
  speedup: number | null;
  efficiency: number | null;
}

function scalingPoints(rows: readonly AggregateRow[]): ScalingPoint[][] {
  const scaling = rows.filter((r) => baseSuite(r.suite) === "scaling" && r.maxWorkers !== null);
  return partition(scaling, (r) => `${r.suite}|${comparisonKey(r)}`).map((group) => {
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
    L.push(`### \`${first.row.suite}\`, ${scenarioName(first.row.template, first.row.seed)}, ${first.row.records} records, ${first.row.cache}`, "");
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
  for (const group of partition(ablationRows, (r) => `${r.suite}|${comparisonKey(r)}`)) {
    for (const rung of ABLATION_RUNGS) {
      if (!rung.compareTo || !rung.component || !rung.measuredBy) continue;
      const self = group.find((r) => r.label === ablationLabel(rung.name));
      const other = group.find((r) => r.label === ablationLabel(rung.compareTo!));
      if (!self || !other) {
        if (self || other) missing.push(`${rung.component}: \`${ablationLabel(self ? rung.compareTo : rung.name)}\` has no runs in this group`);
        continue;
      }
      const c = comparable(self, other);
      if (!c.ok) {
        missing.push(`${rung.component}: ${c.reason}`);
        continue;
      }
      const [without, withC] = rung.measuredBy === "addition" ? [other, self] : [self, other];
      deltas.push({ suite: self.suite, component: rung.component, measuredBy: rung.measuredBy, without, with: withC });
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
    "Each row is one component's marginal effect: the rung without it versus the rung with it. Ladder rungs add one component to the previous rung; JEV and competitive synthesis are measured by removing them from the full system. Negative Δ wall means the component made runs faster.",
    "",
  );
  if (deltas.length) {
    L.push(
      ...table(
        ["Component", "Measured by", "Without → with (n)", "Wall median without → with", "Δ wall", "Δ accuracy", "Δ correct/min", "Δ cost/run"],
        deltas.map((d) => {
          const dWall = d.with.wallMs.median - d.without.wallMs.median;
          return [
            d.component,
            d.measuredBy,
            `\`${d.without.label}\` (${d.without.n}) → \`${d.with.label}\` (${d.with.n})`,
            `${fmtMs(d.without.wallMs.median)} → ${fmtMs(d.with.wallMs.median)}`,
            `${fmtSignedMs(dWall)} (${fmtSignedPct(dWall / d.without.wallMs.median)})`,
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

function timeSection(rows: readonly AggregateRow[]): string[] {
  const L: string[] = ["## Where time goes", ""];
  const withRuns = rows.filter((r) => r.n > 0);
  if (!withRuns.length) {
    L.push("No completed runs yet.", "");
    return L;
  }
  L.push(
    "Median discovery, compile, and execution time from the engine summary, with each as a share of the median wall time. Medians are taken per phase, so the parts need not add up to the wall median. Unattributed time is the per-run median of wall − (discovery + compile + execution); a negative value means phases overlapped.",
    "",
  );
  const share = (ms: number, wall: number) => (wall > 0 && Number.isFinite(ms) ? `${fmtMs(ms)} (${fmtPct(ms / wall)})` : fmtMs(ms));
  L.push(
    ...table(
      ["Suite", "Label", "Scenario", "Records", "Cache", "n", "Wall median", "Discovery", "Compile", "Execution", "Unattributed"],
      withRuns.map((r) => [
        `\`${r.suite}\``,
        `\`${r.label}\``,
        scenarioName(r.template, r.seed) + (r.holdout ? " (holdout)" : ""),
        String(r.records),
        r.cache,
        String(r.n),
        fmtMs(r.wallMs.median),
        share(r.discoveryMs.median, r.wallMs.median),
        share(r.compileMs.median, r.wallMs.median),
        share(r.executionMs.median, r.wallMs.median),
        fmtSignedMs(r.unattributedMs.median),
      ]),
    ),
    "",
  );
  return L;
}

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
  const where = (r: AggregateRow) => `${scenarioName(r.template, r.seed)}${r.holdout ? " (holdout)" : ""}, ${r.records} records, ${r.cache}, suite \`${r.suite}\``;

  for (const s of speedups) {
    const rowsOf = rows.filter((r) => r.suite === s.suite);
    for (const sp of s.speedups) {
      const base = rowsOf.find((r) => r.label === sp.baseline && r.records === sp.records && r.cache === sp.cache && r.holdout === sp.holdout && r.template === sp.template && r.seed === sp.seed);
      const cand = rowsOf.find((r) => r.label === sp.candidate && r.records === sp.records && r.cache === sp.cache && r.holdout === sp.holdout && r.template === sp.template && r.seed === sp.seed);
      if (!base || !cand) continue;
      if (sp.wallRatio < 1) {
        found.push(
          `**\`${sp.candidate}\` is slower than \`${sp.baseline}\`** on ${where(cand)}: median wall ${fmtMs(cand.wallMs.median)} vs ${fmtMs(base.wallMs.median)} (${fmtRatio(sp.wallRatio)}; n=${sp.nCandidate} vs ${sp.nBaseline}).`,
        );
      }
      if (cand.accuracy.median < base.accuracy.median) {
        found.push(
          `**\`${sp.candidate}\` is less accurate than \`${sp.baseline}\`** on ${where(cand)}: median accuracy ${fmtPct(cand.accuracy.median)} vs ${fmtPct(base.accuracy.median)} (n=${sp.nCandidate} vs ${sp.nBaseline}).`,
        );
      }
    }
  }

  for (const d of deltas) {
    const verb = d.measuredBy === "addition" ? "Adding" : "Keeping";
    if (d.with.wallMs.median > d.without.wallMs.median) {
      found.push(`**${verb} ${d.component} made runs slower** (suite \`${d.suite}\`, ${d.with.records} records): median wall ${fmtMs(d.with.wallMs.median)} with it vs ${fmtMs(d.without.wallMs.median)} without.`);
    }
    if (d.with.accuracy.median < d.without.accuracy.median) {
      found.push(
        `**${verb} ${d.component} lowered accuracy** (suite \`${d.suite}\`, ${d.with.records} records): median ${fmtPct(d.with.accuracy.median)} with it vs ${fmtPct(d.without.accuracy.median)} without.`,
      );
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
    if (r.verifiedButWrong > 0) {
      found.push(`**\`${r.label}\` reported ${r.verifiedButWrong} record${r.verifiedButWrong === 1 ? "" : "s"} as VERIFIED that the checker marks incorrect** (${where(r)}).`);
    }
    if (r.failedRuns > 0) found.push(`\`${r.label}\`: ${r.failedRuns} of ${r.attempted} runs failed and are excluded from its medians (${where(r)}).`);
  }

  // Holdout vs development accuracy for the same label, record count, and cache state.
  for (const h of rows.filter((r) => r.holdout && r.n > 0)) {
    const dev = rows.filter((r) => !r.holdout && r.n > 0 && r.label === h.label && r.records === h.records && r.cache === h.cache);
    for (const d of dev) {
      if (h.accuracy.median < d.accuracy.median) {
        found.push(
          `**\`${h.label}\` is less accurate on holdout** ${scenarioName(h.template, h.seed)} (${fmtPct(h.accuracy.median)}) than on development ${scenarioName(d.template, d.seed)} (${fmtPct(d.accuracy.median)}), ${h.records} records. The templates or seeds differ, so this is not a controlled comparison.`,
        );
      }
    }
  }

  files.forEach((f, i) => {
    for (const note of f.notes) {
      if (/not executed|Skipped|Interrupted/i.test(note)) found.push(`${names[i] ?? f.suite}: ${note}`);
    }
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
    "- All results come from the local synthetic arena (three web apps on localhost) on the machine listed for each file. Real sites add network latency, authentication, and UI variety that these numbers do not capture.",
    "- Model latency and cost depend on the provider at run time, so reruns vary.",
    "- Warm-start results measure cache reuse. They are not evidence for the compiler or the scheduler.",
    "",
  );
  return L;
}

export function generateReport(files: readonly BenchmarkResultFile[], opts: ReportOptions = {}): string {
  const names = files.map((f, i) => opts.names?.[i] ?? `${new Date(f.createdAt).toISOString()} ${f.suite}`);
  const runs = files.flatMap((f) => f.runs);
  const L: string[] = ["# Overclock benchmarks", ""];

  if (!runs.length) {
    L.push(
      files.length
        ? `There are ${files.length} result file${files.length === 1 ? "" : "s"} in \`benchmarks/results/\`, but none contains an executed run, so this page reports no numbers.`
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

  if (runs.length) {
    const rows = aggregateRuns(runs);
    const rowsBySuite = new Map<string, AggregateRow[]>();
    for (const r of rows) {
      const list = rowsBySuite.get(r.suite) ?? [];
      list.push(r);
      rowsBySuite.set(r.suite, list);
    }
    L.push("## Results by suite", "");
    for (const [suite, suiteRows] of rowsBySuite) L.push(...suiteSection(suite, suiteRows));
    const speedups = [...rowsBySuite].map(([suite, suiteRows]) => suiteSpeedups(suite, suiteRows));
    L.push(...speedupSection(speedups, rowsBySuite));
    const curves = scalingPoints(rows);
    L.push(...scalingSection(curves));
    const { deltas, missing } = ablationDeltas(rows);
    L.push(...ablationSection(deltas, missing));
    L.push(...timeSection(rows));
    L.push(...limitations(files, names, rows, speedups, curves, deltas));
  }

  L.push(...methodology());
  return `${L.join("\n").trimEnd()}\n`;
}

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
