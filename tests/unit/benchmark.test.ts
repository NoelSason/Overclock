import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  BenchmarkResultFile,
  BenchmarkRunRecord,
  CheckResult,
  PublicScenario,
  RunConfigInput,
  RunResultResponse,
  RunStatus,
  RunSummary,
  TaskTemplateId,
  VariationConfig,
} from "@overclock/contracts";
import {
  aggregateRuns,
  computeSpeedup,
  conditionVariations,
  DEFAULT_PLAN_OPTIONS,
  formatPlan,
  generateReport,
  isFailedRun,
  median,
  onlyLabels,
  p95,
  percentile,
  planMode,
  planSuite,
  REALISTIC_LATENCY,
  runPlan,
  type ArenaClient,
  type EngineClient,
  type HarnessDeps,
  type PlannedRun,
  type PlanOptions,
} from "@overclock/benchmarks";

// ---------------------------------------------------------------------------------------------
// Fixtures

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "r",
    mode: "overclock",
    status: "completed",
    wallMs: 60_000,
    discoveryMs: 1000,
    compileMs: 500,
    executionMs: 58_000,
    records: 25,
    tasks: 25,
    verified: 25,
    failed: 0,
    unconfirmed: 0,
    skipped: 0,
    needsApproval: 0,
    recordsVerified: 25,
    recoveries: 0,
    modelCalls: 10,
    inputTokens: 1000,
    outputTokens: 200,
    modelCostUsd: 0.5,
    workerUtilization: 0.8,
    maxConcurrency: 8,
    firstActionMs: 2000,
    firstVerifiedMs: 5000,
    overlapMs: 0,
    recoveryMs: 0,
    stageMs: {},
    ...over,
  };
}

function check(correct: number, total = 25, over: Partial<CheckResult> = {}): CheckResult {
  return {
    scenarioId: "t1-order-reconcile-s4242-n25",
    totalRecords: total,
    correctRecords: correct,
    accuracy: correct / total,
    mismatches: [],
    duplicateWrites: 0,
    collateralWrites: 0,
    escalationExpected: 0,
    checkedAt: 0,
    ...over,
  };
}

type RecOver = Partial<BenchmarkRunRecord> & { s?: Partial<RunSummary>; correct?: number };

function rec(over: RecOver = {}): BenchmarkRunRecord {
  const { s, correct, ...rest } = over;
  const wallMs = rest.wallMs ?? s?.wallMs ?? 60_000;
  const sum = rest.summary === null ? null : summary({ ...s, wallMs });
  const records = rest.records ?? 25;
  const chk = rest.check === null ? null : (rest.check ?? check(correct ?? records, records));
  return {
    suite: "all",
    label: "overclock",
    mode: "overclock",
    scenarioId: "t1-order-reconcile-s4242-n25",
    template: "t1-order-reconcile",
    seed: 4242,
    records,
    trial: 1,
    cache: "cold",
    holdout: false,
    runId: "run",
    startedAt: 0,
    summary: sum,
    check: chk,
    wallMs,
    discoveryMs: sum?.discoveryMs ?? 0,
    compileMs: sum?.compileMs ?? 0,
    executionMs: sum?.executionMs ?? 0,
    correctPerMin: chk ? chk.correctRecords / (wallMs / 60_000) : 0,
    modelCalls: sum?.modelCalls ?? 0,
    inputTokens: sum?.inputTokens ?? 0,
    outputTokens: sum?.outputTokens ?? 0,
    costUsd: sum?.modelCostUsd ?? 0,
    workerUtilization: sum?.workerUtilization ?? 0,
    maxConcurrency: sum?.maxConcurrency ?? 0,
    verifiedButWrong: 0,
    firstActionMs: sum?.firstActionMs ?? null,
    firstVerifiedMs: sum?.firstVerifiedMs ?? null,
    overlapMs: sum?.overlapMs ?? 0,
    recoveryMs: sum?.recoveryMs ?? 0,
    duplicateWrites: chk?.duplicateWrites ?? 0,
    collateralWrites: chk?.collateralWrites ?? 0,
    condition: "local",
    config: { goal: "g", applications: [{ name: "Orders", origin: "http://127.0.0.1:4102" }], mode: "overclock", maxWorkers: 16 },
    ...rest,
  };
}

