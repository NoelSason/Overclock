import { VariationConfig, type PublicScenario, type RunConfigInput, type TaskTemplateId } from "@overclock/contracts";

/**
 * Benchmark suite definitions. A suite expands into an ordered list of planned runs; the
 * harness executes them in that order and `--dry` prints them. Nothing here estimates cost or
 * time: those are only known once a run has executed.
 */

/** Per-run config overrides layered on top of `configFromScenario` (goal/apps/records come from the scenario). */
export type RunOverrides = Omit<Partial<RunConfigInput>, "goal" | "applications" | "records">;

export type ModeName = "sequential" | "compiled" | "parallel" | "staged" | "overclock";
export const MODE_NAMES: readonly ModeName[] = ["sequential", "compiled", "parallel", "staged", "overclock"];

type EngineOverrides = RunOverrides & Required<Pick<RunOverrides, "mode">>;

export const MODE_OVERRIDES: Readonly<Record<ModeName, EngineOverrides>> = {
  sequential: { mode: "sequential-agent", maxWorkers: 1 },
  compiled: { mode: "compiled-single", intelligence: "single-planner", concurrency: "fixed", maxWorkers: 1 },
  parallel: { mode: "compiled-parallel", intelligence: "single-planner", concurrency: "fixed", maxWorkers: 8, initialWorkers: 8 },
  staged: { mode: "overclock-staged", intelligence: "adaptive", concurrency: "adaptive", maxWorkers: 16 },
  overclock: { mode: "overclock", intelligence: "adaptive", concurrency: "adaptive", maxWorkers: 16 },
};

export const MODE_LETTERS: Readonly<Record<ModeName, string>> = { sequential: "A", compiled: "B", parallel: "C", staged: "D", overclock: "E" };

export const MODE_DESCRIPTIONS: Readonly<Record<ModeName, string>> = {
  sequential: "One model-driven browser agent works through the records one at a time, one model call per action. No compiler, no parallelism.",
  compiled: "A single planner compiles the task into a program; one worker executes it without per-step model calls.",
  parallel: "Same single-planner compiled program, executed by a fixed pool of 8 workers.",
  staged: "Full discovery swarm and adaptive concurrency, but stage-gated: discovery, planning, compilation, and execution run strictly one after another.",
  overclock: "Streaming discovery, incremental compilation, and online optimization: validated fragments start executing while discovery and planning continue.",
};

/** Record label for a mode: the engine's execution-mode name. */
export function modeLabel(mode: ModeName): string {
  return MODE_OVERRIDES[mode].mode;
}

/** Label of the optional external browser-agent baseline (runs outside the engine). */
export const EXTERNAL_LABEL = "external";

// ---------------------------------------------------------------------------------------------
// Conditions: app/network conditions set through the arena variations API before every run.

export type ConditionName = "local" | "realistic-latency";
export const CONDITION_NAMES: readonly ConditionName[] = ["local", "realistic-latency"];
export const REALISTIC_LATENCY = { baseMs: 150, jitterMs: 100, slowRate: 0.05, slowMs: 1200 } as const;

export const CONDITION_DESCRIPTIONS: Readonly<Record<ConditionName, string>> = {
  local: "No injected latency: the arena apps respond as fast as localhost allows.",
  "realistic-latency": `Every app in the scenario gets ${REALISTIC_LATENCY.baseMs} ms base latency ± ${REALISTIC_LATENCY.jitterMs} ms jitter, and ${REALISTIC_LATENCY.slowRate * 100}% of requests take an extra ${REALISTIC_LATENCY.slowMs} ms.`,
};

export function isConditionName(v: string): v is ConditionName {
  return (CONDITION_NAMES as readonly string[]).includes(v);
}

/**
 * Arena variations for a condition. Everything else stays at defaults. Latency applies to every
 * application the scenario lists, whatever its name.
 */
export function conditionVariations(condition: ConditionName, scenario: Pick<PublicScenario, "applications">): VariationConfig {
  const base = VariationConfig.parse({});
  if (condition === "local") return base;
  return { ...base, latency: Object.fromEntries(scenario.applications.map((a) => [a.name, { ...REALISTIC_LATENCY }])) };
}

// ---------------------------------------------------------------------------------------------
// Suites

