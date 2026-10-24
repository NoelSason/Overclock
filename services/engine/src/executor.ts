import type { ActionNode, AppBinding, EventPayload, RecordOutcome, RunConfig, SemanticLocator, TaskState, VerificationStatus } from "@overclock/contracts";
import {
  executeAction,
  ApprovalRequiredError,
  AssertionFailedError,
  BrowserWorker,
  CancelledError,
  NavigationError,
  OriginBlockedError,
  PreconditionFailedError,
  readBack,
  writeTargetUrl,
  RuntimeError,
  runSegment,
  VerificationFailedError,
  WriteRejectedError,
  WriteUncertainError,
  type BrowserManager,
  type RepairResult,
  type SegmentHooks,
  type StorageState,
} from "@overclock/browser-runtime";
import { evaluateBool, type CompiledProgram, type CompiledSegment } from "@overclock/compiler";
import type { LatencyModel } from "@overclock/optimizer";
import { AimdController, Scheduler, type SegmentGate, type TaskInstance } from "@overclock/scheduler";
import type { Tracer } from "@overclock/telemetry";

export interface RepairProvider {
  repair(args: Parameters<NonNullable<SegmentHooks["repair"]>>[0] & { taskId: string; segmentId?: string }): Promise<RepairResult | null>;
  /** Reports later reuse of a learned repair (repair propagation accounting). */
  noteReuse?(info: Parameters<NonNullable<SegmentHooks["onReuse"]>>[0]): void;
  stats?(): unknown;
}

export interface ExecutorOptions {
  runId: string;
  config: RunConfig;
  emit(e: EventPayload): void;
  now(): number;
  tracer: Tracer;
  browser: BrowserManager;
  storageState?: StorageState | undefined;
  apps: AppBinding[];
  compiled: CompiledProgram;
  latency: LatencyModel;
  signal: AbortSignal;
  recovery?: RepairProvider | undefined;
  workers: { initial: number; max: number; adaptive: boolean };
  thumbnails: boolean;
  onThumbnail(workerId: string, jpeg: Buffer): void;
  /** Called once a canary task of a gated segment verified (streaming fan-out). */
  onCanaryPassed?(segmentId: string): void;
  /** Called when a canary write failed verification (template blocked). */
  onCanaryFailed?(segmentId: string, reason: string): void;
  /** Hook for online optimizers: called after every task completes. */
  onTaskFinished?(t: TaskInstance, ms: number, ok: boolean): void;
  /** Lets an optimizer satisfy a ready task without a browser (access-path substitution). */
  substitute?(t: TaskInstance): Record<string, unknown> | null;
}

/** How long a parked irreversible step waits for a human decision before it stays NEEDS_APPROVAL. */
const APPROVAL_WAIT_MS = Number(process.env.OVERCLOCK_APPROVAL_WAIT_MS ?? 10 * 60_000);
const MAX_RETRIES = { transient: 3, throttled: 6, stale: 3, uncertain: 3, verification: 2 } as const;

function isWriteNode(n: ActionNode): boolean {
  return n.effect === "remote-write" || n.effect === "irreversible";
}

/** Errors meaning the browser page/context went away mid-task (crash, closed target). */
function isCrash(err: unknown): boolean {
  const m = (err as Error)?.message ?? "";
  return /Target (page, context or browser )?has been closed|Browser has been closed|page has been closed|Execution context was destroyed|frame was detached/i.test(m);
}

interface ActiveWorker {
  worker: BrowserWorker;
  busy: boolean;
  lastThumb: number;
  thumbs: number;
}

/**
 * Executes a compiled program on a pool of browser workers. All correctness decisions stay
 * local: leases, locks, CAS guards, read-back verification, uncertain-write reconciliation,
 * stale-data invalidation, and template-level repair. The program can grow while it runs
 * (streaming compilation) through `scheduler.addPhase/addSegments`.
 */