function resultFile(runs: BenchmarkRunRecord[], over: Partial<BenchmarkResultFile> = {}): BenchmarkResultFile {
  return {
    version: 1,
    suite: runs[0]?.suite ?? "all",
    createdAt: Date.UTC(2026, 9, 24, 12, 0, 0),
    machine: { platform: "darwin", cpus: 12, memoryGb: 36, node: "v24.10.0" },
    budgetUsd: 50,
    spentUsd: runs.reduce((a, r) => a + r.costUsd, 0),
    runs,
    notes: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// Stats

describe("benchmark stats", () => {
  it("computes medians and linear-interpolation percentiles", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    const xs = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    expect(percentile(xs, 0.95)).toBeCloseTo(9.55, 10);
    expect(percentile(xs, 0)).toBe(1);
    expect(percentile(xs, 1)).toBe(10);
    expect(xs[0]).toBe(10); // input not mutated
    expect(percentile([], 0.5)).toBeNaN();
    expect(() => percentile([1], 1.5)).toThrow(RangeError);
  });

  it("reports p95 only with at least 5 samples", () => {
    expect(p95([1, 2, 3, 4])).toBeNull();
    expect(p95([1, 2, 3, 4, 5])).toBeCloseTo(4.8, 10);
  });

  it("separates cold, warm, holdout, record-count, and condition groups", () => {
    const runs = [
      rec({ wallMs: 10_000 }),
      rec({ wallMs: 20_000 }),
      rec({ wallMs: 30_000, cache: "warm" }),
      rec({ wallMs: 40_000, holdout: true, template: "t3-crm-status-sync", seed: 9001 }),
      rec({ wallMs: 50_000, records: 100 }),
      rec({ wallMs: 60_000, condition: "realistic-latency" }),
    ];
    const rows = aggregateRuns(runs);
    expect(rows).toHaveLength(5);
    const cold = rows.find((r) => r.cache === "cold" && !r.holdout && r.records === 25 && r.condition === "local");
    expect(cold?.n).toBe(2);
    expect(cold?.wallMs.median).toBe(15_000);
    expect(rows.find((r) => r.cache === "warm")?.wallMs.median).toBe(30_000);
    expect(rows.find((r) => r.holdout)?.wallMs.median).toBe(40_000);
    expect(rows.find((r) => r.records === 100)?.wallMs.median).toBe(50_000);
    expect(rows.find((r) => r.condition === "realistic-latency")?.wallMs.median).toBe(60_000);
  });

  it("excludes failed runs from medians but counts them, and sums write safety over checked runs", () => {
    const runs = [
      rec({ wallMs: 10_000, correct: 25, s: { firstVerifiedMs: 1000, stageMs: { discovery: 100, execution: 900 } } }),
      rec({ wallMs: 20_000, correct: 20, s: { firstVerifiedMs: null, stageMs: { discovery: 300, execution: 700 } } }),
      rec({ wallMs: 999_000, error: "timed out", check: check(5, 25, { duplicateWrites: 2 }) }),
      rec({ wallMs: 1, summary: null, check: null, error: "start failed" }),
    ];
    const [row] = aggregateRuns(runs);
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.n).toBe(2);
    expect(row.failedRuns).toBe(2);
    expect(row.attempted).toBe(4);
    expect(row.wallMs.median).toBe(15_000);
    expect(row.wallMs.p95).toBeNull();
    expect(row.accuracy.min).toBeCloseTo(0.8, 10);
    expect(row.accuracy.median).toBeCloseTo(0.9, 10);
    expect(row.firstVerifiedMs.median).toBe(1000);
    expect(row.neverVerified).toBe(1);
    expect(row.stageMs).toEqual({ discovery: 200, execution: 800 });
    expect(row.costPerCorrectUsd).toBeCloseTo(1.0 / 45, 10);
    expect(row.writes).toEqual({ checkedRuns: 3, incorrectRecords: 0 + 5 + 20, duplicateWrites: 2, collateralWrites: 0 });
  });

  it("treats an external run without an engine summary as completed, but not an engine run", () => {
    expect(isFailedRun(rec({ mode: "external", label: "external", summary: null }))).toBe(false);
    expect(isFailedRun(rec({ summary: null }))).toBe(true);
  });

  it("computes speedups only between matched groups", () => {
    const rows = aggregateRuns([
      rec({ label: "compiled-parallel", wallMs: 60_000 }),
      rec({ label: "overclock", wallMs: 30_000 }),
      rec({ label: "overclock", wallMs: 30_000, records: 100 }),
      rec({ label: "overclock", wallMs: 30_000, cache: "warm" }),
      rec({ label: "overclock", wallMs: 30_000, condition: "realistic-latency" }),
      rec({ label: "overclock", wallMs: 30_000, holdout: true }),
    ]);
    const find = (p: (r: (typeof rows)[number]) => boolean) => {
      const r = rows.find(p);
      if (!r) throw new Error("missing row");
      return r;
    };
    const base = find((r) => r.label === "compiled-parallel");
    const e = find((r) => r.label === "overclock" && r.records === 25 && r.cache === "cold" && r.condition === "local" && !r.holdout);
    const ok = computeSpeedup(base, e);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value.wallRatio).toBe(2);
      expect(ok.value.correctPerMinRatio).toBe(2);
      expect(ok.value.nBaseline).toBe(1);
    }
    const refuse = (p: (r: (typeof rows)[number]) => boolean, reason: RegExp) => {
      const s = computeSpeedup(base, find(p));
      expect(s.ok).toBe(false);
      if (!s.ok) expect(s.reason).toMatch(reason);
    };
    refuse((r) => r.records === 100, /records differ/);
    refuse((r) => r.cache === "warm", /cache state differs/);
    refuse((r) => r.condition === "realistic-latency", /condition differs/);
    refuse((r) => r.holdout, /holdout/);
  });
});

