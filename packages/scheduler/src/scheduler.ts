import type { TaskState } from "@overclock/contracts";
import { TERMINAL_TASK_STATES } from "@overclock/contracts";
import { bottomLevels, evaluate, renderTemplate, toStr, type CompiledProgram, type CompiledSegment, type PhaseInfo } from "@overclock/compiler";
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

/**
 * Release gate per segment template:
 *  - open: every record's task may run;
 *  - canary: one record at a time until one succeeds, then the gate opens (fan-out after proof);
 *  - deferred: nothing runs yet (a safety gate such as "phase not sealed" is pending).
 */
export type SegmentGate = "open" | "canary" | "deferred";

export class Scheduler {
  readonly tasks = new Map<string, TaskInstance>();
  readonly records = new Map<string, RecordState>();
  readonly phaseOutputs: Record<string, unknown> = {};
  readonly locks = new LockManager();
  private readonly phaseState = new Map<string, "pending" | "expanded" | "done" | "error">();
  private readonly phaseTasks = new Map<string, Set<string>>();
  private ready: TaskInstance[] = [];
  private readonly suspended = new Map<string, string>();
  /** Tasks waiting for a human approval decision (state NEEDS_APPROVAL, not final). */
  private readonly parked = new Set<string>();
  private readonly phases: Map<string, PhaseInfo>;
  private readonly gates = new Map<string, SegmentGate>();
  private readonly canaryPassed = new Set<string>();
  /** Tasks per segment in an active state (leased, running, verifying, repairing, reconciling). */
  private readonly activeBySegment = new Map<string, number>();
  private readonly sealed = new Set<string>();
  private programSealed = false;
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

  /* ------------------------------------------------------------ incremental program assembly */

  /** Register a phase whose segments will arrive incrementally (streaming compilation). */
  addPhase(phase: PhaseInfo): void {
    if (this.phases.has(phase.id)) return;
    this.compiled.phases.push(phase);
    this.phases.set(phase.id, phase);
    this.phaseState.set(phase.id, "pending");
    this.expandReadyPhases();
  }

  /**
   * Add compiled segments to a phase. Existing records of an already-expanded phase get tasks for
   * them immediately; dependencies on segments that already finished are satisfied at once.
   */
  addSegments(phaseId: string, segments: CompiledSegment[], gate: SegmentGate = "open"): TaskInstance[] {
    const phase = this.phases.get(phaseId);
    if (!phase) throw new Error(`Unknown phase ${phaseId}`);
    for (const seg of segments) {
      if (this.compiled.segments.has(seg.id)) continue;
      this.compiled.segments.set(seg.id, seg);
      phase.segmentIds.push(seg.id);
      this.gates.set(seg.id, gate);
    }
    this.recomputePriorities(phase);
    if (this.phaseState.get(phaseId) !== "expanded") return [];
    const created: TaskInstance[] = [];
    for (const record of this.records.values()) {
      if (record.phaseId !== phaseId) continue;
      for (const seg of segments) {
        const t = this.createTask(seg, record);
        if (t) created.push(t);
      }
      for (const t of created) if (t.record === record) for (const d of t.deps) this.tasks.get(d)?.dependents.add(t.taskId);
    }
    this.hooks.onTasksCreated?.(created);
    for (const t of created) if ([...t.deps].every((d) => this.isDoneOk(d))) this.makeReady(t);
    return created;
  }

  setGate(segmentId: string, gate: SegmentGate): void {
    this.gates.set(segmentId, gate);
  }

  gateOf(segmentId: string): SegmentGate {
    return this.gates.get(segmentId) ?? "open";
  }

  /** No more segments will be added to this phase. */
  sealPhase(phaseId: string): void {
    this.sealed.add(phaseId);
    this.checkPhase(phaseId);
  }

  /** No more phases will be added; phases still unknown can never become ready. */
  sealProgram(): void {
    this.programSealed = true;
    for (const p of this.compiled.phases) this.sealed.add(p.id);
    for (const p of this.compiled.phases) this.checkPhase(p.id);
    this.expandReadyPhases();
  }

  isSealed(phaseId: string): boolean {
    return this.sealed.has(phaseId);
  }

