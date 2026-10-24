import type { EngineHealth, RecordOutcome, RunConfig, RunEvent, RunListItem, RunResultResponse, RunStatus, RunView, TaskState, VerificationStatus } from "@overclock/contracts";
import { applyEvent, createRunView, deriveMetrics, TERMINAL_TASK_STATES } from "@overclock/contracts";
import { withSummaryDefaults, type EngineStore, type StoredReceipt, type StoredRun } from "./store";
import type { RunHandle, RunManager } from "./types";

/**
 * Read-only handles for runs that exist in the store but are not live in this process
 * (typically: the engine restarted). Everything is rebuilt from the append-only event log.
 *
 * A run with no `run.completed` event was interrupted. It is reported as `failed` with
 * RESTART_REASON, and tasks that may have been mid-write are reported UNCONFIRMED: the engine
 * cannot know whether those writes committed, so it never claims success or failure for them.
 */

export const RESTART_REASON = "engine restarted during the run";

/**
 * Task states where a write may have been in flight. REPAIRING is included alongside the
 * lease/run/verify/reconcile states because a repair can re-execute the failed write.
 */
export const UNCERTAIN_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>(["LEASED", "RUNNING", "VERIFYING", "RECONCILING", "REPAIRING"]);

export const VERIFICATION_SEMANTICS =
  "An outcome is VERIFIED only when every state-changing step for that record was read back from the application after a fresh navigation and matched the expected values, and no task for the record FAILED or is UNCONFIRMED. UNCONFIRMED means a write may or may not have committed and could not be confirmed; reconcile it before retrying. Otherwise the record reports its worst status (UNCONFIRMED > FAILED > NEEDS_APPROVAL > SKIPPED).";

/** Worst-first ordering. UNCONFIRMED dominates FAILED: an unknown write must be reconciled before any retry. */
const SEVERITY: Record<VerificationStatus, number> = { VERIFIED: 0, SKIPPED: 1, NEEDS_APPROVAL: 2, FAILED: 3, UNCONFIRMED: 4 };

export interface TaskLike {
  taskId: string;
  recordKey: string;
  state: TaskState;
  attempts: number;
  lastError?: string | undefined;
}

/** True when a non-terminal task may have started a write (so its outcome is unknown). */
export function isUncertainTask(task: Pick<TaskLike, "state" | "attempts">): boolean {
  if (TERMINAL_TASK_STATES.has(task.state)) return false;
  return UNCERTAIN_TASK_STATES.has(task.state) || task.attempts > 0;
}

interface Contribution {
  status: VerificationStatus;
  /** Explicitly SKIPPED tasks are neutral: they do not prevent VERIFIED on their own. */
  neutral: boolean;
  note?: string | undefined;
}

function taskContribution(task: TaskLike, interrupted: boolean): Contribution {
  const err = task.lastError ? `: ${task.lastError}` : "";
  switch (task.state) {
    case "VERIFIED":
    case "COMPLETED":
      return { status: "VERIFIED", neutral: false };
    case "FAILED":
      return { status: "FAILED", neutral: false, note: `task ${task.taskId} FAILED${err}` };
    case "UNCONFIRMED":
      return { status: "UNCONFIRMED", neutral: false, note: `task ${task.taskId} UNCONFIRMED${err}` };
    case "NEEDS_APPROVAL":
      return { status: "NEEDS_APPROVAL", neutral: false, note: `task ${task.taskId} is waiting for approval` };
    case "SKIPPED":
      return { status: "SKIPPED", neutral: true, note: `task ${task.taskId} SKIPPED${err}` };
    case "CANCELLED":
      return { status: "SKIPPED", neutral: false, note: `task ${task.taskId} was cancelled before it completed` };
    default: {
      const when = interrupted ? `when the ${RESTART_REASON}` : "when the run ended";
      if (isUncertainTask(task)) {
        return { status: "UNCONFIRMED", neutral: false, note: `task ${task.taskId} was ${task.state} ${when}; its write may or may not have committed` };
      }
      return { status: "SKIPPED", neutral: false, note: `task ${task.taskId} never started (${task.state} ${when})` };
    }
  }
}

function receiptLabel(r: StoredReceipt): string {
  return `${r.taskId}/${r.nodeId}:${r.status}`;
}

function receiptNote(r: StoredReceipt): string {
  const mismatched = r.fields.filter((f) => JSON.stringify(f.expected) !== JSON.stringify(f.actual)).map((f) => f.name);
  return `receipt ${r.taskId}/${r.nodeId} ${r.status}${mismatched.length ? ` (mismatched: ${mismatched.join(", ")})` : ""}`;
}

