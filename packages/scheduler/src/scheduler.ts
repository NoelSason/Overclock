import type { TaskState } from "@overclock/contracts";
import { TERMINAL_TASK_STATES } from "@overclock/contracts";
import { evaluate, renderTemplate, toStr, type CompiledProgram, type CompiledSegment, type PhaseInfo } from "@overclock/compiler";
import { LockManager } from "./locks";

/** Record scope shared by every segment of one record (mirrors browser-runtime's RecordScope). */
export interface RecordScope {
  key: string;
  rec: Record<string, unknown>;
  input: Record<string, unknown>;
  out: Record<string, unknown>;
  phase: Record<string, unknown>;
}

export interface RecordState {
  key: string;
  index: number;
  phaseId: string;
  scope: RecordScope;
  tasks: Map<string, TaskInstance>;
}

export interface TaskInstance {
  taskId: string;
  phaseId: string;
  segmentId: string;
  recordKey: string;
  segment: CompiledSegment;
  record: RecordState;
  deps: Set<string>;
  dependents: Set<string>;
  state: TaskState;
  attempt: number;
  priority: number;
  notBefore: number;
  workerId?: string | undefined;
  leaseUntil?: number | undefined;
  lockKeys: string[];
  readyAt?: number | undefined;
  startedAt?: number | undefined;
  endedAt?: number | undefined;
  error?: string | undefined;
  inline: boolean;
  /** Node ids whose outputs this task produced (cleared on invalidation). */
  produced: string[];
}

export interface SchedulerHooks {
  now(): number;
  onTasksCreated?(tasks: TaskInstance[]): void;
  onTaskState?(task: TaskInstance, state: TaskState, extra: { error?: string; workerId?: string; attempt?: number; ms?: number }): void;
  onLockConflict?(task: TaskInstance, key: string, holder: string): void;
  onPhaseComplete?(phaseId: string): void;
  onPhaseError?(phaseId: string, error: string): void;
}

export interface SchedulerOptions {
  criticalPathPriority: boolean;
  leaseMs: (t: TaskInstance) => number;
  /** Restrict a foreach phase to these record keys (strategy switching / partial runs). */
  recordFilter?: (phaseId: string, key: string) => boolean;
}

const ACTIVE: ReadonlySet<TaskState> = new Set(["LEASED", "RUNNING", "VERIFYING", "REPAIRING", "RECONCILING"]);

export class Scheduler {
  readonly tasks = new Map<string, TaskInstance>();
  readonly records = new Map<string, RecordState>();
  readonly phaseOutputs: Record<string, unknown> = {};
  readonly locks = new LockManager();
  private readonly phaseState = new Map<string, "pending" | "expanded" | "done" | "error">();
  private readonly phaseTasks = new Map<string, Set<string>>();
  private ready: TaskInstance[] = [];
  private readonly suspended = new Map<string, string>();
  private readonly phases: Map<string, PhaseInfo>;
  private recordSeq = 0;
  /** Duplicate record keys seen during expansion (same task arriving twice). */
  readonly duplicatesDropped: string[] = [];

  constructor(
    readonly compiled: CompiledProgram,
    readonly inputs: Record<string, unknown>,
    private readonly hooks: SchedulerHooks,
    private readonly opts: SchedulerOptions,
  ) {
    this.phases = new Map(compiled.phases.map((p) => [p.id, p]));
    for (const p of compiled.phases) this.phaseState.set(p.id, "pending");
  }

  start(): void {
    this.expandReadyPhases();
  }

  private expandReadyPhases(): void {
    for (const p of this.compiled.phases) {
      if (this.phaseState.get(p.id) !== "pending") continue;
      if (!p.dependsOn.every((d) => this.phaseState.get(d) === "done" || this.phaseState.get(d) === "error")) continue;
      this.expand(p);
    }
  }