// ---------------------------------------------------------------------------------------------
// Planning (--dry)

describe("benchmark planning", () => {
  const opts: PlanOptions = { ...DEFAULT_PLAN_OPTIONS };

  it("plans --mode runs as cold local trials", () => {
    const plan = planMode("staged", opts);
    expect(plan).toHaveLength(3);
    expect(plan.every((r) => r.label === "overclock-staged" && r.condition === "local" && r.cache === "cold" && r.prepare === "load")).toBe(true);
    expect(plan[0]?.overrides).toMatchObject({ mode: "overclock-staged", intelligence: "adaptive", concurrency: "adaptive", maxWorkers: 16, thumbnails: false, cache: "cold" });
    expect(plan[0]?.suite).toBe("modes");
    expect(planMode("overclock", { ...opts, tag: "v2" })[0]?.suite).toBe("modes@v2");
  });

  it("plans the all suite with E vs C vs D first, under both conditions, and warm repeats after cold E", () => {
    const plan = planSuite("all", opts);
    // 3 trials × 2 conditions × (E + warm E + C + D) + 3 × 2 × (B + A) + 4 runs at 100 records.
    expect(plan).toHaveLength(24 + 12 + 4);
    const first = plan.slice(0, 24);
    expect(new Set(first.map((r) => r.label))).toEqual(new Set(["overclock", "compiled-parallel", "overclock-staged"]));
    expect(first.every((r) => r.records === 25)).toBe(true);
    expect(new Set(first.slice(0, 8).map((r) => r.condition))).toEqual(new Set(["local", "realistic-latency"]));
    const warm = plan.filter((r) => r.cache === "warm");
    expect(warm).toHaveLength(6);
    for (const w of warm) {
      expect(w.prepare).toBe("reset");
      expect(w.after).toBe(w.index - 1);
      const cold = plan[w.index - 1];
      expect(cold?.label).toBe("overclock");
      expect(cold?.cache).toBe("cold");
      expect(cold?.condition).toBe(w.condition);
    }
    expect(plan.filter((r) => r.records === 100).map((r) => r.label)).toEqual(["compiled-single", "compiled-parallel", "overclock-staged", "overclock"]);
    expect(plan.every((r) => r.overrides.thumbnails === false)).toBe(true);
    expect(planSuite("all", { ...opts, includeSequential100: true, includeExternal: true })).toHaveLength(40 + 1 + 6);
    expect(planSuite("all", { ...opts, conditions: ["local"] }).every((r) => r.condition === "local")).toBe(true);
  });

  it("keeps only the requested labels and renumbers warm-run dependencies", () => {
    const plan = onlyLabels(planSuite("all", opts), ["overclock", "compiled-single"]);
    expect(new Set(plan.map((r) => r.label))).toEqual(new Set(["overclock", "compiled-single"]));
    expect(plan.map((r) => r.index)).toEqual(plan.map((_, i) => i));
    for (const w of plan.filter((r) => r.cache === "warm")) {
      expect(plan[w.after!]).toMatchObject({ label: "overclock", cache: "cold", condition: w.condition, trial: w.trial });
    }
  });

  it("plans ablations with the ladder and the removal rungs", () => {
    const plan = planSuite("ablations", opts);
    expect(plan).toHaveLength(11 * 3);
    const byLabel = (l: string) => plan.find((r) => r.label === l)?.overrides;
    expect(byLabel("ablation:full-no-jev")).toMatchObject({ mode: "overclock", useJev: false });
    expect(byLabel("ablation:overclock-no-streaming")?.ablation).toEqual({ streaming: false });
    expect(byLabel("ablation:overclock-no-access-paths")?.ablation).toEqual({ accessPaths: false });
    expect(byLabel("ablation:overclock-no-write-canary")?.ablation).toEqual({ writeCanary: false });
    expect(byLabel("ablation:overclock-no-online-reopt")?.ablation).toEqual({ onlineReoptimization: false });
    expect(byLabel("ablation:compiler+adaptive-scheduling")).toMatchObject({ mode: "compiled-parallel", concurrency: "adaptive", maxWorkers: 16 });
    expect(plan.every((r) => r.condition === "local")).toBe(true);
  });

  it("plans the intelligence and scaling suites", () => {
    const intel = planSuite("intelligence", opts);
    expect(intel).toHaveLength(3 * 2 * 3);
    expect(new Set(intel.map((r) => r.records))).toEqual(new Set([10, 50]));
    expect(new Set(intel.map((r) => r.overrides.intelligence))).toEqual(new Set(["single-planner", "parallel-scout", "adaptive"]));
    const scaling = planSuite("scaling", opts);
    expect(scaling).toHaveLength(5 * 3);
    expect(scaling.every((r) => r.records === 100 && r.overrides.mode === "compiled-parallel" && r.overrides.concurrency === "fixed")).toBe(true);
    expect([...new Set(scaling.map((r) => r.overrides.maxWorkers))]).toEqual([1, 2, 4, 8, 16]);
  });

  it("plans the holdout suite as E, D, C on t4 and t3, cold, both conditions, one trial", () => {
    const plan = planSuite("holdout", opts);
    expect(plan).toHaveLength(2 * 2 * 3);
    expect(plan.every((r) => r.holdout && r.cache === "cold" && r.trial === 1)).toBe(true);
    expect(new Set(plan.map((r) => `${r.template}/${r.seed}`))).toEqual(new Set(["t4-holdout/9101", "t3-crm-status-sync/9001"]));
    expect(new Set(plan.map((r) => r.label))).toEqual(new Set(["overclock", "overclock-staged", "compiled-parallel"]));
  });

  it("formats a dry-run plan with a-priori counts and no estimates", () => {
    const text = formatPlan(planSuite("all", opts), 50);
    expect(text).toContain('Suite "all": 40 planned runs, 1300 record-executions in total.');
    expect(text).toContain("3 × overclock  t1-order-reconcile seed 4242  25 records  local  cold");
    expect(text).toContain("3 × overclock  t1-order-reconcile seed 4242  25 records  realistic-latency  warm");
    expect(text).toContain("Budget cap: $50.00");
    expect(text).toContain("not estimated");
    expect(formatPlan(planSuite("holdout", opts), 50)).toContain("OVERCLOCK_HOLDOUT_FROZEN");
  });

  it("applies latency to every app the scenario lists, and nothing for local", () => {
    const apps = { applications: [{ name: "Orders", origin: "o" }, { name: "Fourth", origin: "f" }] };
    expect(conditionVariations("local", apps).latency).toEqual({});
    expect(conditionVariations("realistic-latency", apps).latency).toEqual({ Orders: { ...REALISTIC_LATENCY }, Fourth: { ...REALISTIC_LATENCY } });
  });
});