export type SuiteName = "all" | "ablations" | "intelligence" | "scaling" | "holdout";
export const SUITE_NAMES: readonly SuiteName[] = ["all", "ablations", "intelligence", "scaling", "holdout"];
/** Suite name recorded for `--mode <m>` runs, so separate single-mode invocations pool together. */
export const MODES_SUITE = "modes";

export const SUITE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  modes: "Single-mode runs started with `--mode`. Runs from separate invocations pool here.",
  all: "Modes A–E on the same scenario under both conditions. E vs C vs D runs first, then B, A, and the external baseline when present, then one 100-record run per compiled mode. Every cold E trial is followed immediately by a warm-cache repeat.",
  ablations: "Components added one at a time (no swarm/no compiler → compiler → fixed parallelism → adaptive scheduling → full E), then single features removed from E: JEV, competitive synthesis, streaming, access paths, write canary, and online re-optimization.",
  intelligence: "Mode E with the intelligence layer fixed to single-planner, parallel-scout, or adaptive, at 10 and 50 records, to show where the scout swarm's overhead pays off.",
  scaling: "compiled-parallel at a fixed 1, 2, 4, 8, and 16 workers on 100 records. Isolates parallel scaling from compiler effects.",
  holdout: "E, D, and C on scenarios never used during development (t4-holdout seed 9101 on a structurally different app, and t3 seed 9001), cold, under both conditions. Runs only after a code freeze.",
};

export interface AblationRung {
  name: string;
  overrides: EngineOverrides;
  /** What this rung isolates, when compared against `compareTo`. */
  component?: string;
  compareTo?: string;
  /** "addition": this rung = compareTo + component. "removal": this rung = compareTo − component. */
  measuredBy?: "addition" | "removal";
}

const E = MODE_OVERRIDES.overclock;

export const ABLATION_RUNGS: readonly AblationRung[] = [
  { name: "no-swarm-no-compiler", overrides: MODE_OVERRIDES.sequential },
  { name: "compiler-only", overrides: MODE_OVERRIDES.compiled, component: "compiler", compareTo: "no-swarm-no-compiler", measuredBy: "addition" },
  { name: "compiler+fixed-parallel", overrides: MODE_OVERRIDES.parallel, component: "fixed parallelism (8 workers)", compareTo: "compiler-only", measuredBy: "addition" },
  {
    name: "compiler+adaptive-scheduling",
    overrides: { mode: "compiled-parallel", intelligence: "single-planner", concurrency: "adaptive", maxWorkers: 16 },
    component: "adaptive scheduling (up to 16 workers)",
    compareTo: "compiler+fixed-parallel",
    measuredBy: "addition",
  },
  { name: "full", overrides: E, component: "adaptive intelligence with streaming (full E)", compareTo: "compiler+adaptive-scheduling", measuredBy: "addition" },
  { name: "full-no-jev", overrides: { ...E, useJev: false }, component: "JEV reflex path", compareTo: "full", measuredBy: "removal" },
  { name: "full-no-competitive-synthesis", overrides: { ...E, ablation: { competitiveSynthesis: false } }, component: "competitive synthesis", compareTo: "full", measuredBy: "removal" },
  { name: "overclock-no-streaming", overrides: { ...E, ablation: { streaming: false } }, component: "streaming execution", compareTo: "full", measuredBy: "removal" },
  { name: "overclock-no-access-paths", overrides: { ...E, ablation: { accessPaths: false } }, component: "access-path substitution", compareTo: "full", measuredBy: "removal" },
  { name: "overclock-no-write-canary", overrides: { ...E, ablation: { writeCanary: false } }, component: "write canary", compareTo: "full", measuredBy: "removal" },
  { name: "overclock-no-online-reopt", overrides: { ...E, ablation: { onlineReoptimization: false } }, component: "online re-optimization", compareTo: "full", measuredBy: "removal" },
];

export function ablationLabel(name: string): string {
  return `ablation:${name}`;
}

