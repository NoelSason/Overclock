import type { BrowserContext } from "playwright";
import type { EventSink, RecordOutcome, RunConfig, TaskState, VerificationStatus } from "@overclock/contracts";
import { BrowserWorker, type BrowserManager, type SessionManager } from "@overclock/browser-runtime";
import { BudgetExceededError, ModelUnavailableError, type ClaudeProvider, type ClaudeRole } from "@overclock/models";
import { actionSignature, executeBrowserAction, observeSafe, PageTracker, type AppTarget, type BrowserEnv } from "./browser";
import { describeControl, HISTORY_WINDOW, renderObservation, renderStepPrompt, SequentialStep, SYSTEM_PROMPT, type HistoryEntry, type ItemResultLine, type StepOutcome } from "./prompt";
import type { Observation } from "@overclock/perception";

/**
 * Mode A baseline: the classic sequential computer-use loop (observe → ask the model for the next
 * action → act → repeat), one record at a time on one browser worker. It shares the browser,
 * perception, origin allowlist, and session handling with Overclock, and gets a fresh context per
 * record (task, record, batch notes, this record's history, current page) so prompts stay bounded.
 *
 * Its "done" is the model's claim. Nothing is read back by the system, so no record is ever
 * reported VERIFIED: claimed completions are UNCONFIRMED.
 */

/** The parts of ClaudeProvider the loop uses; a real ClaudeProvider satisfies it. */
export type SequentialModel = Pick<ClaudeProvider, "parse" | "modelFor">;

export interface SequentialAgentDeps {
  config: RunConfig;
  browser: BrowserManager;
  /** Gives a shared logged-in storageState for the apps. */
  sessions: SessionManager;
  /** Records every call into its ModelLedger; the engine forwards ledger entries as model.call events. */
  claude: SequentialModel;
  bus: EventSink & { now(): number };
  signal: AbortSignal;
  /** "helper" (default) = the helper model (Haiku); "planner" = the planner model (Opus) for a strong-baseline run. */
  role?: ClaudeRole;
  /** Default 30. */
  maxStepsPerRecord?: number;
  /** Step cap for the final wrap-up episode. Default 2 × maxStepsPerRecord. */
  maxWrapUpSteps?: number;
  /** Called with a JPEG of the current page after each browser action. */
  thumbnails?: (workerId: string, jpeg: Buffer) => void;
}

export type EpisodeOutcome = StepOutcome | "cancelled" | "not_started";

export interface SequentialEpisodeReport {
  taskId: string;
  recordKey: string;
  kind: "record" | "wrap-up";
  outcome: EpisodeOutcome;
  /** The model's done summary (a claim), or empty. */
  summary: string;
  error?: string;
  steps: number;
  modelCalls: number;
  /** Wall time spent waiting for the model. */
  modelMs: number;
  /** Wall time spent acting in and observing the browser. */
  browserMs: number;
  /** State-changing requests that got a success response during the episode. */
  writes: number;
  wallMs: number;
}

export interface SequentialAgentResult {
  /** One per input record, in input order. */
  outcomes: RecordOutcome[];
  /** Model decisions across all episodes, including the wrap-up. */
  steps: number;
  /** Records the agent finished with done (completed, no_change_needed, or needs_review). */
  recordsDone: number;
  batchNotes: string;
  modelCalls: number;
  modelMs: number;
  browserMs: number;
  wallMs: number;
  writes: number;
  episodes: SequentialEpisodeReport[];
  /** Why the run stopped early (cancelled, budget, model unavailable, setup failure). */
  stopReason?: string;
}

export const SEQUENTIAL_AGENT_ID = "sequential-agent";
export const SEQUENTIAL_WORKER_ID = "w1";
export const SEQUENTIAL_WRAPUP_TASK_ID = "sequential.wrapup";
const WRAPUP_KEY = "batch";
/** ~12k tokens: room for one line per record on 100+ record batches. */
const MAX_BATCH_NOTES = 48_000;
const MAX_CONSECUTIVE_MODEL_ERRORS = 3;
const MAX_SAME_FAILURE = 3;

export function sequentialTaskId(recordKey: string): string {
  return `sequential.record@${recordKey}`;
}