  private recomputePriorities(phase: PhaseInfo): void {
    const segs = phase.segmentIds.map((id) => this.compiled.segments.get(id)!);
    const bl = bottomLevels(
      segs.map((x) => ({ id: x.id, deps: x.dependsOn.filter((d) => phase.segmentIds.includes(d)) })),
      (n) => this.compiled.segments.get(n.id)!.estimatedMs,
    );
    for (const [id, v] of bl) this.compiled.priority.set(id, v);
    for (const t of this.tasks.values()) if (t.phaseId === phase.id) t.priority = this.priorityOf(t.segment, t.record);
    this.ready.sort((a, b) => b.priority - a.priority);
  }

  private isDoneOk(taskId: string): boolean {
    const s = this.tasks.get(taskId)?.state;
    return s === "VERIFIED" || s === "COMPLETED" || s === "SKIPPED";
  }

  private createTask(seg: CompiledSegment, record: RecordState): TaskInstance | null {
    const taskId = `${seg.id}@${record.key}`;
    if (this.tasks.has(taskId)) {
      this.duplicatesDropped.push(taskId);
      return null;
    }
    const t: TaskInstance = {
      taskId,
      phaseId: record.phaseId,
      segmentId: seg.id,
      recordKey: record.key,
      segment: seg,
      record,
      deps: new Set(seg.dependsOn.map((d) => `${d}@${record.key}`)),
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
    this.phaseTasks.get(record.phaseId)?.add(taskId);
    return t;
  }

  /** Start with the program as given. `incremental` keeps phases open for streaming additions. */
  start(opts: { incremental?: boolean } = {}): void {
    if (!opts.incremental) {
      this.programSealed = true;
      for (const p of this.compiled.phases) this.sealed.add(p.id);
    }
    this.expandReadyPhases();
  }

  private expandReadyPhases(): void {
    for (const p of this.compiled.phases) {
      if (this.phaseState.get(p.id) !== "pending") continue;
      if (!p.dependsOn.every((d) => this.phaseState.get(d) === "done" || this.phaseState.get(d) === "error")) continue;
      this.expand(p);
      if (this.phaseState.get(p.id) !== "expanded") continue;
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
    const ids = this.phaseTasks.get(phase.id) ?? new Set<string>();
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
        const t = this.createTask(seg, record);
        if (t) {
          ids.add(t.taskId);
          created.push(t);
        }
      }
      for (const t of record.tasks.values()) for (const d of t.deps) this.tasks.get(d)?.dependents.add(t.taskId);
    }
    this.hooks.onTasksCreated?.(created);
    for (const t of created) if (t.deps.size === 0) this.makeReady(t);
    this.checkPhase(phase.id);
  }

  private priorityOf(seg: CompiledSegment, record: RecordState): number {
    if (!this.opts.criticalPathPriority) return -record.index;
    // Bottom level (ms) dominates; earlier records break ties so records complete progressively.
    return (this.compiled.priority.get(seg.id) ?? 0) * 1000 - record.index;
  }

  /** Every state change goes through here, so the per-segment active count stays exact. */
  private assignState(t: TaskInstance, state: TaskState): void {
    const was = ACTIVE.has(t.state);
    const now = ACTIVE.has(state);
    if (was !== now) this.activeBySegment.set(t.segmentId, (this.activeBySegment.get(t.segmentId) ?? 0) + (now ? 1 : -1));
    t.state = state;
  }