export const INTELLIGENCE_MODES = ["single-planner", "parallel-scout", "adaptive"] as const;
export const INTELLIGENCE_RECORDS: readonly number[] = [10, 50];
export const SCALING_WORKERS: readonly number[] = [1, 2, 4, 8, 16];
export const SCALING_RECORDS = 100;
export const ALL_LARGE_RECORDS = 100;
export const HOLDOUT_SCENARIOS: readonly { template: TaskTemplateId; seed: number }[] = [
  { template: "t4-holdout", seed: 9101 },
  { template: "t3-crm-status-sync", seed: 9001 },
];
export const HOLDOUT_MODES: readonly ModeName[] = ["overclock", "staged", "parallel"];
export const HOLDOUT_TRIALS = 1;
export const HOLDOUT_SEED_MIN = 9000;
export const HOLDOUT_TEMPLATES: readonly TaskTemplateId[] = ["t3-crm-status-sync", "t4-holdout"];
/** Holdout runs refuse to start unless this env var names a code-freeze identifier. */
export const HOLDOUT_FREEZE_ENV = "OVERCLOCK_HOLDOUT_FROZEN";

export function isHoldout(template: TaskTemplateId, seed: number): boolean {
  return HOLDOUT_TEMPLATES.includes(template) || seed >= HOLDOUT_SEED_MIN;
}

/**
 * Baseline labels per suite, in order of preference. Speedups compare every other label in a
 * comparable group against the first baseline present in that group.
 */
export const SUITE_BASELINES: Readonly<Record<string, readonly string[]>> = {
  modes: ["sequential-agent", "compiled-single", "compiled-parallel"],
  all: ["sequential-agent", "compiled-single", "compiled-parallel"],
  holdout: ["compiled-parallel"],
  ablations: [ablationLabel("no-swarm-no-compiler"), ablationLabel("compiler-only")],
  intelligence: ["intelligence:single-planner"],
  scaling: ["scaling:workers=1"],
};

/** `--label` tags a suite as `<suite>@<tag>`; the base name drives baselines and descriptions. */
export function baseSuite(suite: string): string {
  const at = suite.indexOf("@");
  return at === -1 ? suite : suite.slice(0, at);
}

export function taggedSuite(base: string, tag: string | undefined): string {
  return tag ? `${base}@${tag}` : base;
}

export interface PlanOptions {
  records: number;
  trials: number;
  seed: number;
  template: TaskTemplateId;
  includeSequential100: boolean;
  /** Plan `external` baseline runs in the `all` suite (the CLI sets this only when the adapter loads). */
  includeExternal: boolean;
  /** Restrict conditions. Default: both for `all` and `holdout`, "local" elsewhere. */
  conditions?: readonly ConditionName[] | undefined;
  /** Optional experiment tag from `--label`. */
  tag?: string | undefined;
}

export const DEFAULT_PLAN_OPTIONS: PlanOptions = {
  records: 25,
  trials: 3,
  seed: 4242,
  template: "t1-order-reconcile",
  includeSequential100: false,
  includeExternal: false,
};

export interface PlannedRun {
  /** 0-based position in the plan. */
  index: number;
  suite: string;
  label: string;
  /** "engine" runs go through the Overclock engine; "external" runs through the external adapter. */
  kind: "engine" | "external";
  /** Engine execution mode, or "external". */
  mode: string;
  template: TaskTemplateId;
  seed: number;
  records: number;
  trial: number;
  cache: "cold" | "warm";
  condition: ConditionName;
  holdout: boolean;
  /** "load" = POST /api/scenario with seed/template/records; "reset" = POST /api/reset of the loaded scenario. */
  prepare: "load" | "reset";
  /** Final overrides, including thumbnails, cache, and the run label sent to the engine. */
  overrides: RunOverrides;
  /** Index of a run that must have succeeded first (warm runs depend on their cold run). */
  after?: number | undefined;
}

interface RunSpec {
  label: string;
  overrides: RunOverrides;
  kind?: "engine" | "external";
  template: TaskTemplateId;
  seed: number;
  records: number;
  trial: number;
  condition: ConditionName;
  cache?: "cold" | "warm";
  after?: number;
}

class PlanBuilder {
  readonly runs: PlannedRun[] = [];
  constructor(
    private readonly suite: string,
    private readonly tag: string | undefined,
  ) {}