export class Executor {
  readonly scheduler: Scheduler;
  /** Shared per segment template: a repair learned on one record applies to all of them. */
  readonly overrides = new Map<string, Map<string, SemanticLocator>>();
  readonly aimd = new Map<string, AimdController>();
  readonly receipts = new Map<string, { status: VerificationStatus; nodeId: string }[]>();
  private readonly pool: ActiveWorker[] = [];
  private wakeResolvers: (() => void)[] = [];
  private paused = false;
  private finishedResolve!: () => void;
  readonly finished: Promise<void>;
  private approvedTasks = new Set<string>();
  private pendingApprovals = new Map<string, string>();
  private crashNext = 0;
  maxActive = 0;
  busyMs = 0;
  startedAt = 0;
  endedAt = 0;
  executionStarted = false;
  private canaryFailures = new Map<string, number>();

  constructor(private readonly o: ExecutorOptions) {
    this.finished = new Promise((r) => (this.finishedResolve = r));
    this.scheduler = new Scheduler(
      o.compiled,
      { records: o.config.records },
      {
        now: () => o.now(),
        onTasksCreated: (tasks) => {
          if (tasks.length) o.emit({ type: "tasks.created", tasks: tasks.map((t) => ({ taskId: t.taskId, segmentId: t.segmentId, phaseId: t.phaseId, recordKey: t.recordKey })) });
        },
        onTaskState: (t, state, extra) => {
          o.emit({ type: "task.state", taskId: t.taskId, state, workerId: extra.workerId, attempt: extra.attempt, error: extra.error?.slice(0, 300), ms: extra.ms });
          if (state === "READY") this.wake();
        },
        onLockConflict: (t, key, holder) => o.emit({ type: "lock.conflict", taskId: t.taskId, resource: key, holder }),
        onPhaseComplete: (p) => {
          o.emit({ type: "log", level: "info", message: `phase ${p} complete` });
          this.wake();
        },
        onPhaseError: (p, e) => o.emit({ type: "log", level: "error", message: `phase ${p}: ${e}` }),
      },
      {
        criticalPathPriority: o.config.ablation.criticalPathPriority !== false,
        leaseMs: (t) => Math.max(30_000, t.segment.estimatedMs * 8),
      },
    );
  }

  /* ----------------------------------------------------------------------------- control */

  private aimdFor(app: string): AimdController {
    let c = this.aimd.get(app);
    if (!c) {
      const max = this.o.workers.max;
      c = new AimdController(app, { min: 1, max, initial: Math.max(1, Math.min(max, this.o.workers.initial)), windowMs: 2500, errorThreshold: 0.25 }, () => this.o.now());
      this.aimd.set(app, c);
      this.o.emit({ type: "concurrency", app, limit: c.limit, reason: this.o.workers.adaptive ? "initial (adaptive)" : "fixed" });
    }
    return c;
  }

  private capFor(app: string): number {
    if (!this.o.workers.adaptive) return this.o.workers.max;
    return this.aimdFor(app).limit;
  }