  private setState(t: TaskInstance, state: TaskState, extra: { error?: string; workerId?: string; attempt?: number; ms?: number } = {}): void {
    this.assignState(t, state);
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
      if (!this.gatePermits(t)) continue;
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

  private gatePermits(t: TaskInstance): boolean {
    const gate = this.gates.get(t.segmentId) ?? "open";
    if (gate === "open") return true;
    if (gate === "deferred") return false;
    // canary: one in flight at a time until one succeeds (O(1): a lease scan checks this per ready task)
    if (this.canaryPassed.has(t.segmentId)) return true;
    return (this.activeBySegment.get(t.segmentId) ?? 0) === 0;
  }

  /** Called by the executor when a canary task of a segment verified; opens the gate. */
  canarySucceeded(segmentId: string): boolean {
    if (this.gates.get(segmentId) !== "canary" || this.canaryPassed.has(segmentId)) return false;
    this.canaryPassed.add(segmentId);
    this.gates.set(segmentId, "open");
    return true;
  }

  /** Claim one specific READY task (e.g. to satisfy it from an alternative access path). */
  claim(taskId: string, workerId: string): TaskInstance | null {
    const i = this.ready.findIndex((t) => t.taskId === taskId);
    if (i < 0) return null;
    const t = this.ready[i]!;
    if (this.suspended.has(t.segmentId) || !this.gatePermits(t)) return null;
    this.ready.splice(i, 1);
    t.workerId = workerId;
    t.attempt++;
    t.startedAt = this.hooks.now();
    this.setState(t, "RUNNING", { workerId, attempt: t.attempt });
    return t;
  }

  /** Take a ready browser-free (compute) task. */
  takeInline(): TaskInstance | null {
    const i = this.ready.findIndex((t) => t.inline && !this.suspended.has(t.segmentId) && this.gatePermits(t));
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
    this.assignState(t, "PENDING");
    this.setState(t, "READY", { error, attempt: t.attempt });
    t.readyAt = this.hooks.now();
    this.insertReady(t);
  }

  /**
   * Park a task until a human decides (irreversible step). Its locks are released and its
   * dependents keep waiting, so its phase stays open; `unpark` resolves it.
   */
  park(taskId: string, error: string): void {
    const t = this.tasks.get(taskId);
    if (!t || TERMINAL_TASK_STATES.has(t.state)) return;
    this.release(t);
    this.ready = this.ready.filter((x) => x !== t);
    this.parked.add(taskId);
    this.setState(t, "NEEDS_APPROVAL", { error });
  }

  /** Approved: back to the ready queue. Rejected or expired: final NEEDS_APPROVAL, dependents skipped. */
  unpark(taskId: string, approved: boolean, reason: string): void {
    const t = this.tasks.get(taskId);
    if (!t || !this.parked.delete(taskId)) return;
    this.assignState(t, "PENDING");
    if (!approved) return this.fail(taskId, "NEEDS_APPROVAL", reason);
    t.notBefore = this.hooks.now();
    this.setState(t, "READY", { error: reason, attempt: t.attempt });
    t.readyAt = this.hooks.now();
    this.insertReady(t);
  }

  isParked(taskId: string): boolean {
    return this.parked.has(taskId);
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
  /** The task plus the upstream tasks `invalidate` would recompute (stops at writes and verified tasks). */
  private invalidationSet(t: TaskInstance): TaskInstance[] {
    const reset: TaskInstance[] = [];
    const visit = (id: string) => {
      const x = this.tasks.get(id)!;
      if (reset.includes(x)) return;
      if (x !== t && (x.segment.kind === "write" || x.state === "VERIFIED")) return;
      reset.push(x);
      for (const d of x.deps) visit(d);
    };
    visit(t.taskId);
    return reset;
  }

  /**
   * Verified writes of the same record that consumed data `invalidate(taskId)` would recompute.
   * Recomputing those reads would decide again from state the committed write already changed,
   * so the caller must not invalidate when this is non-empty.
   */
  committedDependents(taskId: string): string[] {
    const t = this.tasks.get(taskId);
    if (!t) return [];
    const reset = new Set(this.invalidationSet(t).filter((x) => x !== t));
    if (!reset.size) return [];
    const out: string[] = [];
    for (const y of this.tasks.values()) {
      if (y === t || y.recordKey !== t.recordKey || y.segment.kind !== "write" || y.state !== "VERIFIED") continue;
      const seen = new Set<string>();
      const stack = [...y.deps];
      while (stack.length) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const d = this.tasks.get(id);
        if (!d) continue;
        if (reset.has(d)) {
          out.push(y.taskId);
          break;
        }
        stack.push(...d.deps);
      }
    }
    return out;
  }

  invalidate(taskId: string, reason: string): string[] {
    const t = this.tasks.get(taskId);
    if (!t) return [];
    const reset = this.invalidationSet(t);
    for (const x of reset) {
      if (x !== t && ACTIVE.has(x.state)) continue;
      this.release(x);
      this.ready = this.ready.filter((r) => r !== x);
      for (const nodeId of x.produced) delete x.record.scope.out[nodeId];
      x.produced = [];
      this.assignState(x, "PENDING");
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
    for (const p of this.compiled.phases) if (this.phaseState.get(p.id) !== "done") this.phaseState.set(p.id, "error");
  }

  private checkPhase(phaseId: string): void {
    const ids = this.phaseTasks.get(phaseId);
    if (!ids || this.phaseState.get(phaseId) !== "expanded") return;
    if (!this.sealed.has(phaseId)) return;
    for (const id of ids) if (this.parked.has(id) || !TERMINAL_TASK_STATES.has(this.tasks.get(id)!.state)) return;
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
    if (!this.programSealed) return false;
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