  add(spec: RunSpec): number {
    const cache = spec.cache ?? "cold";
    const kind = spec.kind ?? "engine";
    const index = this.runs.length;
    this.runs.push({
      index,
      suite: this.suite,
      label: spec.label,
      kind,
      mode: kind === "external" ? "external" : (spec.overrides.mode ?? "overclock"),
      template: spec.template,
      seed: spec.seed,
      records: spec.records,
      trial: spec.trial,
      cache,
      condition: spec.condition,
      holdout: isHoldout(spec.template, spec.seed),
      prepare: cache === "warm" ? "reset" : "load",
      overrides: { ...spec.overrides, thumbnails: false, cache, label: this.tag ? `${this.tag}/${spec.label}` : spec.label },
      after: spec.after,
    });
    return index;
  }

  mode(m: ModeName, s: Omit<RunSpec, "label" | "overrides">): number {
    return this.add({ ...s, label: modeLabel(m), overrides: MODE_OVERRIDES[m] });
  }
}

function checkCounts(opts: PlanOptions): void {
  if (!Number.isInteger(opts.trials) || opts.trials < 1) throw new Error(`--trials must be a positive integer, got ${opts.trials}`);
  if (!Number.isInteger(opts.records) || opts.records < 1 || opts.records > 500) throw new Error(`--records must be an integer from 1 to 500, got ${opts.records}`);
  if (!Number.isInteger(opts.seed) || opts.seed < 0) throw new Error(`--seed must be a non-negative integer, got ${opts.seed}`);
  if (opts.conditions && !opts.conditions.length) throw new Error("--condition must name at least one condition");
}

/** Rotate the order per trial so no label always runs first after a scenario load. */
function rotate<T>(xs: readonly T[], k: number): T[] {
  if (!xs.length) return [];
  const s = ((k % xs.length) + xs.length) % xs.length;
  return [...xs.slice(s), ...xs.slice(0, s)];
}

/** `--mode <m>`: `trials` cold runs of one mode under each requested condition (default local). */
export function planMode(mode: ModeName, opts: PlanOptions): PlannedRun[] {
  checkCounts(opts);
  const b = new PlanBuilder(taggedSuite(MODES_SUITE, opts.tag), opts.tag);
  const conditions = opts.conditions ?? ["local"];
  for (let trial = 1; trial <= opts.trials; trial++) {
    for (const condition of conditions) b.mode(mode, { template: opts.template, seed: opts.seed, records: opts.records, trial, condition });
  }
  return b.runs;
}

/**
 * Expand a suite. Trials are interleaved (trial 1 of every label, then trial 2, …) and the label
 * order rotates per trial, so drift in model latency or machine load spreads evenly. The most
 * important comparisons come first, so a budget cut removes the least important runs.
 */