  private expand(phase: PhaseInfo): void {
    this.phaseState.set(phase.id, "expanded");
    const created: TaskInstance[] = [];
    const items: { key: string; rec: Record<string, unknown> }[] = [];
    try {
      if (phase.kind === "once") items.push({ key: "_", rec: {} });
      else {
        const base = { input: this.inputs, phase: this.phaseOutputs, out: {}, rec: {} };
        const list = evaluate(phase.over ?? "[]", base);
        if (!Array.isArray(list)) throw new Error(`foreach ${phase.id}: 'over' did not evaluate to a list`);
        if (phase.maxIterations !== undefined && list.length > phase.maxIterations) throw new Error(`foreach ${phase.id}: ${list.length} items exceed maxIterations ${phase.maxIterations}`);
        const seen = new Set<string>();
        for (const raw of list) {
          const rec = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : { value: raw };
          const key = toStr(evaluate(phase.key ?? "$rec.id", { ...base, rec }));
          if (!key) throw new Error(`foreach ${phase.id}: record without a key`);
          if (seen.has(key)) {
            this.duplicatesDropped.push(`${phase.id}:${key}`);
            continue;
          }
          seen.add(key);
          if (this.opts.recordFilter && !this.opts.recordFilter(phase.id, key)) continue;
          items.push({ key, rec });
        }
      }
    } catch (err) {
      this.phaseState.set(phase.id, "error");
      this.hooks.onPhaseError?.(phase.id, (err as Error).message);
      this.expandReadyPhases();
      return;
    }
    const ids = new Set<string>();
    this.phaseTasks.set(phase.id, ids);
    const segs = phase.segmentIds.map((id) => this.compiled.segments.get(id)!);
    for (const item of items) {
      const record: RecordState = {
        key: item.key,
        index: this.recordSeq++,
        phaseId: phase.id,
        scope: { key: item.key, rec: item.rec, input: this.inputs, out: {}, phase: this.phaseOutputs },
        tasks: new Map(),
      };
      this.records.set(`${phase.id}|${item.key}`, record);
      for (const seg of segs) {
        const taskId = `${seg.id}@${item.key}`;
        if (this.tasks.has(taskId)) {
          this.duplicatesDropped.push(taskId);
          continue;
        }
        const t: TaskInstance = {
          taskId,
          phaseId: phase.id,
          segmentId: seg.id,
          recordKey: item.key,
          segment: seg,
          record,
          deps: new Set(seg.dependsOn.map((d) => `${d}@${item.key}`)),
          dependents: new Set(),
          state: "PENDING",
          attempt: 0,
          priority: this.priorityOf(seg, record),
          notBefore: 0,
          lockKeys: [],
          inline: !seg.app,
          produced: [],
        };
        this.tasks.set(taskId, t);
        record.tasks.set(seg.id, t);
        ids.add(taskId);
        created.push(t);
      }
      for (const t of record.tasks.values()) for (const d of t.deps) this.tasks.get(d)?.dependents.add(t.taskId);
    }
    this.hooks.onTasksCreated?.(created);
    for (const t of created) if (t.deps.size === 0) this.makeReady(t);
    if (ids.size === 0) this.finishPhase(phase.id);
  }

  private priorityOf(seg: CompiledSegment, record: RecordState): number {
    if (!this.opts.criticalPathPriority) return -record.index;
    // Bottom level (ms) dominates; earlier records break ties so records complete progressively.
    return (this.compiled.priority.get(seg.id) ?? 0) * 1000 - record.index;
  }

  private setState(t: TaskInstance, state: TaskState, extra: { error?: string; workerId?: string; attempt?: number; ms?: number } = {}): void {
    t.state = state;
    if (extra.error) t.error = extra.error;
    this.hooks.onTaskState?.(t, state, extra);
  }

  private makeReady(t: TaskInstance): void {
    if (t.state !== "PENDING") return;
    t.readyAt = this.hooks.now();
    this.setState(t, "READY");
    this.insertReady(t);
  }