/**
 * Per-record outcome from the task ledger and the verification receipts.
 * VERIFIED only if every write receipt for the record is VERIFIED and every task completed or
 * verified (explicitly SKIPPED tasks are neutral); otherwise the worst status.
 */
export function recordOutcomes(tasks: readonly TaskLike[], receipts: readonly StoredReceipt[], opts: { interrupted: boolean }): RecordOutcome[] {
  const byRecord = new Map<string, { contributions: Contribution[]; receipts: StoredReceipt[] }>();
  const entry = (key: string) => {
    let e = byRecord.get(key);
    if (!e) byRecord.set(key, (e = { contributions: [], receipts: [] }));
    return e;
  };
  for (const t of tasks) entry(t.recordKey).contributions.push(taskContribution(t, opts.interrupted));
  for (const r of receipts) {
    const e = entry(r.recordKey);
    e.receipts.push(r);
    e.contributions.push({ status: r.status, neutral: false, note: r.status === "VERIFIED" ? undefined : receiptNote(r) });
  }
  const out: RecordOutcome[] = [];
  for (const [recordKey, e] of byRecord) {
    const decisive = e.contributions.filter((c) => !c.neutral);
    let status: VerificationStatus;
    if (decisive.length > 0 && decisive.every((c) => c.status === "VERIFIED")) status = "VERIFIED";
    else {
      status = "SKIPPED";
      for (const c of e.contributions) if (c.status !== "VERIFIED" && SEVERITY[c.status] > SEVERITY[status]) status = c.status;
    }
    out.push({
      recordKey,
      status,
      writes: e.receipts.length,
      receipts: e.receipts.map(receiptLabel),
      notes: e.contributions.flatMap((c) => (c.note ? [c.note] : [])),
    });
  }
  return out.sort((a, b) => a.recordKey.localeCompare(b.recordKey, undefined, { numeric: true }));
}

function bump(counts: Partial<Record<string, number>>, key: string, delta: number): void {
  counts[key] = (counts[key] ?? 0) + delta;
  if (counts[key] === 0) delete counts[key];
}

/** Copy of a replayed view with the restart applied: run failed, in-flight tasks UNCONFIRMED, workers and open stages stopped. */
function interruptedView(base: RunView): RunView {
  const v = structuredClone(base);
  v.status = "failed";
  v.phaseT.failed ??= v.lastT;
  for (const task of Object.values(v.tasks)) {
    if (!isUncertainTask(task)) continue;
    const sc = (v.segmentCounts[task.segmentId] ??= {});
    bump(sc, task.state, -1);
    bump(v.taskCounts, task.state, -1);
    task.state = "UNCONFIRMED";
    bump(sc, "UNCONFIRMED", 1);
    bump(v.taskCounts, "UNCONFIRMED", 1);
    task.lastError = RESTART_REASON;
    task.endedT ??= v.lastT;
  }
  for (const w of Object.values(v.workers)) {
    if (w.state === "IDLE" || w.state === "STOPPED") continue;
    w.busyMs += Math.max(0, v.lastT - w.sinceT);
    w.state = "STOPPED";
    w.sinceT = v.lastT;
    w.taskId = undefined;
    w.op = undefined;
  }
  for (const st of v.stages) st.end ??= v.lastT;
  v.logs.push({ t: v.lastT, level: "error", message: `Run failed: ${RESTART_REASON}` });
  return v;
}

const NOOP = (): void => undefined;

export class HistoricalRunHandle implements RunHandle {
  readonly runId: string;
  readonly config: RunConfig;
  readonly createdAt: number;
  private run: StoredRun;
  private replayed: RunView;
  private corrected: { seq: number; view: RunView } | undefined;

  constructor(
    private readonly store: EngineStore,
    runOrId: string | StoredRun,
  ) {
    const run = typeof runOrId === "string" ? store.getRun(runOrId) : runOrId;
    if (!run) throw new Error(`run ${String(runOrId)} not found in store`);
    this.run = run;
    this.runId = run.runId;
    this.config = run.config;
    this.createdAt = run.createdAt;
    this.replayed = createRunView(run.runId);
  }

  static load(store: EngineStore, runId: string): HistoricalRunHandle | undefined {
    const run = store.getRun(runId);
    return run ? new HistoricalRunHandle(store, run) : undefined;
  }

