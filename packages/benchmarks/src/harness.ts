import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type {
  BenchmarkResultFile,
  BenchmarkRunRecord,
  CheckResult,
  PublicScenario,
  RecordOutcome,
  RunConfigInput,
  RunResultResponse,
  TaskTemplateId,
  VariationConfig,
} from "@overclock/contracts";
import { conditionVariations, HOLDOUT_FREEZE_ENV, type PlannedRun, type RunOverrides } from "./suites";

/**
 * Benchmark harness: executes planned runs one at a time against a live engine and arena and
 * records exactly what happened. The engine and arena are reached through the two small client
 * interfaces below, which the SDK's `Overclock` and `Arena` classes satisfy; tests inject fakes.
 */

export interface EngineClient {
  start(config: RunConfigInput): Promise<{ runId: string }>;
  /** Follow the run until it finishes; aborting `signal` stops following (the run keeps going). */
  waitForCompletion(runId: string, opts?: { signal?: AbortSignal | undefined }): Promise<unknown>;
  result(runId: string): Promise<RunResultResponse>;
  metrics(runId: string): Promise<unknown>;
  cancel(runId: string): Promise<unknown>;
}

export interface ArenaClient {
  scenario(): Promise<PublicScenario>;
  loadScenario(req: { seed: number; template: TaskTemplateId; records: number }): Promise<PublicScenario>;
  reset(): Promise<PublicScenario>;
  check(): Promise<CheckResult>;
  setVariations(v: VariationConfig): Promise<unknown>;
}

/** What an external browser-agent baseline reports for one run. The arena checker supplies accuracy. */
export interface ExternalResult {
  wallMs: number;
  firstActionMs: number | null;
  modelCalls: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  error?: string | undefined;
}

export type ExternalRunner = (config: RunConfigInput, scenario: PublicScenario) => Promise<ExternalResult>;

/** Validate an external adapter's return value; throws with the offending field on bad input. */
export function parseExternalResult(v: unknown): ExternalResult {
  if (typeof v !== "object" || v === null) throw new Error("external baseline returned a non-object result");
  const o = v as Record<string, unknown>;
  const num = (k: string): number => {
    const x = o[k];
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0) throw new Error(`external baseline result.${k} must be a non-negative number`);
    return x;
  };
  const first = o.firstActionMs;
  if (first !== null && first !== undefined && (typeof first !== "number" || !Number.isFinite(first) || first < 0)) {
    throw new Error("external baseline result.firstActionMs must be a non-negative number or null");
  }
  if (o.error !== undefined && typeof o.error !== "string") throw new Error("external baseline result.error must be a string");
  return {
    wallMs: num("wallMs"),
    firstActionMs: typeof first === "number" ? first : null,
    modelCalls: num("modelCalls"),
    costUsd: num("costUsd"),
    inputTokens: num("inputTokens"),
    outputTokens: num("outputTokens"),
    error: typeof o.error === "string" ? o.error : undefined,
  };
}

export interface HarnessDeps {
  engine: EngineClient;
  arena: ArenaClient;
  /** Usually the SDK's `configFromScenario`. */
  buildConfig(scenario: PublicScenario, overrides: RunOverrides): RunConfigInput;
  /** External baseline adapter; external runs are skipped with a note when absent. */
  external?: ExternalRunner | undefined;
}

export interface HarnessOptions {
  suite: string;
  outDir: string;
  budgetUsd: number;
  /** Per-run timeout; the run is cancelled and recorded as failed when it expires. */
  runTimeoutMs: number;
  /** After a timeout or interrupt, how long to wait for the cancelled run to settle. */
  cancelGraceMs?: number;
  /** Code-freeze identifier; required when the plan contains holdout runs. */
  holdoutFreezeId?: string | undefined;
  /** Notes recorded at the top of the result file (engine version, models, …). */
  notes?: string[];
  machine?: BenchmarkResultFile["machine"];
  now?: () => number;
  /** Filename stem; defaults to the ISO timestamp of the start (colons replaced). */
  stem?: string;
  log?: (line: string) => void;
  signal?: AbortSignal;
  /** Called after each run is recorded and the result file is rewritten. */
  onRecorded?: (record: BenchmarkRunRecord, file: BenchmarkResultFile) => void;
}

export interface HarnessResult {
  file: BenchmarkResultFile;
  path: string;
  /** Planned runs that were never executed (budget cap, interrupt, missing adapter, or failed prerequisite). */
  notExecuted: PlannedRun[];
}

export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_BUDGET_USD = 50;

export function machineInfo(): BenchmarkResultFile["machine"] {
  return {
    platform: os.platform(),
    cpus: os.cpus().length,
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
  };
}

export function timestampStem(ms: number): string {
  return new Date(ms).toISOString().replace(/:/g, "-");
}