// ---------------------------------------------------------------------------------------------
// Harness (fake engine and arena, no network)

function scenarioFor(req: { seed: number; template: TaskTemplateId; records: number }): PublicScenario {
  return {
    scenarioId: `${req.template}-s${req.seed}-n${req.records}`,
    seed: req.seed,
    template: req.template,
    title: "Test scenario",
    goal: "Reconcile the orders.",
    records: Array.from({ length: req.records }, (_, i) => ({ key: `R${i}` })),
    applications: [
      { name: "Orders", origin: "http://127.0.0.1:4102" },
      { name: "Support", origin: "http://127.0.0.1:4103" },
    ],
    holdout: req.seed >= 9000 || req.template === "t3-crm-status-sync" || req.template === "t4-holdout",
  };
}

class FakeArena implements ArenaClient {
  current: PublicScenario | null = null;
  calls: string[] = [];
  variations: VariationConfig[] = [];
  nextCheck: Omit<CheckResult, "scenarioId" | "totalRecords" | "accuracy" | "checkedAt" | "escalationExpected"> | null = null;
  /** Set to return a different dataset on the next load (fairness check). */
  tamper = false;

  async loadScenario(req: { seed: number; template: TaskTemplateId; records: number }): Promise<PublicScenario> {
    this.calls.push("load");
    const s = scenarioFor(req);
    if (this.tamper) s.records = s.records.map((r, i) => ({ ...r, extra: i }));
    this.current = s;
    this.nextCheck = null;
    return s;
  }
  async reset(): Promise<PublicScenario> {
    this.calls.push("reset");
    if (!this.current) throw new Error("no scenario");
    this.nextCheck = null;
    return this.current;
  }
  async scenario(): Promise<PublicScenario> {
    if (!this.current) throw new Error("no scenario");
    return this.current;
  }
  async setVariations(v: VariationConfig): Promise<unknown> {
    this.calls.push("variations");
    this.variations.push(v);
    return v;
  }
  async check(): Promise<CheckResult> {
    this.calls.push("check");
    const s = this.current;
    if (!s) throw new Error("no scenario");
    const c = this.nextCheck ?? { correctRecords: 0, mismatches: [], duplicateWrites: 0, collateralWrites: 0 };
    return { scenarioId: s.scenarioId, totalRecords: s.records.length, accuracy: c.correctRecords / s.records.length, escalationExpected: 0, checkedAt: 0, ...c };
  }
}