  /** Apply any events persisted since the last replay (normally none for a historical run). */
  private refresh(): void {
    if (this.store.lastSeq(this.runId) <= this.replayed.lastSeq) return;
    for (const e of this.store.iterateEvents(this.runId, this.replayed.lastSeq)) applyEvent(this.replayed, e);
    // Summaries written before newer RunSummary fields existed get the schema defaults.
    if (this.replayed.summary) this.replayed.summary = withSummaryDefaults(this.replayed.summary);
    this.run = this.store.getRun(this.runId) ?? this.run;
  }

  /** True when the log contains run.completed. */
  completed(): boolean {
    this.refresh();
    return this.run.summary !== undefined;
  }

  /** True when the run has no run.completed: the engine stopped while it was in progress. */
  interrupted(): boolean {
    return !this.completed();
  }

  status(): RunStatus {
    return this.completed() ? (this.run.summary?.status ?? this.replayed.status) : "failed";
  }

  /** Pure replay for completed runs; for interrupted runs, the replay with the restart applied. */
  view(): RunView {
    if (this.completed()) return this.replayed;
    if (this.corrected?.seq !== this.replayed.lastSeq) this.corrected = { seq: this.replayed.lastSeq, view: interruptedView(this.replayed) };
    return this.corrected.view;
  }

  events(after: number, limit = 1000): RunEvent[] {
    return this.store.events(this.runId, after, limit);
  }

  /** Historical runs never emit. */
  subscribe(_listener: (e: RunEvent) => void): () => void {
    return NOOP;
  }

  /**
   * Always true: a historical run is either completed or interrupted, and in both cases no
   * further events will be appended by this process, so a stream can close after replay.
   * Use completed() for the literal "has run.completed" check.
   */
  finished(): boolean {
    return true;
  }

  result(): RunResultResponse {
    const interrupted = this.interrupted();
    return {
      runId: this.runId,
      status: this.status(),
      summary: this.run.summary ?? null,
      outcomes: recordOutcomes(this.store.tasks(this.runId), this.store.receipts(this.runId), { interrupted }),
      verificationSemantics: VERIFICATION_SEMANTICS,
    };
  }

  /** deriveMetrics(view) (incl. firstActionMs / firstVerifiedMs / overlapMs), overlaid with metrics the run saved. */
  metrics(): unknown {
    return { ...deriveMetrics(this.view()), ...this.store.getMetrics(this.runId) };
  }

  trace(): unknown {
    return this.store.getSpans(this.runId) ?? { resourceSpans: [] };
  }

  artifact(artifactId: string): unknown | undefined {
    return this.store.getArtifact(this.runId, artifactId);
  }

  /** Thumbnails are live-only (not persisted). */
  thumbnail(_workerId: string): Buffer | undefined {
    return undefined;
  }

  program(): unknown | undefined {
    return this.store.getProgram(this.runId) ?? this.view().program;
  }

  cancel(_reason?: string): void {}
  pause(): void {}
  resume(): void {}
  approve(_approvalId: string, _approved: boolean): boolean {
    return false;
  }
}

export function loadHistoricalRuns(store: EngineStore): HistoricalRunHandle[] {
  return store.listRuns().flatMap((r) => HistoricalRunHandle.load(store, r.runId) ?? []);
}

/**
 * RunManager that serves live runs from `live` and falls back to the store for everything
 * else, so runs from before an engine restart stay listable and inspectable.
 * Assumes one engine process per database file.
 */
export class ManagerWithHistory implements RunManager {
  private readonly historical = new Map<string, HistoricalRunHandle>();

  constructor(
    readonly live: RunManager,
    readonly store: EngineStore,
  ) {}

  create(config: RunConfig): Promise<RunHandle> {
    return this.live.create(config);
  }

  get(runId: string): RunHandle | undefined {
    const live = this.live.get(runId);
    if (live) return live;
    let h = this.historical.get(runId);
    if (!h) {
      h = HistoricalRunHandle.load(this.store, runId);
      if (h) this.historical.set(runId, h);
    }
    return h;
  }

  list(): RunListItem[] {
    const live = this.live.list();
    const seen = new Set(live.map((r) => r.runId));
    const past = this.store
      .listRuns()
      .filter((r) => !seen.has(r.runId))
      .map((r): RunListItem => (r.summary ? r : { ...r, status: "failed" }));
    return [...live, ...past].sort((a, b) => b.createdAt - a.createdAt);
  }

  health(): Promise<EngineHealth> {
    return this.live.health();
  }
}