  private insertReady(t: TaskInstance): void {
    let lo = 0;
    let hi = this.ready.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ready[mid]!.priority >= t.priority) lo = mid + 1;
      else hi = mid;
    }
    this.ready.splice(lo, 0, t);
  }

  private renderLocks(t: TaskInstance): string[] {
    const scope = { rec: t.record.scope.rec, out: t.record.scope.out, input: t.record.scope.input, phase: t.record.scope.phase, key: t.recordKey };
    return t.segment.writes.map((w) => {
      try {
        return renderTemplate(w, scope);
      } catch {
        return w.replace(/\{.*$/, "*"); // unresolvable: lock conservatively by prefix
      }
    });
  }

  /** Lease the highest-priority runnable browser task. */
  lease(workerId: string, canRun: (app: string) => boolean): TaskInstance | null {
    const now = this.hooks.now();
    for (let i = 0; i < this.ready.length; i++) {
      const t = this.ready[i]!;
      if (t.inline || t.notBefore > now || this.suspended.has(t.segmentId)) continue;
      if (!canRun(t.segment.app!)) continue;
      const keys = this.renderLocks(t);
      if (keys.length) {
        const r = this.locks.tryAcquire(keys, t.taskId);
        if (!r.ok) {
          this.hooks.onLockConflict?.(t, r.key, r.holder);
          continue;
        }
      }
      this.ready.splice(i, 1);
      t.lockKeys = keys;
      t.workerId = workerId;
      t.attempt++;
      t.leaseUntil = now + this.opts.leaseMs(t);
      t.startedAt = now;
      this.setState(t, "LEASED", { workerId, attempt: t.attempt });
      return t;
    }
    return null;
  }

  /** Take a ready browser-free (compute) task. */
  takeInline(): TaskInstance | null {
    const i = this.ready.findIndex((t) => t.inline && !this.suspended.has(t.segmentId));
    if (i < 0) return null;
    const [t] = this.ready.splice(i, 1);
    t!.attempt++;
    t!.startedAt = this.hooks.now();
    this.setState(t!, "RUNNING", { attempt: t!.attempt });
    return t!;
  }

  mark(taskId: string, state: "RUNNING" | "VERIFYING" | "REPAIRING" | "RECONCILING", extra: { workerId?: string } = {}): void {
    const t = this.tasks.get(taskId);
    if (t && ACTIVE.has(t.state)) this.setState(t, state, extra);
  }

  private release(t: TaskInstance): void {
    this.locks.release(t.taskId);
    t.lockKeys = [];
    t.workerId = undefined;
    t.leaseUntil = undefined;
  }

  complete(taskId: string, state: "VERIFIED" | "COMPLETED" | "SKIPPED", produced: string[], ms?: number): void {
    const t = this.tasks.get(taskId);
    if (!t || TERMINAL_TASK_STATES.has(t.state)) return;
    this.release(t);
    t.produced = produced;
    t.endedAt = this.hooks.now();
    this.setState(t, state, { ms });
    for (const d of t.dependents) {
      const dt = this.tasks.get(d)!;
      if (dt.state === "PENDING" && [...dt.deps].every((x) => {
        const s = this.tasks.get(x)!.state;
        return s === "VERIFIED" || s === "COMPLETED" || s === "SKIPPED";
      }))
        this.makeReady(dt);
    }
    this.checkPhase(t.phaseId);
  }

  /** Put a task back in the ready queue after a transient failure. */
  retry(taskId: string, delayMs: number, error: string): void {
    const t = this.tasks.get(taskId);
    if (!t || TERMINAL_TASK_STATES.has(t.state)) return;
    this.release(t);
    t.notBefore = this.hooks.now() + delayMs;
    t.state = "PENDING";
    this.setState(t, "READY", { error, attempt: t.attempt });
    t.readyAt = this.hooks.now();
    this.insertReady(t);
  }

  /** Terminal failure; dependents that can no longer run are skipped. */
  fail(taskId: string, state: "FAILED" | "UNCONFIRMED" | "NEEDS_APPROVAL" | "CANCELLED", error: string): void {
    const t = this.tasks.get(taskId);
    if (!t || TERMINAL_TASK_STATES.has(t.state)) return;
    this.release(t);
    this.ready = this.ready.filter((x) => x !== t);
    t.endedAt = this.hooks.now();
    this.setState(t, state, { error });
    const cascade = (id: string) => {
      for (const d of this.tasks.get(id)!.dependents) {
        const dt = this.tasks.get(d)!;
        if (TERMINAL_TASK_STATES.has(dt.state)) continue;
        this.ready = this.ready.filter((x) => x !== dt);
        dt.endedAt = this.hooks.now();
        this.setState(dt, "SKIPPED", { error: `upstream ${taskId} ${state.toLowerCase()}` });
        cascade(d);
      }
    };
    cascade(taskId);
    this.checkPhase(t.phaseId);
  }

  /**
   * Stale-data invalidation: the data a write was computed from changed. Reset the write task
   * and every upstream non-write task of the same record (their outputs are discarded) so they
   * re-read fresh state; verified writes are never re-executed.
   */
  invalidate(taskId: string, reason: string): string[] {
    const t = this.tasks.get(taskId);
    if (!t) return [];
    const reset: TaskInstance[] = [];
    const visit = (id: string) => {
      const x = this.tasks.get(id)!;
      if (reset.includes(x)) return;
      if (x !== t && (x.segment.kind === "write" || x.state === "VERIFIED")) return;
      reset.push(x);
      for (const d of x.deps) visit(d);
    };
    visit(taskId);
    for (const x of reset) {
      if (x !== t && ACTIVE.has(x.state)) continue;
      this.release(x);
      this.ready = this.ready.filter((r) => r !== x);
      for (const nodeId of x.produced) delete x.record.scope.out[nodeId];
      x.produced = [];
      x.state = "PENDING";
      this.setState(x, "PENDING", { error: x === t ? reason : `invalidated by ${taskId}` });
    }
    for (const x of reset) if ([...x.deps].every((d) => ["VERIFIED", "COMPLETED", "SKIPPED"].includes(this.tasks.get(d)!.state))) this.makeReady(x);
    return reset.map((x) => x.taskId);
  }

  suspendSegment(segmentId: string, reason: string): void {
    this.suspended.set(segmentId, reason);
    for (const t of this.ready) if (t.segmentId === segmentId) this.setState(t, "SUSPENDED", { error: reason });
  }

  resumeSegment(segmentId: string): void {
    if (!this.suspended.delete(segmentId)) return;
    for (const t of this.ready) if (t.segmentId === segmentId && t.state === "SUSPENDED") this.setState(t, "READY");
  }

  isSuspended(segmentId: string): boolean {
    return this.suspended.has(segmentId);
  }

  /** Tasks whose lease deadline passed (stalled workers). */
  expired(): TaskInstance[] {
    const now = this.hooks.now();
    return [...this.tasks.values()].filter((t) => t.leaseUntil !== undefined && t.leaseUntil < now && ACTIVE.has(t.state));
  }

  extendLease(taskId: string, ms: number): void {
    const t = this.tasks.get(taskId);
    if (t?.leaseUntil !== undefined) t.leaseUntil = this.hooks.now() + ms;
  }

  cancelAll(reason: string): void {
    for (const t of this.tasks.values()) if (!TERMINAL_TASK_STATES.has(t.state) && !ACTIVE.has(t.state)) {
      this.ready = this.ready.filter((x) => x !== t);
      this.setState(t, "CANCELLED", { error: reason });
    }
    for (const p of this.compiled.phases) if (this.phaseState.get(p.id) === "pending") this.phaseState.set(p.id, "error");
  }

  private checkPhase(phaseId: string): void {
    const ids = this.phaseTasks.get(phaseId);
    if (!ids || this.phaseState.get(phaseId) !== "expanded") return;
    for (const id of ids) if (!TERMINAL_TASK_STATES.has(this.tasks.get(id)!.state)) return;
    this.finishPhase(phaseId);
  }

  private finishPhase(phaseId: string): void {
    const phase = this.phases.get(phaseId)!;
    const recs = [...this.records.values()].filter((r) => r.phaseId === phaseId);
    if (phase.kind === "once") this.phaseOutputs[phaseId] = recs[0]?.scope.out ?? {};
    else
      this.phaseOutputs[phaseId] = recs.map((r) => ({
        key: r.key,
        rec: r.scope.rec,
        out: r.scope.out,
        ok: [...r.tasks.values()].every((t) => t.state === "VERIFIED" || t.state === "COMPLETED" || t.state === "SKIPPED"),
      }));
    this.phaseState.set(phaseId, "done");
    this.hooks.onPhaseComplete?.(phaseId);
    this.expandReadyPhases();
  }

  isDone(): boolean {
    for (const s of this.phaseState.values()) if (s === "pending" || s === "expanded") return false;
    return true;
  }

  hasRunnable(): boolean {
    return this.ready.length > 0;
  }

  nextWakeAt(): number | null {
    let w: number | null = null;
    for (const t of this.ready) if (t.notBefore > this.hooks.now()) w = w === null ? t.notBefore : Math.min(w, t.notBefore);
    return w;
  }

  activeCount(app?: string): number {
    let n = 0;
    for (const t of this.tasks.values()) if (ACTIVE.has(t.state) && !t.inline && (!app || t.segment.app === app)) n++;
    return n;
  }

  readyCount(app?: string): number {
    return this.ready.filter((t) => !t.inline && (!app || t.segment.app === app)).length;
  }

  /** Unfinished work per segment template (for re-estimation). */
  remainingBySegment(): Map<string, number> {
    const m = new Map<string, number>();
    for (const t of this.tasks.values()) if (!TERMINAL_TASK_STATES.has(t.state)) m.set(t.segmentId, (m.get(t.segmentId) ?? 0) + 1);
    return m;
  }

  phaseStatus(): Record<string, string> {
    return Object.fromEntries(this.phaseState);
  }
}