interface Behavior {
  costUsd?: number;
  wallMs?: number;
  status?: RunStatus;
  startError?: string;
  hang?: boolean;
  correct?: number;
  mismatchKeys?: string[];
  verifiedKeys?: string[];
  duplicateWrites?: number;
}

class FakeEngine implements EngineClient {
  started: RunConfigInput[] = [];
  cancelled: string[] = [];
  private runs = new Map<string, { config: RunConfigInput; b: Behavior }>();
  constructor(
    private readonly arena: FakeArena,
    private readonly behave: (config: RunConfigInput, n: number) => Behavior,
  ) {}

  async start(config: RunConfigInput): Promise<{ runId: string }> {
    const n = this.started.length;
    this.started.push(config);
    const b = this.behave(config, n);
    if (b.startError) throw new Error(b.startError);
    const runId = `run-${n + 1}`;
    this.runs.set(runId, { config, b });
    return { runId };
  }
  waitForCompletion(runId: string, opts?: { signal?: AbortSignal | undefined }): Promise<unknown> {
    const r = this.runs.get(runId);
    if (!r) return Promise.reject(new Error("unknown run"));
    if (r.b.hang && !this.cancelled.includes(runId)) {
      return new Promise((_, reject) => opts?.signal?.addEventListener("abort", () => reject(new Error("follow aborted")), { once: true }));
    }
    const n = r.config.records?.length ?? 0;
    this.arena.nextCheck = {
      correctRecords: r.b.correct ?? n,
      mismatches: (r.b.mismatchKeys ?? []).map((k) => ({ recordKey: k, entity: "order", field: "status", expected: "a", actual: "b" })),
      duplicateWrites: r.b.duplicateWrites ?? 0,
      collateralWrites: 0,
    };
    return Promise.resolve({});
  }
  async result(runId: string): Promise<RunResultResponse> {
    const r = this.runs.get(runId);
    if (!r) throw new Error("unknown run");
    const status = this.cancelled.includes(runId) ? "cancelled" : (r.b.status ?? "completed");
    return {
      runId,
      status,
      summary: summary({ runId, status, wallMs: r.b.wallMs ?? 30_000, modelCostUsd: r.b.costUsd ?? 0.1, records: r.config.records?.length ?? 0 }),
      outcomes: (r.b.verifiedKeys ?? []).map((k) => ({ recordKey: k, status: "VERIFIED" as const, writes: 1, receipts: [], notes: [] })),
      verificationSemantics: "test",
    };
  }
  async metrics(runId: string): Promise<unknown> {
    return { runId, ok: true };
  }
  async cancel(runId: string): Promise<unknown> {
    this.cancelled.push(runId);
    return { ok: true };
  }
}

function deps(arena: FakeArena, engine: FakeEngine, extra: Partial<HarnessDeps> = {}): HarnessDeps {
  return {
    arena,
    engine,
    buildConfig: (s, o) => ({ goal: s.goal, applications: s.applications, records: s.records, label: s.title, ...o }),
    ...extra,
  };
}