export function resultFilePath(outDir: string, stem: string, suite: string): string {
  return join(outDir, `${stem}-${suite}.json`);
}

/** Write via a temp file and rename, so a reader never sees a half-written file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/** Distinct records the engine reported VERIFIED that the checker lists as mismatched. */
export function countVerifiedButWrong(outcomes: readonly RecordOutcome[], check: CheckResult): number {
  const wrong = new Set(check.mismatches.map((m) => m.recordKey));
  const hits = new Set<string>();
  for (const o of outcomes) if (o.status === "VERIFIED" && wrong.has(o.recordKey)) hits.add(o.recordKey);
  return hits.size;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function datasetHash(s: PublicScenario): string {
  return createHash("sha256").update(JSON.stringify({ goal: s.goal, records: s.records, applications: s.applications })).digest("hex");
}

type Raced<T> = { kind: "done"; value: T } | { kind: "timeout" } | { kind: "aborted" };

/** Race a promise against a timeout and an abort signal. `onSettle` runs once the race is decided. */
async function race<T>(p: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, onSettle?: () => void): Promise<Raced<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race<Raced<T>>([
      p.then((value) => ({ kind: "done" as const, value })),
      new Promise<Raced<T>>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
      new Promise<Raced<T>>((resolve) => {
        if (signal?.aborted) return resolve({ kind: "aborted" });
        onAbort = () => resolve({ kind: "aborted" });
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
    onSettle?.();
  }
}

/** Follow an engine run with a timeout; the stream is closed whichever way the race ends. */
function follow(engine: EngineClient, runId: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<Raced<unknown>> {
  const stop = new AbortController();
  return race(engine.waitForCompletion(runId, { signal: stop.signal }), timeoutMs, signal, () => stop.abort());
}

interface Collected {
  scenario: PublicScenario | null;
  config: RunConfigInput;
  runId: string | null;
  startedAt: number;
  endedAt: number;
  result: RunResultResponse | null;
  external: ExternalResult | null;
  check: CheckResult | null;
  metrics: unknown;
  error?: string;
  interrupted: boolean;
}

/** Build the stored record. Numbers come from the engine summary (or external adapter) and the arena checker only. */
export function buildRecord(run: PlannedRun, c: Collected): BenchmarkRunRecord {
  const external = run.kind === "external";
  const summary = external ? null : (c.result?.summary ?? null);
  const ext = external ? c.external : null;
  const check = c.check;
  let error = c.error;
  if (!error && external && !ext) error = "external baseline returned no result";
  if (!error && ext?.error) error = `external baseline: ${ext.error}`;
  if (!error && !external && !summary) error = "engine returned no run summary";
  if (!error && !external && c.result && c.result.status !== "completed") error = `run ended with status "${c.result.status}"`;
  if (!error && !check) error = "arena check unavailable";
  if (!error && check && c.scenario && check.scenarioId !== c.scenario.scenarioId) {
    error = `arena check is for scenario ${check.scenarioId}, expected ${c.scenario.scenarioId}`;
  }
  // Without a reported duration, the only measured duration is the harness clock.
  const wallMs = summary?.wallMs ?? ext?.wallMs ?? Math.max(0, c.endedAt - c.startedAt);
  const correctPerMin = check && wallMs > 0 ? check.correctRecords / (wallMs / 60_000) : 0;
  const record: BenchmarkRunRecord = {
    suite: run.suite,
    label: run.label,
    mode: run.mode,
    scenarioId: c.scenario?.scenarioId ?? check?.scenarioId ?? "",
    template: run.template,
    seed: run.seed,
    records: run.records,
    trial: run.trial,
    cache: run.cache,
    holdout: run.holdout || (c.scenario?.holdout ?? false),
    runId: c.runId,
    startedAt: c.startedAt,
    summary,
    check,
    wallMs,
    discoveryMs: summary?.discoveryMs ?? 0,
    compileMs: summary?.compileMs ?? 0,
    executionMs: summary?.executionMs ?? 0,
    correctPerMin,
    modelCalls: summary?.modelCalls ?? ext?.modelCalls ?? 0,
    inputTokens: summary?.inputTokens ?? ext?.inputTokens ?? 0,
    outputTokens: summary?.outputTokens ?? ext?.outputTokens ?? 0,
    costUsd: summary?.modelCostUsd ?? ext?.costUsd ?? 0,
    workerUtilization: summary?.workerUtilization ?? 0,
    maxConcurrency: summary?.maxConcurrency ?? 0,
    verifiedButWrong: check && c.result ? countVerifiedButWrong(c.result.outcomes, check) : 0,
    firstActionMs: summary ? (summary.firstActionMs ?? null) : (ext?.firstActionMs ?? null),
    firstVerifiedMs: summary?.firstVerifiedMs ?? null,
    overlapMs: summary?.overlapMs ?? 0,
    recoveryMs: summary?.recoveryMs ?? 0,
    duplicateWrites: check?.duplicateWrites ?? 0,
    collateralWrites: check?.collateralWrites ?? 0,
    condition: run.condition,
    config: c.config,
  };
  if (error) record.error = error;
  return record;
}

/**
 * Execute a plan. Runs are strictly sequential so they never share the arena. The result file is
 * rewritten after every run. Scheduling stops once cumulative reported model cost reaches the
 * budget; runs that were not executed are listed in the notes, never estimated.
 */
export async function runPlan(plan: readonly PlannedRun[], deps: HarnessDeps, opts: HarnessOptions): Promise<HarnessResult> {
  if (plan.some((r) => r.holdout) && !opts.holdoutFreezeId) {
    throw new Error(`The plan contains holdout runs. Set ${HOLDOUT_FREEZE_ENV} to the code-freeze identifier (for example a git tag or commit) before running them.`);
  }
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const createdAt = now();
  const stem = opts.stem ?? timestampStem(createdAt);
  const path = resultFilePath(opts.outDir, stem, opts.suite);
  const metricsDir = join(opts.outDir, "metrics", `${stem}-${opts.suite}`);
  const graceMs = opts.cancelGraceMs ?? 15_000;
  await mkdir(opts.outDir, { recursive: true });

  const file: BenchmarkResultFile = {
    version: 1,
    suite: opts.suite,
    createdAt,
    machine: opts.machine ?? machineInfo(),
    budgetUsd: opts.budgetUsd,
    spentUsd: 0,
    runs: [],
    notes: [...(opts.notes ?? [])],
  };
  if (plan.some((r) => r.holdout)) file.notes.push(`Holdout code freeze: ${opts.holdoutFreezeId}.`);
  const notExecuted: PlannedRun[] = [];
  const failedIndexes = new Set<number>();
  const datasets = new Map<string, { scenarioId: string; hash: string }>();
  let externalSkipNoted = false;
  const save = () => writeJsonAtomic(path, file);

  for (let i = 0; i < plan.length; i++) {
    const run = plan[i]!;
    const tag = `[${i + 1}/${plan.length}] ${run.label} ${run.template} seed=${run.seed} records=${run.records} trial=${run.trial} ${run.condition} ${run.cache}`;

    if (opts.signal?.aborted) {
      notExecuted.push(...plan.slice(i));
      file.notes.push(`Interrupted before run ${i + 1}; ${plan.length - i} planned runs not executed.`);
      break;
    }
    if (file.spentUsd >= opts.budgetUsd) {
      const rest = plan.slice(i);
      notExecuted.push(...rest);
      file.notes.push(
        `Budget cap reached: spent $${file.spentUsd.toFixed(4)} of $${opts.budgetUsd.toFixed(2)}. ${rest.length} planned runs not executed: ${rest
          .map((r) => `${r.label} (${r.records} records, ${r.condition}, trial ${r.trial}, ${r.cache})`)
          .join("; ")}.`,
      );
      log(`budget cap reached ($${file.spentUsd.toFixed(4)} ≥ $${opts.budgetUsd.toFixed(2)}); stopping`);
      break;
    }
    if (run.after !== undefined && failedIndexes.has(run.after)) {
      notExecuted.push(run);
      failedIndexes.add(run.index);
      file.notes.push(`Skipped ${run.label} ${run.cache} trial ${run.trial} (${run.records} records, ${run.condition}): its prerequisite run #${run.after + 1} failed.`);
      log(`${tag} skipped: prerequisite #${run.after + 1} failed`);
      continue;
    }
    if (run.kind === "external" && !deps.external) {
      notExecuted.push(run);
      if (!externalSkipNoted) file.notes.push("External baseline runs skipped: no external baseline adapter is available.");
      externalSkipNoted = true;
      log(`${tag} skipped: no external baseline adapter`);
      continue;
    }

    log(`${tag} starting`);
    const t0 = now();
    const c: Collected = {
      scenario: null,
      config: { goal: "", applications: [], ...run.overrides },
      runId: null,
      startedAt: t0,
      endedAt: t0,
      result: null,
      external: null,
      check: null,
      metrics: undefined,
      interrupted: false,
    };
    try {
      // 1. Identical starting state: the same scenario (or a reset of it), then the run's condition.
      if (run.prepare === "load") await deps.arena.loadScenario({ seed: run.seed, template: run.template, records: run.records });
      else await deps.arena.reset();
      const scenario = await deps.arena.scenario();
      c.scenario = scenario;
      if (scenario.seed !== run.seed || scenario.template !== run.template || scenario.records.length !== run.records) {
        throw new Error(
          `arena scenario mismatch: expected ${run.template} seed ${run.seed} with ${run.records} records, got ${scenario.template} seed ${scenario.seed} with ${scenario.records.length}`,
        );
      }
      const dsKey = `${run.template}|${run.seed}|${run.records}`;
      const hash = datasetHash(scenario);
      const prev = datasets.get(dsKey);
      if (prev && (prev.hash !== hash || prev.scenarioId !== scenario.scenarioId)) {
        throw new Error(`arena returned a different dataset for ${dsKey} than earlier runs in this suite; runs would not be comparable`);
      }
      datasets.set(dsKey, { scenarioId: scenario.scenarioId, hash });
      await deps.arena.setVariations(conditionVariations(run.condition, scenario));

      // 2. Config: scenario goal/apps/records + overrides. Overrides are re-applied so they always win.
      const config: RunConfigInput = { ...deps.buildConfig(scenario, run.overrides), ...run.overrides };
      c.config = config;
      if ((config.records?.length ?? 0) !== scenario.records.length) {
        throw new Error(`run config has ${config.records?.length ?? 0} records but the scenario has ${scenario.records.length}`);
      }

      // 3. Execute, then collect the checker result (and engine result/metrics) immediately.
      if (run.kind === "external" && deps.external) {
        c.startedAt = now();
        const out = await race(deps.external(config, scenario), opts.runTimeoutMs, opts.signal);
        c.endedAt = now();
        if (out.kind === "done") c.external = parseExternalResult(out.value);
        else {
          c.error = out.kind === "timeout" ? `timed out after ${Math.round(opts.runTimeoutMs / 1000)} s (external runs cannot be cancelled)` : "interrupted";
          c.interrupted = out.kind === "aborted";
        }
        try {
          c.check = await deps.arena.check();
        } catch (err) {
          c.error ??= `arena check failed: ${message(err)}`;
        }
      } else {
        c.startedAt = now();
        const started = await deps.engine.start(config);
        c.runId = started.runId;
        const outcome = await follow(deps.engine, started.runId, opts.runTimeoutMs, opts.signal);
        if (outcome.kind !== "done") {
          c.error = outcome.kind === "timeout" ? `timed out after ${Math.round(opts.runTimeoutMs / 1000)} s; run cancelled` : "interrupted; run cancelled";
          c.interrupted = outcome.kind === "aborted";
          await deps.engine.cancel(started.runId).catch((err: unknown) => log(`cancel failed: ${message(err)}`));
          await follow(deps.engine, started.runId, graceMs, undefined).catch(() => undefined);
        }
        c.endedAt = now();
        const [check, result, metrics] = await Promise.allSettled([deps.arena.check(), deps.engine.result(started.runId), deps.engine.metrics(started.runId)]);
        if (check.status === "fulfilled") c.check = check.value;
        else c.error ??= `arena check failed: ${message(check.reason)}`;
        if (result.status === "fulfilled") c.result = result.value;
        else c.error ??= `engine result failed: ${message(result.reason)}`;
        if (metrics.status === "fulfilled") c.metrics = metrics.value;
      }
    } catch (err) {
      c.endedAt = now();
      c.error = message(err);
    }

    const record = buildRecord(run, c);
    file.runs.push(record);
    file.spentUsd = file.runs.reduce((a, r) => a + r.costUsd, 0);
    if (record.error) {
      failedIndexes.add(run.index);
      if (record.runId && !record.summary) file.notes.push(`Run ${record.runId} (${record.label}) has no engine summary; its model cost is unknown and not counted in spend.`);
    }
    // Raw engine metrics have no field in BenchmarkRunRecord; keep them beside the result file.
    if (c.metrics !== undefined && record.runId) {
      try {
        await mkdir(metricsDir, { recursive: true });
        await writeJsonAtomic(join(metricsDir, `${record.runId}.json`), c.metrics);
      } catch (err) {
        log(`could not save metrics for ${record.runId}: ${message(err)}`);
      }
    }
    await save();
    opts.onRecorded?.(record, file);
    log(
      record.error
        ? `${tag} FAILED: ${record.error}`
        : `${tag} done: wall ${(record.wallMs / 1000).toFixed(1)} s, accuracy ${record.check ? `${record.check.correctRecords}/${record.check.totalRecords}` : "n/a"}, cost $${record.costUsd.toFixed(4)}`,
    );
    if (c.interrupted) {
      notExecuted.push(...plan.slice(i + 1));
      file.notes.push(`Interrupted during run ${i + 1}; ${plan.length - i - 1} planned runs not executed.`);
      break;
    }
  }

  await save();
  return { file, path, notExecuted };
}