export function planSuite(suite: SuiteName, opts: PlanOptions): PlannedRun[] {
  checkCounts(opts);
  const b = new PlanBuilder(taggedSuite(suite, opts.tag), opts.tag);
  const { template, seed, records, trials } = opts;
  // Suites that are not condition comparisons run under one condition: local unless excluded.
  const conds = opts.conditions;
  const single: ConditionName = !conds || conds.includes("local") ? "local" : (conds[0] ?? "local");
  switch (suite) {
    case "all": {
      const conditions = opts.conditions ?? CONDITION_NAMES;
      // 1. E vs C vs D: the cold-start comparison. Each cold E is followed by its warm repeat.
      const core: ModeName[] = ["overclock", "parallel", "staged"];
      for (let trial = 1; trial <= trials; trial++) {
        for (const condition of conditions) {
          for (const m of rotate(core, trial - 1)) {
            const cold = b.mode(m, { template, seed, records, trial, condition });
            if (m === "overclock") b.mode(m, { template, seed, records, trial, condition, cache: "warm", after: cold });
          }
        }
      }
      // 2. B, A, and the external baseline.
      const rest: (ModeName | "external")[] = ["compiled", "sequential", ...(opts.includeExternal ? (["external"] as const) : [])];
      for (let trial = 1; trial <= trials; trial++) {
        for (const condition of conditions) {
          for (const m of rotate(rest, trial - 1)) {
            if (m === "external") b.add({ label: EXTERNAL_LABEL, kind: "external", overrides: {}, template, seed, records, trial, condition });
            else b.mode(m, { template, seed, records, trial, condition });
          }
        }
      }
      // 3. One 100-record run per compiled mode, one condition.
      const large: ModeName[] = [...(opts.includeSequential100 ? (["sequential"] as const) : []), "compiled", "parallel", "staged", "overclock"];
      const largeCondition: ConditionName = conditions.includes("local") ? "local" : (conditions[0] ?? "local");
      for (const m of large) b.mode(m, { template, seed, records: ALL_LARGE_RECORDS, trial: 1, condition: largeCondition });
      break;
    }
    case "ablations": {
      for (let trial = 1; trial <= trials; trial++) {
        for (const rung of ABLATION_RUNGS) b.add({ label: ablationLabel(rung.name), overrides: rung.overrides, template, seed, records, trial, condition: single });
      }
      break;
    }
    case "intelligence": {
      for (const n of INTELLIGENCE_RECORDS) {
        for (let trial = 1; trial <= trials; trial++) {
          for (const intelligence of rotate(INTELLIGENCE_MODES, trial - 1)) {
            b.add({ label: `intelligence:${intelligence}`, overrides: { ...E, intelligence }, template, seed, records: n, trial, condition: single });
          }
        }
      }
      break;
    }
    case "scaling": {
      for (let trial = 1; trial <= trials; trial++) {
        for (const w of SCALING_WORKERS) {
          b.add({
            label: `scaling:workers=${w}`,
            overrides: { mode: "compiled-parallel", intelligence: "single-planner", concurrency: "fixed", maxWorkers: w, initialWorkers: w },
            template,
            seed,
            records: SCALING_RECORDS,
            trial,
            condition: single,
          });
        }
      }
      break;
    }
    case "holdout": {
      const conditions = opts.conditions ?? CONDITION_NAMES;
      for (let trial = 1; trial <= HOLDOUT_TRIALS; trial++) {
        for (const condition of conditions) {
          for (const s of HOLDOUT_SCENARIOS) {
            for (const m of HOLDOUT_MODES) b.mode(m, { template: s.template, seed: s.seed, records, trial, condition });
          }
        }
      }
      break;
    }
  }
  return b.runs;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Human-readable plan for `--dry`: every run in order plus a-priori counts. No cost or time estimates. */
export function formatPlan(plan: readonly PlannedRun[], budgetUsd: number): string {
  const suite = plan[0]?.suite ?? "(empty)";
  const recordExecutions = plan.reduce((a, r) => a + r.records, 0);
  const lines: string[] = [];
  lines.push(`Suite "${suite}": ${plan.length} planned runs, ${recordExecutions} record-executions in total.`);
  lines.push("");
  const cols = ["#", "label", "mode", "workers", "template", "seed", "records", "trial", "condition", "cache", "prepare"];
  const rows = plan.map((r) => [
    String(r.index + 1),
    r.label,
    r.mode,
    r.kind === "external" ? "-" : `${r.overrides.concurrency ?? "default"}/${r.overrides.maxWorkers ?? "default"}`,
    r.template,
    String(r.seed),
    String(r.records),
    String(r.trial),
    r.condition,
    r.cache + (r.holdout ? " holdout" : ""),
    r.prepare + (r.after !== undefined ? ` (after #${r.after + 1})` : ""),
  ]);
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((row) => row[i]?.length ?? 0)));
  lines.push(cols.map((c, i) => pad(c, widths[i] ?? 0)).join("  ").trimEnd());
  for (const row of rows) lines.push(row.map((c, i) => pad(c, widths[i] ?? 0)).join("  ").trimEnd());
  lines.push("");
  lines.push("Runs per group:");
  const groups = new Map<string, number>();
  for (const r of plan) {
    const k = `${r.label}  ${r.template} seed ${r.seed}  ${r.records} records  ${r.condition}  ${r.cache}${r.holdout ? "  holdout" : ""}`;
    groups.set(k, (groups.get(k) ?? 0) + 1);
  }
  for (const [k, n] of groups) lines.push(`  ${n} × ${k}`);
  lines.push("");
  if (plan.some((r) => r.holdout)) lines.push(`Holdout runs: execution requires ${HOLDOUT_FREEZE_ENV} to name a code-freeze identifier.`);
  lines.push(`Budget cap: $${budgetUsd.toFixed(2)} of reported model cost. Scheduling stops once spend reaches it.`);
  lines.push("Cost and time are not estimated here; they are known only after runs execute.");
  return lines.join("\n");
}