describe("benchmark harness", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "overclock-bench-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const small: PlanOptions = { ...DEFAULT_PLAN_OPTIONS, records: 5, trials: 1 };
  const baseOpts = () => ({ outDir: dir, budgetUsd: 50, runTimeoutMs: 5000, cancelGraceMs: 20, stem: "test", now: () => 1_000 });

  it("records checker ground truth, applies conditions, and writes the file after every run", async () => {
    const arena = new FakeArena();
    const engine = new FakeEngine(arena, () => ({ correct: 4, mismatchKeys: ["R1"], verifiedKeys: ["R0", "R1"], duplicateWrites: 1, wallMs: 30_000 }));
    const plan = planMode("overclock", { ...small, trials: 2, conditions: ["local", "realistic-latency"] });
    const seen: number[] = [];
    const result = await runPlan(plan, deps(arena, engine), {
      ...baseOpts(),
      suite: "modes",
      onRecorded: (_r, file) => {
        const onDisk = JSON.parse(readFileSync(join(dir, "test-modes.json"), "utf8")) as BenchmarkResultFile;
        expect(onDisk.runs).toHaveLength(file.runs.length);
        seen.push(onDisk.runs.length);
      },
    });
    expect(seen).toEqual([1, 2, 3, 4]);
    const r = result.file.runs[0];
    expect(r?.error).toBeUndefined();
    expect(r?.wallMs).toBe(30_000);
    expect(r?.check?.correctRecords).toBe(4);
    expect(r?.correctPerMin).toBeCloseTo(8, 10);
    expect(r?.verifiedButWrong).toBe(1);
    expect(r?.duplicateWrites).toBe(1);
    expect(r?.firstVerifiedMs).toBe(5000);
    expect(r?.config).toMatchObject({ mode: "overclock", thumbnails: false, cache: "cold", label: "overclock" });
    expect(result.file.runs.map((x) => x.condition)).toEqual(["local", "realistic-latency", "local", "realistic-latency"]);
    expect(arena.variations[0]?.latency).toEqual({});
    expect(arena.variations[1]?.latency).toEqual({ Orders: { ...REALISTIC_LATENCY }, Support: { ...REALISTIC_LATENCY } });
    expect(arena.calls.slice(0, 3)).toEqual(["load", "variations", "check"]);
    expect(await readdir(join(dir, "metrics", "test-modes"))).toContain("run-1.json");
    expect(result.file.machine.cpus).toBeGreaterThan(0);
  });

  it("stops scheduling at the budget cap and notes what was not executed", async () => {
    const arena = new FakeArena();
    const engine = new FakeEngine(arena, () => ({ costUsd: 0.6 }));
    const plan = planMode("parallel", { ...small, trials: 4 });
    const result = await runPlan(plan, deps(arena, engine), { ...baseOpts(), suite: "modes", budgetUsd: 1 });
    expect(result.file.runs).toHaveLength(2);
    expect(result.file.spentUsd).toBeCloseTo(1.2, 10);
    expect(result.notExecuted).toHaveLength(2);
    expect(result.file.notes.some((n) => n.startsWith("Budget cap reached") && n.includes("2 planned runs not executed"))).toBe(true);
    const onDisk = JSON.parse(await readFile(result.path, "utf8")) as BenchmarkResultFile;
    expect(onDisk.runs).toHaveLength(2);
  });

  it("records a failing run with its error and keeps going", async () => {
    const arena = new FakeArena();
    const engine = new FakeEngine(arena, (_c, n) => (n === 1 ? { startError: "engine exploded" } : n === 2 ? { status: "failed" } : {}));
    const result = await runPlan(planMode("compiled", { ...small, trials: 4 }), deps(arena, engine), { ...baseOpts(), suite: "modes" });
    expect(result.file.runs).toHaveLength(4);
    expect(result.file.runs[1]?.error).toBe("engine exploded");
    expect(result.file.runs[1]?.summary).toBeNull();
    expect(result.file.runs[2]?.error).toBe('run ended with status "failed"');
    expect(result.file.runs.filter((r) => isFailedRun(r))).toHaveLength(2);
  });

  it("cancels a run that exceeds the timeout and records it as failed", async () => {
    const arena = new FakeArena();
    const engine = new FakeEngine(arena, () => ({ hang: true }));
    const result = await runPlan(planMode("overclock", small), deps(arena, engine), { ...baseOpts(), suite: "modes", runTimeoutMs: 20 });
    expect(engine.cancelled).toEqual(["run-1"]);
    expect(result.file.runs[0]?.error).toMatch(/timed out/);
  });

  it("skips a warm run whose cold run failed", async () => {
    const arena = new FakeArena();
    const engine = new FakeEngine(arena, () => ({ status: "failed" }));
    const plan = planSuite("all", { ...small, conditions: ["local"] }).slice(0, 2);
    expect(plan.map((r) => r.cache)).toEqual(["cold", "warm"]);
    const result = await runPlan(plan, deps(arena, engine), { ...baseOpts(), suite: "all" });
    expect(result.file.runs).toHaveLength(1);
    expect(result.notExecuted.map((r) => r.cache)).toEqual(["warm"]);
    expect(result.file.notes.some((n) => n.includes("prerequisite run #1 failed"))).toBe(true);
  });

  it("fails a run when the arena serves a different dataset for the same key", async () => {
    const arena = new FakeArena();
    const engine = new FakeEngine(arena, () => ({}));
    const plan = planMode("overclock", { ...small, trials: 2 });
    const result = await runPlan(plan, deps(arena, engine), {
      ...baseOpts(),
      suite: "modes",
      onRecorded: () => {
        arena.tamper = true;
      },
    });
    expect(result.file.runs[0]?.error).toBeUndefined();
    expect(result.file.runs[1]?.error).toMatch(/different dataset/);
    expect(engine.started).toHaveLength(1);
  });

  it("refuses holdout runs without a code-freeze identifier and records it when given", async () => {
    const plan = planSuite("holdout", small).slice(0, 1);
    const arena = new FakeArena();
    const engine = new FakeEngine(arena, () => ({}));
    await expect(runPlan(plan, deps(arena, engine), { ...baseOpts(), suite: "holdout" })).rejects.toThrow(/OVERCLOCK_HOLDOUT_FROZEN/);
    expect(engine.started).toHaveLength(0);
    const result = await runPlan(plan, deps(arena, engine), { ...baseOpts(), suite: "holdout", holdoutFreezeId: "freeze-2026-10-24" });
    expect(result.file.notes).toContain("Holdout code freeze: freeze-2026-10-24.");
    expect(result.file.runs[0]?.holdout).toBe(true);
  });

  it("runs the external baseline through its adapter, or skips it with a note", async () => {
    const plan: PlannedRun[] = planSuite("all", { ...small, conditions: ["local"], includeExternal: true }).filter((r) => r.kind === "external");
    expect(plan.length).toBeGreaterThan(0);
    const arena = new FakeArena();
    const engine = new FakeEngine(arena, () => ({}));
    const skipped = await runPlan(plan, deps(arena, engine), { ...baseOpts(), suite: "all" });
    expect(skipped.file.runs).toHaveLength(0);
    expect(skipped.file.notes.some((n) => n.includes("External baseline runs skipped"))).toBe(true);

    const ran = await runPlan(plan, deps(arena, engine, {
      external: async (config) => {
        arena.nextCheck = { correctRecords: (config.records?.length ?? 0) - 1, mismatches: [], duplicateWrites: 0, collateralWrites: 0 };
        return { wallMs: 90_000, firstActionMs: 4000, modelCalls: 40, costUsd: 0.9, inputTokens: 5000, outputTokens: 900 };
      },
    }), { ...baseOpts(), suite: "all", stem: "ext" });
    const r = ran.file.runs[0];
    expect(r?.mode).toBe("external");
    expect(r?.summary).toBeNull();
    expect(r?.error).toBeUndefined();
    expect(r?.wallMs).toBe(90_000);
    expect(r?.check?.correctRecords).toBe(4);
    expect(r && isFailedRun(r)).toBe(false);
    expect(engine.started).toHaveLength(0);

    let aborted = false;
    const timedOut = await runPlan(plan.slice(0, 1), deps(arena, engine, {
      external: (_config, _scenario, signal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          }),
        ),
    }), { ...baseOpts(), suite: "all", stem: "ext-timeout", runTimeoutMs: 20 });
    expect(aborted).toBe(true);
    expect(timedOut.file.runs[0]?.error).toMatch(/timed out/);
  });
});