/** Stable display key for a record: an id-like field, else the first primitive value, else its position. */
export function recordKeyOf(rec: Record<string, unknown>, index: number): string {
  const entries = Object.entries(rec).filter(([, v]) => typeof v === "string" || typeof v === "number");
  const pick = entries.find(([k]) => k === "key" || k === "id") ?? entries.find(([k]) => /(Id|_id|ID|Key)$/.test(k)) ?? entries[0];
  return pick ? String(pick[1]) : `#${index + 1}`;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function errMessage(err: unknown): string {
  return clip(err instanceof Error ? err.message : String(err), 300);
}

/** Errors that will not go away by trying again: stop the whole run. */
function fatalReason(err: unknown): string | null {
  if (err instanceof BudgetExceededError) return err.message;
  if (err instanceof ModelUnavailableError) return `Model unavailable: ${err.message}`;
  const status = (err as { status?: unknown }).status;
  if (status === 400 || status === 401 || status === 403 || status === 404) return `Model API rejected the request (HTTP ${status}): ${errMessage(err)}`;
  return null;
}

function describeStep(s: SequentialStep, obs: Observation | null): string {
  const ctl = () => {
    const c = obs?.controls.find((x) => x.id === s.control);
    return `${s.control ?? "?"}${c ? ` (${describeControl(c)})` : ""}`;
  };
  switch (s.action) {
    case "goto":
      return `goto ${s.app ?? "?"} ${s.path ?? "/"}`;
    case "click":
      return `click ${ctl()}`;
    case "fill":
    case "select":
    case "check":
      return `${s.action} ${ctl()} ${JSON.stringify(s.value ?? "")}`;
    case "note":
      return `note ${JSON.stringify(clip(s.notes ?? "", 200))}`;
    case "done":
      return `done ${s.outcome ?? "?"}: ${clip(s.summary ?? "", 200)}`;
  }
}

const TASK_STATE: Record<EpisodeOutcome, TaskState> = {
  completed: "COMPLETED",
  no_change_needed: "SKIPPED",
  needs_review: "NEEDS_APPROVAL",
  failed: "FAILED",
  cancelled: "CANCELLED",
  not_started: "CANCELLED",
};

/** What the baseline can claim per record. Never VERIFIED: "done" is not a system read-back. */
const CLAIM: Record<EpisodeOutcome, VerificationStatus> = {
  completed: "UNCONFIRMED",
  no_change_needed: "UNCONFIRMED",
  needs_review: "NEEDS_APPROVAL",
  failed: "FAILED",
  cancelled: "FAILED",
  not_started: "FAILED",
};

interface EpisodeSpec {
  taskId: string;
  recordKey: string;
  kind: "record" | "wrap-up";
  index: number;
  total: number;
  record: Record<string, unknown>;
  maxSteps: number;
  items: ItemResultLine[];
}

interface Run {
  deps: SequentialAgentDeps;
  role: ClaudeRole;
  env: BrowserEnv;
  apps: AppTarget[];
  batchNotes: string;
  /** Set when the run must stop (cancel or fatal model error). */
  stop: { kind: "cancelled" | "fatal"; reason: string } | null;
}

function appendNotes(run: Run, key: string, text: string | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const line = t.startsWith(key) ? t : `${key}: ${t}`;
  if (run.batchNotes.length + line.length + 1 > MAX_BATCH_NOTES) return `notes not saved: batch notes are full (${MAX_BATCH_NOTES} characters)`;
  run.batchNotes = run.batchNotes ? `${run.batchNotes}\n${line}` : line;
  return null;
}

async function runEpisode(run: Run, spec: EpisodeSpec): Promise<SequentialEpisodeReport> {
  const { deps, env } = run;
  const { bus, signal } = deps;
  const worker = env.worker;
  const started = performance.now();
  const writesAtStart = env.tracker.writes;
  const report: SequentialEpisodeReport = { taskId: spec.taskId, recordKey: spec.recordKey, kind: spec.kind, outcome: "failed", summary: "", steps: 0, modelCalls: 0, modelMs: 0, browserMs: 0, writes: 0, wallMs: 0 };
  const finish = (outcome: EpisodeOutcome, error?: string): SequentialEpisodeReport => {
    report.outcome = outcome;
    if (error) report.error = error;
    report.writes = env.tracker.writes - writesAtStart;
    report.wallMs = performance.now() - started;
    return report;
  };

  bus.emit({ type: "task.state", taskId: spec.taskId, state: "RUNNING", workerId: SEQUENTIAL_WORKER_ID, attempt: 1 });
  const history: HistoryEntry[] = [];
  let b0 = performance.now();
  let obs = await observeSafe(worker.currentPage());
  report.browserMs += performance.now() - b0;

  let modelErrors = 0;
  let lastFailSig: string | null = null;
  let failStreak = 0;
  let refusals = 0;

  for (let step = 1; step <= spec.maxSteps; step++) {
    if (signal.aborted) return finish("cancelled", "Cancelled");
    worker.setState("EXECUTING", { taskId: spec.taskId, app: worker.lastApp, op: "think", label: "Choosing the next action" });
    const user = renderStepPrompt({
      goal: deps.config.goal,
      applications: run.apps,
      phase: spec.kind === "record" ? { kind: "record", index: spec.index, total: spec.total, key: spec.recordKey, record: spec.record } : { kind: "wrap-up", items: spec.items },
      batchNotes: run.batchNotes,
      history: history.slice(-HISTORY_WINDOW),
      historyTotal: history.length,
      page: renderObservation(worker.lastApp, obs),
      step,
      maxSteps: spec.maxSteps,
    });

    const m0 = performance.now();
    let decision: SequentialStep;
    try {
      const res = await deps.claude.parse({ role: run.role, purpose: "baseline.step", system: SYSTEM_PROMPT, user, schema: SequentialStep, maxTokens: 2048, signal });
      decision = res.data;
    } catch (err) {
      report.modelMs += performance.now() - m0;
      if (signal.aborted) return finish("cancelled", "Cancelled");
      const fatal = fatalReason(err);
      if (fatal) {
        run.stop = { kind: "fatal", reason: fatal };
        return finish("failed", fatal);
      }
      report.modelCalls++;
      modelErrors++;
      bus.emit({ type: "log", level: "warn", message: `Sequential agent: model error on ${spec.taskId} step ${step}: ${errMessage(err)}` });
      history.push({ step, action: "(no action)", result: `error: the model response could not be used (${errMessage(err)})` });
      if (modelErrors >= MAX_CONSECUTIVE_MODEL_ERRORS) return finish("failed", `${modelErrors} model errors in a row; last: ${errMessage(err)}`);
      continue;
    }
    const modelMs = performance.now() - m0;
    report.modelMs += modelMs;
    report.modelCalls++;
    report.steps++;
    modelErrors = 0;

    const described = describeStep(decision, obs);
    const thought = clip(decision.thought, 160);
    const noteError = decision.action !== "note" ? appendNotes(run, spec.recordKey, decision.notes) : null;
    const emitAction = (ok: boolean, browserMs: number, result: string) =>
      bus.emit({
        type: "action",
        taskId: spec.taskId,
        nodeId: `${spec.taskId}#${step}`,
        actionType: decision.action,
        ms: Math.round(browserMs * 10) / 10,
        ok,
        modelCalls: 1,
        detail: clip(`${described} → ${result} [model ${Math.round(modelMs)}ms, browser ${Math.round(browserMs)}ms]`, 400),
      });

    if (decision.action === "done") {
      if (!decision.outcome) {
        const result = "error: done needs an outcome (completed, no_change_needed, needs_review, or failed)";
        emitAction(false, 0, result);
        history.push({ step, action: `${described} [why: ${thought}]`, result });
        continue;
      }
      report.summary = clip(decision.summary ?? "", 300);
      emitAction(true, 0, "finished");
      return finish(decision.outcome, decision.outcome === "failed" ? `Agent reported failure: ${report.summary || "no summary"}` : undefined);
    }

    if (decision.action === "note") {
      const error = appendNotes(run, spec.recordKey, decision.notes ?? decision.value);
      const result = error ? `error: ${error}` : decision.notes || decision.value ? "ok: appended to batch notes" : "error: note needs notes text";
      emitAction(!result.startsWith("error"), 0, result);
      history.push({ step, action: `${described} [why: ${thought}]`, result });
      continue;
    }

    // Browser actions.
    const sig = actionSignature(decision);
    let result: string;
    let ok: boolean;
    let browserMs = 0;
    if (sig === lastFailSig && failStreak >= MAX_SAME_FAILURE) {
      refusals++;
      ok = false;
      result = `error: not executed: this exact action already failed ${failStreak} times in a row; choose a different action or finish with done`;
      emitAction(false, 0, result);
      history.push({ step, action: `${described} [why: ${thought}]`, result });
      if (refusals >= 2) return finish("failed", `Stopped after repeating an action that failed ${failStreak} times in a row: ${described}`);
      continue;
    }
    refusals = 0;
    worker.setState("EXECUTING", { taskId: spec.taskId, app: decision.action === "goto" ? decision.app : worker.lastApp, op: decision.action, label: clip(described, 120) });
    b0 = performance.now();
    try {
      const r = await executeBrowserAction(env, decision, obs);
      ok = r.ok;
      result = r.message;
    } catch (err) {
      ok = false;
      result = `error: ${errMessage(err)}`;
    }
    obs = await observeSafe(worker.currentPage());
    browserMs = performance.now() - b0;
    report.browserMs += browserMs;
    if (deps.thumbnails) {
      const jpeg = await worker.thumbnail();
      if (jpeg) deps.thumbnails(SEQUENTIAL_WORKER_ID, jpeg);
    }
    if (ok) {
      lastFailSig = null;
      failStreak = 0;
    } else if (sig === lastFailSig) failStreak++;
    else {
      lastFailSig = sig;
      failStreak = 1;
    }
    if (noteError) result += `; ${noteError}`;
    emitAction(ok, browserMs, result);
    history.push({ step, action: `${described} [why: ${thought}]`, result });
  }
  return finish("failed", `Step limit reached (${spec.maxSteps} steps) without finishing`);
}

export async function runSequentialAgent(deps: SequentialAgentDeps): Promise<SequentialAgentResult> {
  const { config, bus, signal } = deps;
  const role: ClaudeRole = deps.role ?? "helper";
  const maxSteps = deps.maxStepsPerRecord ?? 30;
  const maxWrapUp = deps.maxWrapUpSteps ?? maxSteps * 2;
  const started = performance.now();
  const apps: AppTarget[] = config.applications.map((a) => ({ name: a.name, origin: new URL(a.origin).origin }));
  const allowedOrigins = new Set(apps.map((a) => a.origin));

  const used = new Map<string, number>();
  const records = config.records.map((rec, index) => {
    let key = recordKeyOf(rec, index);
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    if (n > 1) key = `${key}#${n}`;
    return { key, rec, index, taskId: sequentialTaskId(key) };
  });

  bus.emit({ type: "run.status", status: "running" });
  bus.emit({ type: "agent.started", agentId: SEQUENTIAL_AGENT_ID, role: "planner", label: "Sequential agent", model: deps.claude.modelFor(role) });
  const tasks = records.map((r) => ({ taskId: r.taskId, segmentId: "sequential.record", phaseId: "sequential", recordKey: r.key }));
  if (records.length) tasks.push({ taskId: SEQUENTIAL_WRAPUP_TASK_ID, segmentId: "sequential.wrapup", phaseId: "sequential", recordKey: WRAPUP_KEY });
  bus.emit({ type: "tasks.created", tasks });
  for (const t of tasks) bus.emit({ type: "task.state", taskId: t.taskId, state: "READY" });

  const episodes: SequentialEpisodeReport[] = [];
  const byKey = new Map<string, SequentialEpisodeReport>();
  let context: BrowserContext | null = null;
  let worker: BrowserWorker | null = null;
  let run: Run | null = null;
  let setupError: string | undefined;

  const endTask = (taskId: string, ep: SequentialEpisodeReport) => {
    const state: TaskState = ep.outcome === "not_started" && (setupError !== undefined || run?.stop?.kind === "fatal") ? "FAILED" : TASK_STATE[ep.outcome];
    bus.emit({ type: "task.state", taskId, state, workerId: SEQUENTIAL_WORKER_ID, ms: Math.round(ep.wallMs), ...(ep.error ? { error: ep.error } : {}) });
  };
  const notStarted = (taskId: string, recordKey: string, kind: "record" | "wrap-up", reason: string): SequentialEpisodeReport => ({
    taskId,
    recordKey,
    kind,
    outcome: "not_started",
    summary: "",
    error: reason,
    steps: 0,
    modelCalls: 0,
    modelMs: 0,
    browserMs: 0,
    writes: 0,
    wallMs: 0,
  });

  try {
    const storageState = await deps.sessions.storageStateFor(apps);
    context = await deps.browser.newContext({ allowedOrigins: [...allowedOrigins], storageState, ...(config.dryRun ? { blockMutations: true } : {}) });
    worker = new BrowserWorker(SEQUENTIAL_WORKER_ID, context, new Map(apps.map((a) => [a.name, a.origin])), (w, state, info) =>
      bus.emit({ type: "worker.state", workerId: w.id, state, ...(info.taskId ? { taskId: info.taskId } : {}), ...(info.app ? { app: info.app } : {}), ...(info.op ? { op: info.op } : {}), ...(info.label ? { label: info.label } : {}) }),
    );
    worker.setState("IDLE");
    run = { deps, role, env: { worker, apps, allowedOrigins, tracker: new PageTracker() }, apps, batchNotes: "", stop: null };
  } catch (err) {
    setupError = `Setup failed: ${errMessage(err)}`;
    bus.emit({ type: "log", level: "error", message: `Sequential agent: ${setupError}` });
  }

  try {
    for (const r of records) {
      if (run && !run.stop && signal.aborted) run.stop = { kind: "cancelled", reason: "Cancelled" };
      let ep: SequentialEpisodeReport;
      if (!run || run.stop) {
        ep = notStarted(r.taskId, r.key, "record", setupError ?? run?.stop?.reason ?? "Not started");
      } else {
        try {
          ep = await runEpisode(run, { taskId: r.taskId, recordKey: r.key, kind: "record", index: r.index, total: records.length, record: r.rec, maxSteps, items: [] });
        } catch (err) {
          ep = { ...notStarted(r.taskId, r.key, "record", `Episode crashed: ${errMessage(err)}`), outcome: "failed" };
        }
        if (ep.outcome === "cancelled") run.stop ??= { kind: "cancelled", reason: "Cancelled" };
        worker?.setState("IDLE");
      }
      episodes.push(ep);
      byKey.set(r.key, ep);
      endTask(r.taskId, ep);
      bus.emit({ type: "receipt", taskId: r.taskId, recordKey: r.key, status: CLAIM[ep.outcome], nodeId: "sequential.done", fields: [] });
    }

    if (records.length) {
      if (run && !run.stop && signal.aborted) run.stop = { kind: "cancelled", reason: "Cancelled" };
      let ep: SequentialEpisodeReport;
      if (!run || run.stop) ep = notStarted(SEQUENTIAL_WRAPUP_TASK_ID, WRAPUP_KEY, "wrap-up", setupError ?? run?.stop?.reason ?? "Not started");
      else {
        const items: ItemResultLine[] = records.map((r) => {
          const e = byKey.get(r.key);
          return { key: r.key, outcome: e?.outcome ?? "not_started", summary: e?.summary || e?.error || "" };
        });
        try {
          ep = await runEpisode(run, { taskId: SEQUENTIAL_WRAPUP_TASK_ID, recordKey: WRAPUP_KEY, kind: "wrap-up", index: records.length, total: records.length, record: {}, maxSteps: maxWrapUp, items });
        } catch (err) {
          ep = { ...notStarted(SEQUENTIAL_WRAPUP_TASK_ID, WRAPUP_KEY, "wrap-up", `Episode crashed: ${errMessage(err)}`), outcome: "failed" };
        }
        if (ep.outcome === "cancelled") run.stop ??= { kind: "cancelled", reason: "Cancelled" };
        worker?.setState("IDLE");
      }
      episodes.push(ep);
      endTask(SEQUENTIAL_WRAPUP_TASK_ID, ep);
    }
  } finally {
    if (worker) await worker.close();
    else if (context) await context.close().catch(() => undefined);
  }

  const outcomes: RecordOutcome[] = records.map((r) => {
    const ep = byKey.get(r.key)!;
    const notes = [`outcome: ${ep.outcome}${ep.outcome === "completed" || ep.outcome === "no_change_needed" ? " (model claim, not verified by read-back)" : ""}`];
    if (ep.summary) notes.push(ep.summary);
    if (ep.error) notes.push(ep.error);
    return { recordKey: r.key, status: CLAIM[ep.outcome], writes: ep.writes, receipts: [], notes };
  });

  const stopReason = setupError ?? run?.stop?.reason;
  const sum = (f: (e: SequentialEpisodeReport) => number) => episodes.reduce((s, e) => s + f(e), 0);
  const result: SequentialAgentResult = {
    outcomes,
    steps: sum((e) => e.steps),
    recordsDone: episodes.filter((e) => e.kind === "record" && (e.outcome === "completed" || e.outcome === "no_change_needed" || e.outcome === "needs_review")).length,
    batchNotes: run?.batchNotes ?? "",
    modelCalls: sum((e) => e.modelCalls),
    modelMs: sum((e) => e.modelMs),
    browserMs: sum((e) => e.browserMs),
    wallMs: performance.now() - started,
    writes: sum((e) => e.writes),
    episodes,
    ...(stopReason ? { stopReason } : {}),
  };
  const ok = !setupError && run?.stop?.kind !== "fatal";
  bus.emit({ type: "agent.finished", agentId: SEQUENTIAL_AGENT_ID, ok, ms: Math.round(result.wallMs), ...(stopReason ? { error: stopReason } : {}) });
  return result;
}