  wake(): void {
    const rs = this.wakeResolvers;
    this.wakeResolvers = [];
    for (const r of rs) r();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wakeResolvers = this.wakeResolvers.filter((x) => x !== done);
        resolve();
      }, ms);
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      this.wakeResolvers.push(done);
    });
  }

  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
    this.wake();
  }

  approve(taskId: string, approved: boolean): void {
    if (approved) this.approvedTasks.add(taskId);
    this.scheduler.unpark(taskId, approved, approved ? "approved by a human" : "rejected by a human");
    this.wake();
  }

  /** Test hook: crash the next worker after its next submit (fault injection). */
  injectCrashAfterSubmit(n = 1): void {
    this.crashNext += n;
  }

  /* ------------------------------------------------------------------------------- run */

  async start(opts: { incremental: boolean }): Promise<void> {
    this.startedAt = this.o.now();
    this.scheduler.start({ incremental: opts.incremental });
    const target = this.o.workers.adaptive ? Math.min(this.o.workers.max, Math.max(this.o.workers.initial, 1)) : this.o.workers.max;
    for (let i = 0; i < target; i++) void this.spawnWorker();
    const watchdog = setInterval(() => this.watchdog(), 2000);
    try {
      await this.finished;
    } finally {
      clearInterval(watchdog);
      this.endedAt = this.o.now();
      await Promise.all(this.pool.map((w) => w.worker.close()));
    }
  }

  /** Workers being created (async); counted synchronously so pool growth can't overshoot. */
  private spawning = 0;
  private spawned = 0;

  private async spawnWorker(): Promise<void> {
    this.spawning++;
    const id = `w${++this.spawned}`;
    let ctx;
    try {
      ctx = await this.o.browser.newContext({ allowedOrigins: this.o.apps.map((a) => a.origin), storageState: this.o.storageState });
    } finally {
      this.spawning--;
    }
    const worker = new BrowserWorker(id, ctx, new Map(this.o.apps.map((a) => [a.name, a.origin])), (w, state, info) => this.o.emit({ type: "worker.state", workerId: w.id, state, taskId: info.taskId, app: info.app, op: info.op, label: info.label }));
    const aw: ActiveWorker = { worker, busy: false, lastThumb: 0, thumbs: 0 };
    this.pool.push(aw);
    worker.setState("IDLE");
    void this.loop(aw);
  }

  /** Grow the pool when adaptive caps allow more concurrency than there are workers. */
  private maybeGrow(): void {
    if (!this.o.workers.adaptive) return;
    const apps = new Set([...this.scheduler.tasks.values()].filter((t) => t.state === "READY" && !t.inline).map((t) => t.segment.app!));
    let want = 0;
    for (const a of apps) want += Math.min(this.capFor(a), this.scheduler.readyCount(a) + this.scheduler.activeCount(a));
    want = Math.min(this.o.workers.max, want);
    for (let have = this.pool.length + this.spawning; have < want; have++) void this.spawnWorker();
  }

  private async drainInline(): Promise<void> {
    for (;;) {
      const t = this.scheduler.takeInline();
      if (!t) return;
      const start = this.o.now();
      try {
        // Pure compute nodes (no browser): evaluate in order with the record scope.
        for (const n of t.segment.nodes) {
          if (n.when) {
            if (!evaluateBool(n.when, { rec: t.record.scope.rec, out: t.record.scope.out, input: t.record.scope.input, phase: t.record.scope.phase, key: t.recordKey })) {
              t.record.scope.out[n.id] = null;
              continue;
            }
          }
          const r = await executeAction({ page: undefined as never, origin: "", allowedOrigins: new Set(), scope: t.record.scope, locatorOverrides: new Map(), defaultTimeoutMs: 1000 }, n);
          if (r.output !== undefined) t.record.scope.out[n.id] = r.output;
        }
        this.scheduler.complete(t.taskId, "COMPLETED", t.segment.nodeIds, this.o.now() - start);
      } catch (err) {
        const msg = (err as Error).message;
        if (err instanceof AssertionFailedError) this.scheduler.fail(t.taskId, "FAILED", msg);
        else this.scheduler.fail(t.taskId, "FAILED", `compute failed: ${msg}`);
      }
      this.o.onTaskFinished?.(t, this.o.now() - start, this.scheduler.tasks.get(t.taskId)?.state === "COMPLETED");
    }
  }

  private checkDone(): void {
    if (this.scheduler.isDone()) this.finishedResolve();
  }

  private async loop(aw: ActiveWorker): Promise<void> {
    const w = aw.worker;
    while (!this.o.signal.aborted && !this.scheduler.isDone()) {
      await this.drainInline();
      this.checkDone();
      if (this.paused) {
        await this.sleep(300);
        continue;
      }
      // Access-path substitution: satisfy tasks from already-scanned data without a browser.
      if (this.o.substitute) this.trySubstitutions();
      const t = this.scheduler.lease(w.id, (app) => this.scheduler.activeCount(app) < this.capFor(app));
      if (!t) {
        if (w.state !== "IDLE") w.setState("IDLE");
        const wakeAt = this.scheduler.nextWakeAt();
        await this.sleep(wakeAt ? Math.max(20, Math.min(500, wakeAt - this.o.now())) : 400);
        continue;
      }
      aw.busy = true;
      const active = this.scheduler.activeCount();
      this.maxActive = Math.max(this.maxActive, active);
      const start = this.o.now();
      if (!this.executionStarted) {
        this.executionStarted = true;
        this.o.emit({ type: "stage", stage: "execution", phase: "start" });
      }
      try {
        await this.runTask(aw, t);
      } finally {
        aw.busy = false;
        this.busyMs += this.o.now() - start;
      }
      this.maybeGrow();
      this.checkDone();
    }
    if (this.scheduler.isDone()) this.finishedResolve();
    if (this.o.signal.aborted) this.finishedResolve();
  }

  private trySubstitutions(): void {
    for (const t of [...this.scheduler.tasks.values()]) {
      if (t.state !== "READY" || t.inline || t.segment.kind === "write") continue;
      const outputs = this.o.substitute!(t);
      if (!outputs) continue;
      if (!this.scheduler.claim(t.taskId, "access-path")) continue;
      const produced: string[] = [];
      for (const [nodeId, out] of Object.entries(outputs)) {
        t.record.scope.out[nodeId] = out;
        produced.push(nodeId);
      }
      this.scheduler.complete(t.taskId, "COMPLETED", produced, 0);
      this.o.onTaskFinished?.(t, 0, true);
    }
  }

  private watchdog(): void {
    for (const t of this.scheduler.expired()) {
      this.o.emit({ type: "log", level: "warn", message: `lease expired for ${t.taskId} on ${t.workerId}; reconciling` });
      const aw = this.pool.find((p) => p.worker.id === t.workerId);
      if (aw) void aw.worker.crash();
      // The task's own runTask will observe the crash and reconcile; extend so it is not double-handled.
      this.scheduler.extendLease(t.taskId, 30_000);
    }
    this.maybeGrow();
    this.checkDone();
  }

  /* ------------------------------------------------------------------------- one task */

  private async runTask(aw: ActiveWorker, t: TaskInstance): Promise<void> {
    const w = aw.worker;
    const seg = t.segment;
    const app = seg.app!;
    const span = this.o.tracer.start("worker.task", { task: t.taskId, segment: seg.id, app, kind: seg.kind, attempt: t.attempt });
    this.scheduler.mark(t.taskId, "RUNNING", { workerId: w.id });
    w.setState("PRECONDITION_CHECK", { taskId: t.taskId, app, op: "lease", label: seg.label });
    const page = await w.pageFor(app);
    this.o.browser.setReadOnly(page, seg.kind !== "write");
    let overrides = this.overrides.get(seg.id);
    if (!overrides) {
      overrides = new Map();
      this.overrides.set(seg.id, overrides);
    }
    let lastNode: ActionNode | null = null;
    const writeIdx = seg.nodes.findIndex(isWriteNode);
    const start = this.o.now();
    const hooks: SegmentHooks = {
      signal: this.o.signal,
      onOp: (op, node) => {
        lastNode = node;
        w.setState(op === "verify" ? "VERIFYING" : "EXECUTING", { taskId: t.taskId, app, op, label: seg.label });
        if (op === "verify") this.scheduler.mark(t.taskId, "VERIFYING", { workerId: w.id });
      },
      onAction: (a) => {
        this.o.emit({ type: "action", taskId: a.taskId, nodeId: a.nodeId, actionType: a.actionType, ms: Math.round(a.ms), ok: a.ok, modelCalls: a.modelCalls, locatorTier: a.locatorTier, detail: a.detail });
        if (!a.ok) return;
        if (a.actionType === "navigate") this.o.latency.observeNav(app, a.ms);
        else if (a.actionType === "click" && writeIdx >= 0 && a.nodeId === seg.nodes[writeIdx]!.id) this.o.latency.observeWrite(app, a.ms);
        else this.o.latency.observeAction(a.actionType, a.ms);
        if (this.crashNext > 0 && writeIdx >= 0 && a.nodeId === seg.nodes[writeIdx]!.id) {
          this.crashNext--;
          void w.crash();
        }
      },
      repair: this.o.recovery
        ? async (args) => {
            this.scheduler.mark(t.taskId, "REPAIRING", { workerId: w.id });
            w.setState("REPAIRING", { taskId: t.taskId, app, op: "repair", label: seg.label });
            const r = await this.o.recovery!.repair({ ...args, taskId: t.taskId, segmentId: seg.id });
            this.scheduler.mark(t.taskId, "RUNNING", { workerId: w.id });
            return r;
          }
        : undefined,
      approve: async () => this.approvedTasks.has(t.taskId),
      onReuse: this.o.recovery?.noteReuse ? (i) => this.o.recovery!.noteReuse!(i) : undefined,
    };
    try {
      const r = await runSegment(w, { taskId: t.taskId, segmentId: seg.id, app, nodes: seg.nodes, scope: t.record.scope, allowedOrigins: new Set(this.o.apps.map((a) => new URL(a.origin).origin)), locatorOverrides: overrides }, hooks);
      const ms = this.o.now() - start;
      for (const rc of r.receipts) this.receipt(t, rc.nodeId, "VERIFIED", rc.readBack.fields);
      const writeSkipped = writeIdx >= 0 && r.skipped.includes(seg.nodes[writeIdx]!.id);
      const state: "VERIFIED" | "COMPLETED" | "SKIPPED" = seg.kind === "write" ? (writeSkipped ? "SKIPPED" : r.receipts.length ? "VERIFIED" : "COMPLETED") : "COMPLETED";
      this.o.latency.observeSegment(seg.id, ms);
      this.aimdRecord(app, { ms, ok: true });
      this.scheduler.complete(t.taskId, state, Object.keys(r.outputs).concat(r.skipped), ms);
      // A write canary opens only on a verified write; a read canary on completion.
      if (this.scheduler.gateOf(seg.id) === "canary" && (seg.kind === "write" ? state === "VERIFIED" : state === "COMPLETED")) {
        if (this.scheduler.canarySucceeded(seg.id)) this.o.onCanaryPassed?.(seg.id);
      }
      span.end("ok", { ms });
      this.o.onTaskFinished?.(t, ms, true);
    } catch (err) {
      span.end("error", { error: (err as Error).message.slice(0, 200) });
      await this.handleFailure(aw, t, err, lastNode, writeIdx);
      this.o.onTaskFinished?.(t, this.o.now() - start, false);
    } finally {
      this.o.browser.setReadOnly(page, false);
      await this.thumbnail(aw);
      w.setState("COMPLETED", { taskId: t.taskId, app });
      w.setState("IDLE");
    }
  }

  private aimdRecord(app: string, outcome: { ms: number; ok: boolean; throttled?: boolean; timeout?: boolean }): void {
    if (!this.o.workers.adaptive) return;
    const d = this.aimdFor(app).record(outcome);
    if (d?.changed) {
      this.o.emit({ type: "concurrency", app, limit: d.limit, reason: d.reason });
      this.maybeGrow();
    }
  }

  private receipt(t: TaskInstance, nodeId: string, status: VerificationStatus, fields: { name: string; expected: unknown; actual: unknown }[]): void {
    const list = this.receipts.get(t.recordKey) ?? [];
    list.push({ status, nodeId });
    this.receipts.set(t.recordKey, list);
    this.o.emit({ type: "receipt", taskId: t.taskId, recordKey: t.recordKey, status, nodeId, fields: fields.map((f) => ({ name: f.name, expected: f.expected, actual: f.actual })) });
  }

  private backoff(attempt: number, base = 400): number {
    return Math.min(8000, base * 2 ** Math.max(0, attempt - 1)) * (0.75 + Math.random() * 0.5);
  }

  private async handleFailure(aw: ActiveWorker, t: TaskInstance, err: unknown, lastNode: ActionNode | null, writeIdx: number): Promise<void> {
    const seg = t.segment;
    const app = seg.app!;
    const msg = (err as Error)?.message?.split("\n")[0]?.slice(0, 300) ?? String(err);
    const writeNode = writeIdx >= 0 ? seg.nodes[writeIdx]! : null;
    const writeMayHaveHappened = writeNode !== null && lastNode !== null && seg.nodes.indexOf(lastNode) >= writeIdx;

    if (err instanceof CancelledError || this.o.signal.aborted) return this.scheduler.fail(t.taskId, "CANCELLED", "cancelled");
    if (err instanceof ApprovalRequiredError) {
      const approvalId = `ap-${t.taskId}`;
      if (!this.pendingApprovals.has(approvalId)) {
        this.pendingApprovals.set(approvalId, t.taskId);
        this.o.emit({ type: "approval.requested", approvalId, taskId: t.taskId, nodeId: err.nodeId ?? "", description: `${seg.label} for ${t.recordKey} is irreversible and needs human approval` });
        // Without a decision the step stays unexecuted and the record ends NEEDS_APPROVAL.
        setTimeout(() => {
          if (!this.scheduler.isParked(t.taskId)) return;
          this.scheduler.unpark(t.taskId, false, `no approval decision within ${Math.round(APPROVAL_WAIT_MS / 1000)} s`);
          this.wake();
        }, APPROVAL_WAIT_MS).unref();
      }
      return this.scheduler.park(t.taskId, msg);
    }
    if (err instanceof OriginBlockedError) return this.scheduler.fail(t.taskId, "FAILED", `blocked: ${msg}`);

    if ((err instanceof NavigationError && err.throttled) || (err instanceof WriteRejectedError && err.status === 429)) {
      this.aimdRecord(app, { ms: 0, ok: false, throttled: true });
      if (t.attempt < MAX_RETRIES.throttled) return this.scheduler.retry(t.taskId, this.backoff(t.attempt, 800), `throttled (429): ${msg}`);
      return this.scheduler.fail(t.taskId, "FAILED", `throttled repeatedly: ${msg}`);
    }
    if (err instanceof WriteRejectedError && err.status === 409) return this.invalidate(t, `conflict 409: the record changed since it was read`);
    if (err instanceof WriteRejectedError && err.status === 0) return this.scheduler.fail(t.taskId, "FAILED", `a read-only fragment attempted a write; blocked by the execution guard`);
    if (err instanceof WriteRejectedError) return this.scheduler.fail(t.taskId, "FAILED", `write rejected (${err.status}): ${err.body?.slice(0, 160) ?? msg}`);
    if (err instanceof PreconditionFailedError) return this.invalidate(t, msg);

    const crashed = isCrash(err);
    if (err instanceof WriteUncertainError || (crashed && writeMayHaveHappened) || (writeMayHaveHappened && !(err instanceof VerificationFailedError) && !(err instanceof AssertionFailedError))) {
      return this.reconcile(aw, t, writeNode!, msg);
    }
    if (err instanceof VerificationFailedError) {
      this.aimdRecord(app, { ms: 0, ok: false });
      const gate = this.scheduler.gateOf(seg.id);
      if (gate === "canary") {
        const n = (this.canaryFailures.get(seg.id) ?? 0) + 1;
        this.canaryFailures.set(seg.id, n);
        if (n >= 2) {
          this.scheduler.setGate(seg.id, "deferred" as SegmentGate);
          this.o.onCanaryFailed?.(seg.id, msg);
          this.receipt(t, err.nodeId ?? "", "FAILED", err.readBack.fields);
          return this.scheduler.fail(t.taskId, "FAILED", `canary verification failed twice; template blocked: ${msg}`);
        }
      }
      if (err.readBack.duplicate || err.readBack.entityMismatch) {
        this.receipt(t, err.nodeId ?? "", "FAILED", err.readBack.fields);
        return this.scheduler.fail(t.taskId, "FAILED", `${err.readBack.duplicate ? "duplicate entries" : "wrong entity"}; retrying the write cannot fix this: ${msg}`);
      }
      if (t.attempt < MAX_RETRIES.verification) return this.scheduler.retry(t.taskId, this.backoff(t.attempt), `verification mismatch, retrying: ${msg}`);
      this.receipt(t, err.nodeId ?? "", "FAILED", err.readBack.fields);
      return this.scheduler.fail(t.taskId, "FAILED", msg);
    }
    if (err instanceof AssertionFailedError) return this.scheduler.fail(t.taskId, "FAILED", msg);
    if (crashed) {
      await aw.worker.crash();
      return this.scheduler.retry(t.taskId, 200, `worker page crashed before any write: ${msg}`);
    }
    if (err instanceof NavigationError || /Timeout|timed out|net::ERR/i.test(msg)) {
      this.aimdRecord(app, { ms: 0, ok: false, timeout: /Timeout|timed out/i.test(msg) });
      if (t.attempt < MAX_RETRIES.transient) return this.scheduler.retry(t.taskId, this.backoff(t.attempt), `transient: ${msg}`);
    }
    if (err instanceof RuntimeError && /not found|Ambiguous|hidden|dialog/i.test(msg)) {
      // Recovery already ran inside runSegment and could not repair: escalate to a human.
      return this.scheduler.fail(t.taskId, "NEEDS_APPROVAL", `escalated after recovery: ${msg}`);
    }
    return this.scheduler.fail(t.taskId, "FAILED", msg);
  }

  private invalidate(t: TaskInstance, reason: string): void {
    if (t.attempt >= MAX_RETRIES.stale) return this.scheduler.fail(t.taskId, "FAILED", `stale repeatedly: ${reason}`);
    const committed = this.scheduler.committedDependents(t.taskId);
    if (committed.length) return this.scheduler.fail(t.taskId, "FAILED", `stale after ${committed.join(", ")} already committed for this record; not recomputing the reads it used: ${reason}`);
    const reset = this.scheduler.invalidate(t.taskId, reason);
    this.o.emit({ type: "invalidation", taskId: t.taskId, recordKey: t.recordKey, reason: reason.slice(0, 300), invalidated: reset });
  }

  /**
   * A write may or may not have committed. Never retry blindly: load the verification page in a
   * fresh worker page and compare. Matching state = VERIFIED (no second write). Otherwise the write
   * did not land and a retry is safe (verify-before-retry), within bounds.
   */
  private async reconcile(aw: ActiveWorker, t: TaskInstance, writeNode: ActionNode, reason: string): Promise<void> {
    this.scheduler.mark(t.taskId, "RECONCILING", { workerId: aw.worker.id });
    aw.worker.setState("RECONCILING", { taskId: t.taskId, app: t.segment.app, op: "reconcile", label: t.segment.label });
    if (!writeNode.verify) return this.scheduler.fail(t.taskId, "UNCONFIRMED", `write outcome unknown and no verification spec: ${reason}`);
    try {
      const page = await aw.worker.pageFor(t.segment.app!);
      const rb = await readBack(
        { page, origin: aw.worker.originOf(t.segment.app!), allowedOrigins: new Set(this.o.apps.map((a) => new URL(a.origin).origin)), scope: t.record.scope, locatorOverrides: this.overrides.get(t.segment.id) ?? new Map(), defaultTimeoutMs: 10_000 },
        writeNode.verify,
        { timeoutMs: 15_000, entityUrl: writeTargetUrl(t.segment.nodes, writeNode.id, t.record.scope, aw.worker.originOf(t.segment.app!)) },
      );
      if (rb.ok) {
        this.receipt(t, writeNode.id, "VERIFIED", rb.fields);
        this.o.emit({ type: "log", level: "info", message: `${t.taskId}: write had committed despite "${reason.slice(0, 80)}"; reconciled without a second write` });
        this.scheduler.complete(t.taskId, "VERIFIED", t.segment.nodeIds);
        return;
      }
      // More than one matching entry, or the wrong entity: the state is wrong, and another write can only make it worse.
      if (rb.duplicate || rb.entityMismatch) {
        this.receipt(t, writeNode.id, "FAILED", rb.fields);
        return this.scheduler.fail(t.taskId, "FAILED", rb.duplicate ? `duplicate entries after an uncertain write; not retrying: ${reason}` : `verification reads a different entity (${rb.entityMismatch}); not retrying`);
      }
      if (writeNode.retryPolicy === "verify-before-retry" && t.attempt < MAX_RETRIES.uncertain) return this.scheduler.retry(t.taskId, this.backoff(t.attempt), `write did not land (read-back mismatch); safe to retry: ${reason}`);
      this.receipt(t, writeNode.id, "UNCONFIRMED", rb.fields);
      return this.scheduler.fail(t.taskId, "UNCONFIRMED", `write could not be confirmed: ${reason}`);
    } catch (e) {
      if (isCrash(e)) await aw.worker.crash();
      if (t.attempt < MAX_RETRIES.uncertain) {
        // Reconciliation itself failed; leave the task uncertain-but-retryable only via another read-back.
        return this.scheduler.retry(t.taskId, this.backoff(t.attempt), `reconciliation read-back failed (${(e as Error).message.slice(0, 80)}); will reconcile again`);
      }
      return this.scheduler.fail(t.taskId, "UNCONFIRMED", `write outcome unknown: ${reason}`);
    }
  }

  private async thumbnail(aw: ActiveWorker): Promise<void> {
    if (!this.o.thumbnails) return;
    const now = this.o.now();
    if (now - aw.lastThumb < 1500) return;
    aw.lastThumb = now;
    const jpeg = await aw.worker.thumbnail();
    if (!jpeg) return;
    aw.thumbs++;
    this.o.onThumbnail(aw.worker.id, jpeg);
    this.o.emit({ type: "worker.thumb", workerId: aw.worker.id, url: `/api/runs/${this.o.runId}/workers/${aw.worker.id}/thumb.jpg?v=${aw.thumbs}` });
  }

  /* --------------------------------------------------------------------------- results */

  workerCount(): number {
    return this.pool.length;
  }

  utilization(): number {
    const span = Math.max(1, (this.endedAt || this.o.now()) - this.startedAt);
    return this.pool.length ? Math.min(1, this.busyMs / (span * this.pool.length)) : 0;
  }

  /**
   * Per-record outcome: VERIFIED only if every write segment of that record verified (or was
   * correctly skipped). Records that no phase over `$input.*` produced (for example a cross-record
   * hold over customers) are marked `derived`, so input-record counts never exceed the input.
   */
  outcomes(): RecordOutcome[] {
    const inputPhases = new Set(this.o.compiled.phases.filter((p) => p.kind === "foreach" && /^\s*\$input\./.test(p.over ?? "")).map((p) => p.id));
    const byRecord = new Map<string, TaskInstance[]>();
    for (const t of this.scheduler.tasks.values()) {
      if (t.phaseId && t.recordKey === "_") continue;
      (byRecord.get(t.recordKey) ?? byRecord.set(t.recordKey, []).get(t.recordKey)!).push(t);
    }
    const rank: Record<string, number> = { UNCONFIRMED: 5, FAILED: 4, NEEDS_APPROVAL: 3, CANCELLED: 3, PENDING: 3, READY: 3, SKIPPED: 0, COMPLETED: 0, VERIFIED: 0 };
    const out: RecordOutcome[] = [];
    for (const [key, tasks] of byRecord) {
      let worst: TaskState = "VERIFIED";
      for (const t of tasks) if ((rank[t.state] ?? 3) > (rank[worst] ?? 0)) worst = t.state;
      const status: VerificationStatus = worst === "UNCONFIRMED" ? "UNCONFIRMED" : worst === "FAILED" || worst === "CANCELLED" ? "FAILED" : worst === "NEEDS_APPROVAL" || worst === "PENDING" || worst === "READY" ? (worst === "NEEDS_APPROVAL" ? "NEEDS_APPROVAL" : "FAILED") : "VERIFIED";
      const writes = tasks.filter((t) => t.segment.kind === "write" && t.state === "VERIFIED").length;
      const receipts = (this.receipts.get(key) ?? []).map((r) => `${r.nodeId}:${r.status}`);
      out.push({ recordKey: key, scope: tasks.some((t) => inputPhases.has(t.phaseId)) ? "input" : "derived", status: writes === 0 && status === "VERIFIED" && tasks.some((t) => t.segment.kind === "write") ? "SKIPPED" : status, writes, receipts, notes: tasks.filter((t) => t.error && t.state !== "VERIFIED" && t.state !== "COMPLETED").map((t) => `${t.segmentId}: ${t.error}`).slice(0, 5) });
    }
    return out;
  }

  segment(id: string): CompiledSegment | undefined {
    return this.o.compiled.segments.get(id);
  }
}