// ---------------------------------------------------------------------------------------------
// Report

describe("benchmark report", () => {
  it("says there are no results instead of inventing numbers", () => {
    const md = generateReport([]);
    expect(md).toContain("No benchmark results yet.");
    expect(md).not.toMatch(/^## Cold start$/m);
    expect(md).toContain("## Methodology");
    expect(generateReport([resultFile([])])).toContain("none contains an executed run");
  });

  it("reports the cold-start headline, conditions, holdout, and limitations from recorded runs", () => {
    const series = (label: string, condition: string, walls: number[], extra: RecOver = {}) =>
      walls.map((wallMs, i) => rec({ label, mode: label, condition, wallMs, trial: i + 1, ...extra }));
    const stages = { s: { stageMs: { discovery: 5000, planning: 3000, execution: 20_000 } } };
    const runs = [
      ...series("overclock", "local", [30_000, 32_000, 34_000], stages),
      ...series("compiled-parallel", "local", [60_000, 62_000, 64_000]),
      ...series("overclock-staged", "local", [40_000, 41_000, 42_000]),
      ...series("overclock", "realistic-latency", [70_000, 72_000, 74_000]),
      ...series("overclock-staged", "realistic-latency", [50_000, 52_000, 54_000]),
      ...series("compiled-parallel", "realistic-latency", [90_000, 91_000, 92_000], { check: check(25, 25, { duplicateWrites: 2 }) }),
      rec({ label: "overclock", condition: "realistic-latency", wallMs: 80_000, trial: 4, verifiedButWrong: 1, correct: 24 }),
      rec({ suite: "holdout", label: "overclock", template: "t4-holdout", seed: 9101, holdout: true, wallMs: 45_000 }),
      rec({ suite: "holdout", label: "compiled-parallel", template: "t4-holdout", seed: 9101, holdout: true, wallMs: 50_000 }),
    ];
    const md = generateReport([resultFile(runs, { notes: ["Holdout code freeze: freeze-1."] })], { names: ["2026-10-24T12-00-00.000Z-all.json"] });

    expect(md).toMatch(/^## Cold start$/m);
    expect(md).toContain("E is faster than C on t1 seed 4242, 25 records, local (n=3 vs 3): 32.0 s vs 62.0 s median wall (1.94×).");
    expect(md).toContain("**E is not faster than D** on t1 seed 4242, 25 records, realistic-latency (n=4 vs 3)");
    expect(md).toContain("**Cold start, local**");
    expect(md).toContain("**Cold start, realistic-latency**");
    expect(md).toContain("n/a (n=3)");
    expect(md).toContain("## Holdout");
    expect(md).toContain("Holdout code freeze: freeze-1.");
    expect(md).toContain("E is faster than C on t4 seed 9101 (holdout)");
    expect(md).toMatch(/\| `all` \| `overclock` \| t1 seed 4242 \| 25 \| local \| cold \| 3 \| 32\.0 s \| 5\.0 s \(15\.6%\) \| 3\.0 s \(9\.4%\) \| 20\.0 s \(62\.5%\) \|/);
    expect(md).toContain("**`overclock` reported 1 record as VERIFIED that the checker marks incorrect**");
    expect(md).toContain("**`compiled-parallel` made 6 duplicate writes** across 3 checked runs");
    expect(md).toContain("## Duplicate and incorrect writes");
    expect(md).toContain("## Speedups");
    expect(md).not.toMatch(/NaN|undefined/);
  });

  it("reports ablation deltas and the scaling curve only from matched groups", () => {
    const runs = [
      rec({ suite: "ablations", label: "ablation:full", wallMs: 30_000 }),
      rec({ suite: "ablations", label: "ablation:overclock-no-streaming", wallMs: 45_000 }),
      rec({ suite: "ablations", label: "ablation:overclock-no-write-canary", wallMs: 25_000 }),
      rec({ suite: "scaling", label: "scaling:workers=1", wallMs: 160_000, records: 100, config: { goal: "g", applications: [], maxWorkers: 1 } }),
      rec({ suite: "scaling", label: "scaling:workers=2", wallMs: 80_000, records: 100, config: { goal: "g", applications: [], maxWorkers: 2 } }),
      rec({ suite: "scaling", label: "scaling:workers=4", wallMs: 90_000, records: 100, config: { goal: "g", applications: [], maxWorkers: 4 } }),
    ];
    const md = generateReport([resultFile(runs)]);
    expect(md).toContain("| streaming execution | removal | `ablation:overclock-no-streaming` (1) → `ablation:full` (1) | 45.0 s → 30.0 s | -15.0 s (-33.3%)");
    expect(md).toContain("**Keeping write canary made runs slower**");
    expect(md).toContain("| 2 | 1 | 0 | 80.0 s | n/a (n=1) | 2.00× | 100.0%");
    expect(md).toContain("**More workers made runs slower**: 4 workers took 90.0 s median vs 80.0 s with 2");
  });
});
