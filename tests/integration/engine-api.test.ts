import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, get as httpGet, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyEvent, createRunView, RunConfigSchema } from "@overclock/contracts";
import type { EngineHealth, EventPayload, RunConfig, RunEvent, RunListItem, RunResultResponse, RunSummary, RunView, TaskState } from "@overclock/contracts";
import { EventBus } from "@overclock/telemetry";
import { HistoricalRunHandle, loadHistoricalRuns, ManagerWithHistory, RESTART_REASON } from "../../services/engine/src/historical";
import { migrate, MIGRATIONS } from "../../services/engine/src/migrations";
import { createEngineServer, type EngineServer } from "../../services/engine/src/server";
import { streamRun } from "../../services/engine/src/sse";
import { EngineStore } from "../../services/engine/src/store";
import type { RunHandle, RunManager } from "../../services/engine/src/types";

// ----------------------------------------------------------------------------- helpers

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Deterministic RNG so a failing interleaving can be reproduced from the logged seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

function testConfig(overrides: Record<string, unknown> = {}): RunConfig {
  return RunConfigSchema.parse({
    goal: "Close every stale ticket and add a reconciliation note",
    applications: [{ name: "crm", origin: "http://127.0.0.1:4100" }],
    records: [{ id: "r1", status: "closed", password: "hunter2" }],
    ...overrides,
  });
}

/** Task-state path from creation to `final` (PENDING = never touched). */
const PATH: Record<string, TaskState[]> = {
  PENDING: [],
  LEASED: ["READY", "LEASED"],
  RUNNING: ["READY", "LEASED", "RUNNING"],
  VERIFYING: ["READY", "LEASED", "RUNNING", "VERIFYING"],
  RECONCILING: ["READY", "LEASED", "RUNNING", "VERIFYING", "RECONCILING"],
  VERIFIED: ["READY", "LEASED", "RUNNING", "VERIFYING", "VERIFIED"],
  COMPLETED: ["READY", "LEASED", "RUNNING", "COMPLETED"],
  FAILED: ["READY", "LEASED", "RUNNING", "FAILED"],
};

interface RecordPlan {
  recordKey: string;
  read: TaskState;
  write: TaskState;
}

function taskEvents(taskId: string, recordKey: string, workerId: string, final: TaskState, isWrite: boolean): EventPayload[] {
  const out: EventPayload[] = [];
  for (const state of PATH[final] ?? []) {
    if (state === "LEASED") out.push({ type: "worker.state", workerId, state: "LEASED", taskId, app: "crm" });
    if (state === "RUNNING") {
      out.push({ type: "task.state", taskId, state, workerId, attempt: 1 });
      out.push({ type: "worker.state", workerId, state: "EXECUTING", taskId, app: "crm", op: isWrite ? "click" : "extract", label: `${isWrite ? "write" : "read"} ${recordKey}` });
      out.push({ type: "action", taskId, nodeId: isWrite ? "save" : "extract", actionType: isWrite ? "click" : "extract", ms: 12, ok: true, modelCalls: 0, locatorTier: 0 });
      continue;
    }
    if (state === "VERIFIED") out.push({ type: "receipt", taskId, recordKey, status: "VERIFIED", nodeId: "save", fields: [{ name: "status", expected: "closed", actual: "closed" }] });
    if (state === "FAILED" && isWrite) out.push({ type: "receipt", taskId, recordKey, status: "FAILED", nodeId: "save", fields: [{ name: "status", expected: "closed", actual: "open" }] });
    out.push({ type: "task.state", taskId, state, workerId: state === "READY" ? undefined : workerId, error: state === "FAILED" ? "read-back mismatch on status" : undefined, ms: state === "VERIFIED" || state === "COMPLETED" ? 30 : undefined });
    if (state === "VERIFIED" || state === "COMPLETED" || state === "FAILED") {
      out.push({ type: "worker.state", workerId, state: state === "FAILED" ? "FAILED" : "COMPLETED", taskId, app: "crm" });
      out.push({ type: "worker.state", workerId, state: "IDLE" });
    }
  }
  return out;
}

function summaryFor(runId: string, plans: RecordPlan[]): RunSummary {
  const writes = plans.map((p) => p.write);
  return {
    runId,
    mode: "overclock",
    status: "completed",
    wallMs: 1200,
    discoveryMs: 200,
    compileMs: 50,
    executionMs: 900,
    records: plans.length,
    tasks: plans.length * 2,
    verified: writes.filter((s) => s === "VERIFIED").length,
    failed: writes.filter((s) => s === "FAILED").length,
    unconfirmed: 0,
    skipped: 0,
    needsApproval: 0,
    recordsVerified: writes.filter((s) => s === "VERIFIED").length,
    recoveries: 1,
    modelCalls: 1,
    inputTokens: 1200,
    outputTokens: 300,
    modelCostUsd: 0.01,
    workerUtilization: 0.8,
    maxConcurrency: 4,
    strategy: "direct-edit",
    firstActionMs: 220,
    firstVerifiedMs: 260,
    overlapMs: 40,
    recoveryMs: 15,
    stageMs: { discovery: 200, compilation: 50, execution: 900 },
  };
}

/** A schema-valid synthetic run covering every projection. Omits run.completed when !complete. */
function runScript(runId: string, config: RunConfig, plans: RecordPlan[], complete: boolean): EventPayload[] {
  const tasks = plans.flatMap((p) => [
    { taskId: `${p.recordKey}:read`, segmentId: "s-read", phaseId: "ph1", recordKey: p.recordKey },
    { taskId: `${p.recordKey}:write`, segmentId: "s-write", phaseId: "ph1", recordKey: p.recordKey },
  ]);
  const out: EventPayload[] = [
    { type: "run.created", config },
    { type: "run.status", status: "discovering" },
    { type: "stage", stage: "discovery", phase: "start" },
    { type: "agent.started", agentId: "scout-1", role: "ui-scout", label: "UI scout", model: "claude-haiku-5-5", app: "crm" },
    { type: "scout.page", agentId: "scout-1", app: "crm", url: "http://127.0.0.1:4100/tickets", routePattern: "/tickets", loadMs: 35, controls: 14 },
    { type: "model.call", provider: "anthropic", model: "claude-haiku-5-5", purpose: "scout", ms: 140, inputTokens: 1200, outputTokens: 300, costUsd: 0.01, ok: true },
    { type: "agent.artifact", agentId: "scout-1", artifact: { artifactId: "a-app-model", kind: "app-model", title: "CRM app model", summary: "1 route, 14 controls", stats: { routes: 1 } } },
    { type: "agent.finished", agentId: "scout-1", ok: true, ms: 180 },
    { type: "stage", stage: "discovery", phase: "end", detail: "1 page" },
    { type: "policy.decision", intelligence: "single-planner", candidates: 2, reason: "small app", features: { routes: 1, records: plans.length } },
    { type: "candidate.proposed", candidateId: "c1", name: "direct edit", summary: "edit each ticket", agentId: "planner" },
    { type: "candidate.proposed", candidateId: "c2", name: "bulk action", summary: "select all, bulk close", agentId: "planner" },
    {
      type: "candidate.evaluated",
      candidateId: "c1",
      estimate: { modelMs: 0, browserCriticalPathMs: 800, recoveryMs: 0, coordinationMs: 10, verificationMs: 90, totalMs: 900, workers: 4, modelCostUsd: 0, basis: [{ input: "pageLoadMs", source: "measured", value: 35 }] },
      valid: true,
      issues: [],
    },
    { type: "candidate.evaluated", candidateId: "c2", estimate: null, valid: false, issues: ["no bulk action control found"] },
    { type: "candidate.selected", candidateId: "c1", reason: "only valid candidate", ranking: [{ candidateId: "c1", totalMs: 900 }, { candidateId: "c2", totalMs: null }] },
    { type: "run.status", status: "compiling" },
    { type: "stage", stage: "compilation", phase: "start" },
    {
      type: "program.compiled",
      programId: "p1",
      strategy: "direct-edit",
      phases: [{ id: "ph1", kind: "foreach", dependsOn: [], segmentIds: ["s-read", "s-write"] }],
      segments: [
        { id: "s-read", phaseId: "ph1", app: "crm", nodeIds: ["open", "extract"], dependsOn: [], effect: "read", kind: "read", reads: ["ticket"], writes: [], label: "read ticket", estimatedMs: 40 },
        { id: "s-write", phaseId: "ph1", app: "crm", nodeIds: ["edit", "save"], dependsOn: ["s-read"], effect: "remote-write", kind: "write", reads: [], writes: ["ticket"], label: "close ticket", estimatedMs: 120 },
      ],
      passes: [{ name: "dead-code", ms: 1, changes: 0, detail: "" }],
      nodeCount: 4,
      compileMs: 3,
    },
    { type: "fragment", fragmentId: "f1", phaseId: "ph1", segmentIds: ["s-read", "s-write"], state: "compiled", label: "close ticket", effect: "remote-write" },
    { type: "fragment", fragmentId: "f1", phaseId: "ph1", segmentIds: ["s-read", "s-write"], state: "validated", label: "close ticket" },
    { type: "fragment", fragmentId: "f1", phaseId: "ph1", segmentIds: ["s-read", "s-write"], state: "canary", label: "close ticket", reason: "first record" },
    { type: "fragment", fragmentId: "f1", phaseId: "ph1", segmentIds: ["s-read", "s-write"], state: "released", label: "close ticket" },
    { type: "stage", stage: "compilation", phase: "end" },
    { type: "run.status", status: "running" },
    { type: "stage", stage: "execution", phase: "start" },
    { type: "concurrency", app: "crm", limit: 4, reason: "initial" },
    { type: "tasks.created", tasks },
    // Duplicate on purpose: task ids are stable, so this must not create rows.
    { type: "tasks.created", tasks },
    { type: "lock.conflict", taskId: tasks[0]!.taskId, resource: "ticket:r1", holder: "w0" },
    { type: "recovery", taskId: tasks[0]!.taskId, level: 1, phase: "started", reason: "stale element" },
    { type: "recovery", taskId: tasks[0]!.taskId, level: 1, phase: "succeeded", reason: "stale element", ms: 15, propagatedTo: 0 },
    { type: "approval.requested", approvalId: "ap1", taskId: tasks[0]!.taskId, nodeId: "save", description: "Close ticket r1" },
    { type: "approval.resolved", approvalId: "ap1", approved: true },
    { type: "worker.thumb", workerId: "w0", url: `/api/runs/${runId}/workers/w0/thumb.jpg` },
  ];
  plans.forEach((p, i) => {
    const w = `w${i % 4}`;
    out.push(...taskEvents(`${p.recordKey}:read`, p.recordKey, w, p.read, false));
    out.push(...taskEvents(`${p.recordKey}:write`, p.recordKey, w, p.write, true));
    if (i % 5 === 0) out.push({ type: "log", level: "info", message: `record ${p.recordKey} processed` });
  });
  out.push({ type: "invalidation", taskId: tasks[0]!.taskId, recordKey: plans[0]!.recordKey, reason: "list changed", invalidated: [] });
  out.push({ type: "reopt.decision", switched: false, reason: "on plan", remainingMs: 100, alternativeMs: null });
  if (complete) {
    out.push({ type: "stage", stage: "execution", phase: "end" });
    out.push({ type: "run.status", status: "completed" });
    out.push({ type: "run.completed", summary: summaryFor(runId, plans) });
  }
  return out;
}

const completedPlans = (n: number): RecordPlan[] => Array.from({ length: n }, (_, i) => ({ recordKey: `r${i + 1}`, read: "COMPLETED", write: "VERIFIED" }));

// ------------------------------------------------------------------- fake orchestrator

class FakeHandle implements RunHandle {
  readonly bus: EventBus;
  readonly liveView: RunView;
  readonly thumbs = new Map<string, Buffer>();
  /** External subscribers currently attached (the SSE layer). */
  listenerCount = 0;
  private done = false;

  constructor(
    readonly runId: string,
    readonly config: RunConfig,
    readonly createdAt: number,
    private readonly store: EngineStore,
  ) {
    this.bus = new EventBus(runId, (e) => store.appendEvent(e), false);
    this.liveView = createRunView(runId);
    this.bus.subscribe((e) => {
      applyEvent(this.liveView, e);
      if (e.type === "run.completed") this.done = true;
    });
  }

  emit(p: EventPayload): RunEvent {
    return this.bus.emit(p);
  }

  /** Emit payloads with random gaps; about half are emitted back-to-back in bursts. */
  async play(payloads: EventPayload[], rng: () => number, maxDelayMs: number): Promise<void> {
    for (const p of payloads) {
      if (this.done) return;
      this.emit(p);
      if (maxDelayMs > 0 && rng() < 0.5) await sleep(rng() * maxDelayMs);
    }
  }

  status() {
    return this.liveView.status;
  }
  view() {
    return this.liveView;
  }
  events(after: number, limit = 1000) {
    return this.store.events(this.runId, after, limit);
  }
  subscribe(listener: (e: RunEvent) => void) {
    const off = this.bus.subscribe(listener);
    this.listenerCount++;
    let on = true;
    return () => {
      if (!on) return;
      on = false;
      this.listenerCount--;
      off();
    };
  }
  finished() {
    return this.done;
  }
  result(): RunResultResponse {
    return { runId: this.runId, status: this.status(), summary: this.liveView.summary ?? null, outcomes: [], verificationSemantics: "test" };
  }
  metrics() {
    return { verified: this.liveView.receipts.VERIFIED };
  }
  trace() {
    return { resourceSpans: [] };
  }
  artifact(id: string) {
    return this.store.getArtifact(this.runId, id);
  }
  thumbnail(workerId: string) {
    return this.thumbs.get(workerId);
  }
  program() {
    return this.store.getProgram(this.runId);
  }
  cancel(reason?: string) {
    this.emit({ type: "run.status", status: "cancelled", reason });
  }
  pause() {
    this.emit({ type: "run.status", status: "paused" });
  }
  resume() {
    this.emit({ type: "run.status", status: "running" });
  }
  approve(approvalId: string, approved: boolean) {
    if (!this.liveView.approvals[approvalId]) return false;
    this.emit({ type: "approval.resolved", approvalId, approved });
    return true;
  }
}

type Behavior = { kind: "manual" } | { kind: "play"; records: number; maxDelayMs: number; seed: number };

class FakeManager implements RunManager {
  readonly handles = new Map<string, FakeHandle>();
  readonly playing: Promise<void>[] = [];
  behavior: Behavior = { kind: "manual" };
  private n = 0;

  constructor(private readonly store: EngineStore) {}

  async create(config: RunConfig): Promise<RunHandle> {
    const runId = `run-${Date.now().toString(36)}-${++this.n}`;
    const createdAt = Date.now();
    this.store.createRun(runId, config, createdAt);
    const h = new FakeHandle(runId, config, createdAt, this.store);
    this.handles.set(runId, h);
    const script = runScript(runId, config, completedPlans(this.behavior.kind === "play" ? this.behavior.records : 3), true);
    h.emit(script[0]!);
    const b = this.behavior;
    if (b.kind === "play") this.playing.push(h.play(script.slice(1), mulberry32(b.seed), b.maxDelayMs));
    return h;
  }
  get(runId: string) {
    return this.handles.get(runId);
  }
  list(): RunListItem[] {
    return [...this.handles.values()].map((h) => ({ runId: h.runId, status: h.status(), mode: h.config.mode, goal: h.config.goal, createdAt: h.createdAt, label: h.config.label, summary: h.liveView.summary }));
  }
  async health(): Promise<EngineHealth> {
    return {
      ok: true,
      version: "test",
      capabilities: {
        anthropic: { available: false, plannerModel: "none", helperModel: "none", reason: "test" },
        typesafe: { available: false, model: "none", visionModel: "none", reason: "test" },
        browser: { available: false, reason: "test" },
      },
    };
  }
}

/** Build a run directly against a store (no server), returning the live reducer view. */
function writeRun(store: EngineStore, runId: string, plans: RecordPlan[], complete: boolean): { view: RunView; handle: FakeHandle } {
  const config = testConfig();
  store.createRun(runId, config, Date.now());
  const h = new FakeHandle(runId, config, Date.now(), store);
  for (const p of runScript(runId, config, plans, complete)) h.emit(p);
  return { view: h.liveView, handle: h };
}

// ------------------------------------------------------------------------ SSE client

interface SseRead {
  status: number;
  headers: Headers;
  events: RunEvent[];
  ids: number[];
  pings: number;
  ended: boolean;
}

function parseFrame(frame: string): { comment: boolean; id?: string; event: string; data: string } {
  const out = { comment: false, id: undefined as string | undefined, event: "message", data: "" };
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) out.comment = true;
    else if (line.startsWith("id: ")) out.id = line.slice(4);
    else if (line.startsWith("event: ")) out.event = line.slice(7);
    else if (line.startsWith("data: ")) out.data += line.slice(6);
  }
  return out;
}

async function readSse(url: string, opts: { headers?: Record<string, string>; stopAfterEvents?: number } = {}): Promise<SseRead> {
  const ac = new AbortController();
  const res = await fetch(url, { headers: opts.headers, signal: ac.signal });
  const out: SseRead = { status: res.status, headers: res.headers, events: [], ids: [], pings: 0, ended: false };
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel();
    return out;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const f = parseFrame(buf.slice(0, i));
        buf = buf.slice(i + 2);
        if (f.comment) out.pings++;
        else if (f.event === "end") out.ended = true;
        else if (f.event === "run-event") {
          out.events.push(JSON.parse(f.data) as RunEvent);
          out.ids.push(Number(f.id));
          if (opts.stopAfterEvents && out.events.length >= opts.stopAfterEvents) {
            ac.abort();
            return out;
          }
        }
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) throw err;
  }
  return out;
}

const seqs = (events: RunEvent[]) => events.map((e) => e.seq);
const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

// ============================================================================== tests

const tmpRoot = mkdtempSync(join(tmpdir(), "overclock-engine-api-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe("EngineStore", () => {
  it("applies migrations idempotently and upgrades an older schema in place", () => {
    const file = join(tmpRoot, "migrate.db");
    const db = new DatabaseSync(file);
    expect(migrate(db, MIGRATIONS.slice(0, 1))).toBe(1);
    db.close();
    const a = new EngineStore(file);
    expect(a.schemaVersion).toBe(MIGRATIONS.length);
    a.close();
    const b = new EngineStore(file);
    expect(b.schemaVersion).toBe(MIGRATIONS.length);
    b.close();
    const check = new DatabaseSync(file);
    const versions = check.prepare("SELECT version FROM schema_version ORDER BY version").all().map((r) => r.version);
    expect(versions).toEqual(MIGRATIONS.map((m) => m.version));
    check.close();
  });

  it("writes projections in the same transaction, ignores duplicates, and redacts configs", () => {
    const file = join(tmpRoot, "projections.db");
    const store = new EngineStore(file);
    const plans = completedPlans(5);
    const { handle } = writeRun(store, "run-proj", plans, true);

    const counts = store.projectionCounts("run-proj");
    expect(counts.events).toBe(handle.bus.lastSeq);
    expect(counts.tasks).toBe(10); // duplicate tasks.created did not add rows
    expect(store.taskTransitions("run-proj", "r1:write").filter((t) => t.state === "PENDING")).toHaveLength(1);
    expect(store.tasks("run-proj").every((t) => (t.taskId.endsWith(":write") ? t.state === "VERIFIED" : t.state === "COMPLETED"))).toBe(true);
    expect(store.receipts("run-proj")).toHaveLength(5);
    expect(counts.candidates).toBe(2);
    expect(counts.programs).toBe(1);
    expect(counts.artifacts).toBe(1);
    expect(counts.model_invocations).toBe(1);
    expect(counts.lock_conflicts).toBe(1);
    expect(counts.recovery_attempts).toBe(2);
    expect(counts.worker_leases).toBeGreaterThan(0);
    expect(counts.scout_pages).toBe(1);
    expect(store.stageIntervals("run-proj").map((s) => [s.stage, s.end !== undefined])).toEqual([
      ["discovery", true],
      ["compilation", true],
      ["execution", true],
    ]);
    const [frag] = store.fragments("run-proj");
    expect(frag?.state).toBe("released");
    expect(frag?.effect).toBe("remote-write"); // kept: later events omitted it
    expect(frag?.history.map((h) => h.state)).toEqual(["compiled", "validated", "canary", "released"]);

    // Duplicate (runId, seq) is a no-op.
    const first = store.events("run-proj", 0, 1)[0]!;
    expect(store.appendEvent(first)).toBe(false);
    expect(store.projectionCounts("run-proj").events).toBe(counts.events);

    // Credentials never reach the runs table or the stored run.created event.
    const run = store.getRun("run-proj")!;
    expect((run.config.records[0] as Record<string, unknown>).password).toBe("[REDACTED]");
    const created = store.events("run-proj", 0, 1)[0]!;
    expect(created.type === "run.created" && (created.config.records[0] as Record<string, unknown>).password).toBe("[REDACTED]");
    expect(run.status).toBe("completed");
    expect(run.summary?.recordsVerified).toBe(5);
    store.close();

    // The event log is append-only at the database level.
    const raw = new DatabaseSync(file);
    expect(() => raw.exec("DELETE FROM events")).toThrow(/append-only/);
    expect(() => raw.exec("UPDATE events SET type = 'x'")).toThrow(/append-only/);
    raw.close();
  });

  it("measures appendEvent throughput (> 5k events/s)", () => {
    const store = new EngineStore(join(tmpRoot, "throughput.db"));
    const config = testConfig();
    const bus = new EventBus("run-perf"); // in-memory: generate first, then time only the store
    for (const p of runScript("run-perf", config, completedPlans(2000), true)) bus.emit(p);
    const events = bus.events;
    const t0 = performance.now();
    for (const e of events) store.appendEvent(e);
    const ms = performance.now() - t0;
    const perSec = Math.round(events.length / (ms / 1000));

    // Full producer path: EventBus (redaction + seq) persisting through the store.
    const bus2 = new EventBus("run-perf-2", (e) => store.appendEvent(e), false);
    const script = runScript("run-perf-2", config, completedPlans(2000), true);
    const t1 = performance.now();
    for (const p of script) bus2.emit(p);
    const busPerSec = Math.round(script.length / ((performance.now() - t1) / 1000));

    console.log(`[engine-store] appendEvent: ${events.length} events in ${ms.toFixed(0)} ms = ${perSec} events/s (file-backed, WAL); via EventBus: ${busPerSec} events/s`);
    expect(store.projectionCounts("run-perf").events).toBe(events.length);
    expect(perSec).toBeGreaterThan(5000);
    store.close();
  });
});

describe("restart recovery", () => {
  const file = join(tmpRoot, "restart.db");
  const interruptedPlans: RecordPlan[] = [
    { recordKey: "r1", read: "COMPLETED", write: "VERIFIED" },
    { recordKey: "r2", read: "COMPLETED", write: "RUNNING" },
    { recordKey: "r3", read: "LEASED", write: "PENDING" },
    { recordKey: "r4", read: "COMPLETED", write: "VERIFYING" },
    { recordKey: "r5", read: "COMPLETED", write: "RECONCILING" },
    { recordKey: "r6", read: "PENDING", write: "PENDING" },
    { recordKey: "r7", read: "COMPLETED", write: "FAILED" },
  ];
  let completedLive: RunView;
  let interruptedLive: RunView;
  let store: EngineStore;

  beforeAll(() => {
    const before = new EngineStore(file);
    completedLive = structuredClone(writeRun(before, "run-done", completedPlans(12), true).view);
    interruptedLive = structuredClone(writeRun(before, "run-cut", interruptedPlans, false).view);
    before.saveArtifact("run-done", "a-app-model", "app-model", "CRM app model", { routes: ["/tickets"], session: "abc" });
    before.saveSpans("run-done", { resourceSpans: [{ scopeSpans: [] }] });
    before.saveMetrics("run-done", "bench", { correctPerMin: 42 });
    before.close();
    store = new EngineStore(file); // "engine restart"
  });
  afterAll(() => store.close());

  it("rebuilds a completed run's view identical to the live reducer state", () => {
    const handles = loadHistoricalRuns(store);
    expect(handles.map((h) => h.runId).sort()).toEqual(["run-cut", "run-done"]);
    const h = handles.find((x) => x.runId === "run-done")!;
    expect(h.view()).toEqual(completedLive);
    expect(h.status()).toBe("completed");
    expect(h.completed()).toBe(true);
    expect(h.finished()).toBe(true);
    expect(h.events(0, 100_000).map((e) => e.seq)).toEqual(range(completedLive.lastSeq));
    const result = h.result();
    expect(result.status).toBe("completed");
    expect(result.outcomes).toHaveLength(12);
    expect(result.outcomes.every((o) => o.status === "VERIFIED" && o.writes === 1)).toBe(true);
    expect(h.artifact("a-app-model")).toEqual({ routes: ["/tickets"], session: "[REDACTED]" });
    expect(h.trace()).toEqual({ resourceSpans: [{ scopeSpans: [] }] });
    const metrics = h.metrics() as Record<string, unknown>;
    expect(metrics.bench).toEqual({ correctPerMin: 42 });
    expect(metrics.firstVerifiedMs).toBe(completedLive.firstVerifiedT);
    expect(metrics).toHaveProperty("overlapMs");
    expect((h.program() as { programId: string }).programId).toBe("p1");
    expect(h.approve("ap1", true)).toBe(false);
  });

  it("reports an interrupted run as failed with in-flight tasks UNCONFIRMED", () => {
    const h = new HistoricalRunHandle(store, "run-cut");
    expect(h.completed()).toBe(false);
    expect(h.status()).toBe("failed");
    expect(h.finished()).toBe(true); // nothing more will arrive; streams may close after replay

    const view = h.view();
    expect(view.status).toBe("failed");
    const state = (id: string) => view.tasks[id]?.state;
    for (const id of ["r2:write", "r3:read", "r4:write", "r5:write"]) {
      expect(state(id)).toBe("UNCONFIRMED");
      expect(view.tasks[id]?.lastError).toBe(RESTART_REASON);
    }
    expect(state("r1:write")).toBe("VERIFIED");
    expect(state("r7:write")).toBe("FAILED");
    expect(state("r6:write")).toBe("PENDING"); // never started: not claimed either way
    expect(view.taskCounts.UNCONFIRMED).toBe(4);
    expect(view.taskCounts.RUNNING).toBeUndefined();
    expect(Object.values(view.workers).every((w) => w.state === "IDLE" || w.state === "STOPPED" || w.state === "COMPLETED" || w.state === "FAILED")).toBe(true);
    // The pure replay underneath still equals the live state at the time of the crash.
    expect(interruptedLive.tasks["r2:write"]?.state).toBe("RUNNING");

    const result = h.result();
    expect(result.status).toBe("failed");
    expect(result.summary).toBeNull();
    const byKey = Object.fromEntries(result.outcomes.map((o) => [o.recordKey, o]));
    expect(byKey.r1?.status).toBe("VERIFIED");
    for (const k of ["r2", "r3", "r4", "r5"]) {
      expect(byKey[k]?.status).toBe("UNCONFIRMED");
      expect(byKey[k]?.notes.join(" ")).toContain(RESTART_REASON);
    }
    expect(byKey.r6?.status).toBe("SKIPPED");
    expect(byKey.r7?.status).toBe("FAILED");
    expect(byKey.r7?.notes.join(" ")).toContain("mismatched: status");
  });

  it("fills RunSummary defaults for runs stored before the newer summary fields", () => {
    const s = new EngineStore(join(tmpRoot, "old-summary.db"));
    const bus = new EventBus("run-old", (e) => s.appendEvent(e), false);
    bus.emit({ type: "run.created", config: testConfig() });
    const { firstActionMs: _a, firstVerifiedMs: _b, overlapMs: _c, recoveryMs: _d, stageMs: _e, ...old } = summaryFor("run-old", completedPlans(1));
    bus.emit({ type: "run.completed", summary: old as RunSummary });
    const h = new HistoricalRunHandle(s, "run-old");
    expect(h.result().summary).toMatchObject({ firstActionMs: null, firstVerifiedMs: null, overlapMs: 0, recoveryMs: 0, stageMs: {}, wallMs: 1200 });
    expect(h.view().summary?.stageMs).toEqual({});
    expect(s.listRuns()[0]?.summary?.overlapMs).toBe(0);
    s.close();
  });

  it("serves historical runs over HTTP after a restart", async () => {
    const live = new FakeManager(store);
    const server = await createEngineServer({ manager: new ManagerWithHistory(live, store), benchmarksDir: join(tmpRoot, "no-benchmarks"), port: 0, heartbeatMs: 100 });
    try {
      const list = (await (await fetch(`${server.url}/api/runs`)).json()) as RunListItem[];
      const status = Object.fromEntries(list.map((r) => [r.runId, r.status]));
      expect(status).toMatchObject({ "run-done": "completed", "run-cut": "failed" });

      const cut = (await (await fetch(`${server.url}/api/runs/run-cut`)).json()) as { status: string; view: RunView };
      expect(cut.status).toBe("failed");
      expect(cut.view.tasks["r2:write"]?.state).toBe("UNCONFIRMED");

      for (const id of ["run-done", "run-cut"]) {
        const s = await readSse(`${server.url}/api/runs/${id}/stream`);
        expect(s.ended).toBe(true);
        expect(seqs(s.events)).toEqual(range(store.lastSeq(id)));
      }
      const cancel = (await (await fetch(`${server.url}/api/runs/run-cut/cancel`, { method: "POST" })).json()) as { ok: boolean; status: string };
      expect(cancel).toEqual({ ok: false, status: "failed" });
      const result = (await (await fetch(`${server.url}/api/runs/run-cut/result`)).json()) as RunResultResponse;
      expect(result.status).toBe("failed");
    } finally {
      await server.close();
    }
  });
});

describe("engine HTTP API", () => {
  let store: EngineStore;
  let manager: FakeManager;
  let server: EngineServer;
  let base: string;
  const benchDir = join(tmpRoot, "benchmarks");

  beforeAll(async () => {
    store = new EngineStore(join(tmpRoot, "api.db"));
    manager = new FakeManager(store);
    mkdirSync(benchDir, { recursive: true });
    const bench = (suite: string, createdAt: number, runs: number) => JSON.stringify({ version: 1, suite, createdAt, machine: { platform: "test", cpus: 1, memoryGb: 1, node: "24" }, budgetUsd: 1, spentUsd: 0, runs: Array.from({ length: runs }, () => ({})), notes: [] });
    writeFileSync(join(benchDir, "2026-10-01-modes.json"), bench("modes", 1_000, 3));
    writeFileSync(join(benchDir, "2026-10-02-ablations.json"), bench("ablations", 2_000, 5));
    writeFileSync(join(benchDir, "broken.json"), "{ not json");
    writeFileSync(join(benchDir, "notes.txt"), "ignore me");
    server = await createEngineServer({ manager, benchmarksDir: benchDir, port: 0, heartbeatMs: 100 });
    base = server.url;
  });
  afterAll(async () => {
    await server.close();
    await Promise.allSettled(manager.playing);
    store.close();
  });

  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: body === undefined ? headers : { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const getJson = async <T>(path: string): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, body: (await res.json()) as T };
  };

  async function createRun(behavior: Behavior = { kind: "manual" }): Promise<FakeHandle> {
    manager.behavior = behavior;
    const res = await post("/api/runs", { goal: "close tickets", applications: [{ name: "crm", origin: "http://127.0.0.1:4100" }], records: [{ id: "r1" }] });
    expect(res.status).toBe(201);
    const { runId } = (await res.json()) as { runId: string };
    return manager.handles.get(runId)!;
  }

  it("reports health", async () => {
    const r = await getJson<EngineHealth>("/api/health");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("creates, lists, and gets runs", async () => {
    const res = await post("/api/runs", { goal: "close tickets", applications: [{ name: "crm", origin: "http://127.0.0.1:4100" }], label: "smoke" });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { runId: string; status: string };
    expect(created.status).toBe("pending");
    const list = await getJson<RunListItem[]>("/api/runs");
    expect(list.body.find((r) => r.runId === created.runId)).toMatchObject({ goal: "close tickets", mode: "overclock", label: "smoke" });
    const one = await getJson<{ runId: string; status: string; view: RunView }>(`/api/runs/${created.runId}`);
    expect(one.status).toBe(200);
    expect(one.body.view.goal).toBe("close tickets");
    expect(one.body.view.lastSeq).toBe(1);
  });

  it("rejects invalid input with 400", async () => {
    const missingGoal = await post("/api/runs", { applications: [{ name: "crm", origin: "http://127.0.0.1:4100" }] });
    expect(missingGoal.status).toBe(400);
    const body = (await missingGoal.json()) as { error: string; issues: { path: (string | number)[] }[] };
    expect(body.error).toBe("invalid run config");
    expect(body.issues.some((i) => i.path.includes("goal"))).toBe(true);

    const badJson = await post("/api/runs", "{ nope");
    expect(badJson.status).toBe(400);
    expect(((await badJson.json()) as { error: string }).error).toBeTypeOf("string");

    const h = await createRun();
    const badApproval = await post(`/api/runs/${h.runId}/approvals`, { approvalId: 3 });
    expect(badApproval.status).toBe(400);
    expect((await getJson(`/api/runs/${h.runId}/events?after=-1`)).status).toBe(400);
    expect((await getJson(`/api/runs/${h.runId}/events?limit=abc`)).status).toBe(400);
    expect((await getJson(`/api/runs/${h.runId}/stream?after=x`)).status).toBe(400);
  });

  it("returns 404 for unknown runs and resources", async () => {
    const h = await createRun();
    for (const path of ["/api/runs/nope", "/api/runs/nope/events", "/api/runs/nope/stream", "/api/runs/nope/result", `/api/runs/${h.runId}/program`, `/api/runs/${h.runId}/artifacts/missing`, `/api/runs/${h.runId}/workers/w9/thumb.jpg`, "/api/nothing-here"]) {
      const r = await getJson<{ error: string }>(path);
      expect(r.status, path).toBe(404);
      expect(r.body.error, path).toBeTypeOf("string");
    }
    expect((await post("/api/runs/nope/cancel")).status).toBe(404);
  });

  it("pages through events", async () => {
    const h = await createRun({ kind: "play", records: 6, maxDelayMs: 0, seed: 1 });
    await Promise.all(manager.playing);
    const total = h.bus.lastSeq;
    const got: RunEvent[] = [];
    let after = 0;
    for (;;) {
      const page = await getJson<{ runId: string; events: RunEvent[]; nextSeq: number }>(`/api/runs/${h.runId}/events?after=${after}&limit=7`);
      expect(page.status).toBe(200);
      expect(page.body.events.length).toBeLessThanOrEqual(7);
      got.push(...page.body.events);
      if (page.body.events.length === 0) {
        expect(page.body.nextSeq).toBe(after);
        break;
      }
      after = page.body.nextSeq;
    }
    expect(seqs(got)).toEqual(range(total));
    const big = await getJson<{ events: RunEvent[] }>(`/api/runs/${h.runId}/events?limit=999999`);
    expect(big.body.events).toHaveLength(Math.min(total, 5000));

    // Program, result, metrics, trace for a finished run.
    expect(((await getJson<{ programId: string }>(`/api/runs/${h.runId}/program`)).body).programId).toBe("p1");
    expect((await getJson<RunResultResponse>(`/api/runs/${h.runId}/result`)).body.status).toBe("completed");
    expect((await getJson<{ verified: number }>(`/api/runs/${h.runId}/metrics`)).body.verified).toBe(6);
    expect((await getJson<{ resourceSpans: unknown[] }>(`/api/runs/${h.runId}/trace`)).body.resourceSpans).toEqual([]);
  });

  it("streams replay + live events over SSE and ends after run.completed", async () => {
    const h = await createRun({ kind: "play", records: 25, maxDelayMs: 4, seed: 7 });
    await sleep(15); // connect mid-run: part replay, part live
    const s = await readSse(`${base}/api/runs/${h.runId}/stream?after=0`);
    expect(s.status).toBe(200);
    expect(s.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(s.headers.get("cache-control")).toBe("no-cache");
    expect(s.headers.get("x-accel-buffering")).toBe("no");
    expect(s.ended).toBe(true);
    expect(seqs(s.events)).toEqual(range(h.bus.lastSeq));
    expect(s.ids).toEqual(seqs(s.events));
    expect(s.events.at(-1)?.type).toBe("run.completed");
    expect(s.pings).toBeGreaterThanOrEqual(0);
    await waitFor(() => h.listenerCount === 0);
  });

  it("resumes with Last-Event-ID without gaps or duplicates (randomized timing)", async () => {
    for (const seed of [11, 23, 42]) {
      const rng = mulberry32(seed * 7919);
      const h = await createRun({ kind: "play", records: 40, maxDelayMs: 3, seed });
      const all: RunEvent[] = [];
      let ended = false;
      let connections = 0;
      while (!ended) {
        connections++;
        expect(connections, `seed ${seed}`).toBeLessThan(500);
        const last = all.at(-1)?.seq ?? 0;
        const useHeader = rng() < 0.7;
        const url = `${base}/api/runs/${h.runId}/stream${useHeader ? "" : `?after=${last}`}`;
        const s = await readSse(url, { headers: useHeader && last > 0 ? { "last-event-id": String(last) } : {}, stopAfterEvents: 1 + Math.floor(rng() * 40) });
        all.push(...s.events);
        ended = s.ended;
        if (!ended && rng() < 0.3) await sleep(rng() * 10);
      }
      expect(seqs(all), `seed ${seed}, ${connections} connections`).toEqual(range(h.bus.lastSeq));
      expect(connections).toBeGreaterThan(1);
    }
  });

  it("cleans up subscriptions when the client disconnects", async () => {
    const h = await createRun(); // never finishes on its own
    const s = await readSse(`${base}/api/runs/${h.runId}/stream`, { stopAfterEvents: 1 });
    expect(s.events[0]?.type).toBe("run.created");
    await waitFor(() => h.listenerCount === 0);
    // A stream left open receives heartbeats.
    const ac = new AbortController();
    const res = await fetch(`${base}/api/runs/${h.runId}/stream`, { signal: ac.signal });
    const reader = res.body!.getReader();
    let text = "";
    const dec = new TextDecoder();
    while (!text.includes(": ping")) text += dec.decode((await reader.read()).value, { stream: true });
    expect(h.listenerCount).toBe(1);
    ac.abort();
    await waitFor(() => h.listenerCount === 0);
  });

  it("closes open SSE streams on server shutdown instead of hanging", async () => {
    const h = await createRun(); // never finishes
    const other = await createEngineServer({ manager, benchmarksDir: benchDir, port: 0, heartbeatMs: 100 });
    const reading = readSse(`${other.url}/api/runs/${h.runId}/stream`);
    await waitFor(() => h.listenerCount === 1);
    const t0 = Date.now();
    await other.close();
    const s = await reading;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(s.ended).toBe(false); // dropped without `end`: clients resume with Last-Event-ID
    expect(s.events[0]?.type).toBe("run.created");
    expect(h.listenerCount).toBe(0);
  });

  it("handles CORS preflight and headers for local origins only", async () => {
    const pre = await fetch(`${base}/api/runs`, { method: "OPTIONS", headers: { origin: "http://localhost:5173", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    expect(pre.headers.get("access-control-allow-headers")).toBe("content-type");

    const preStream = await fetch(`${base}/api/runs/x/stream`, { method: "OPTIONS", headers: { origin: "http://127.0.0.1:3000", "access-control-request-method": "GET" } });
    expect(preStream.status).toBe(204);
    expect(preStream.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:3000");

    const evil = await fetch(`${base}/api/runs`, { method: "OPTIONS", headers: { origin: "http://evil.example", "access-control-request-method": "POST" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    const evil2 = await fetch(`${base}/api/runs`, { headers: { origin: "http://localhost.evil.example:80" } });
    expect(evil2.headers.get("access-control-allow-origin")).toBeNull();

    const list = await fetch(`${base}/api/runs`, { headers: { origin: "http://127.0.0.1:3000" } });
    expect(list.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:3000");
    const notFound = await fetch(`${base}/api/runs/nope`, { headers: { origin: "http://localhost:5173" } });
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

    const h = await createRun({ kind: "play", records: 1, maxDelayMs: 0, seed: 3 });
    await Promise.all(manager.playing);
    const s = await readSse(`${base}/api/runs/${h.runId}/stream`, { headers: { origin: "http://localhost:5173" } });
    expect(s.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(s.ended).toBe(true);
  });

  it("serves worker thumbnails and artifacts", async () => {
    const h = await createRun();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
    h.thumbs.set("w1", jpeg);
    const res = await fetch(`${base}/api/runs/${h.runId}/workers/w1/thumb.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(jpeg)).toBe(true);

    store.saveArtifact(h.runId, "a-plan", "plan", "Plan", { steps: ["open", "edit", "save"] });
    const a = await getJson<{ steps: string[] }>(`/api/runs/${h.runId}/artifacts/a-plan`);
    expect(a.status).toBe(200);
    expect(a.body.steps).toEqual(["open", "edit", "save"]);
  });

  it("controls runs: pause, resume, approvals, cancel", async () => {
    const h = await createRun();
    h.emit({ type: "run.status", status: "running" });
    h.emit({ type: "approval.requested", approvalId: "ap9", taskId: "t1", nodeId: "save", description: "Delete record" });
    expect(await (await post(`/api/runs/${h.runId}/pause`)).json()).toEqual({ ok: true, status: "paused" });
    expect(await (await post(`/api/runs/${h.runId}/resume`)).json()).toEqual({ ok: true, status: "running" });
    expect(await (await post(`/api/runs/${h.runId}/approvals`, { approvalId: "ap9", approved: false })).json()).toEqual({ ok: true });
    expect(await (await post(`/api/runs/${h.runId}/approvals`, { approvalId: "unknown", approved: true })).json()).toEqual({ ok: false });
    expect(h.liveView.approvals.ap9?.approved).toBe(false);
    // JSON content-type with an empty body is accepted.
    const cancel = await post(`/api/runs/${h.runId}/cancel`, undefined, { "content-type": "application/json" });
    expect(await cancel.json()).toEqual({ ok: true, status: "cancelled" });
    expect(await (await post(`/api/runs/${h.runId}/cancel`, { reason: "again" })).json()).toEqual({ ok: false, status: "cancelled" });
  });

  it("lists benchmarks newest first and rejects path traversal", async () => {
    const list = await getJson<{ name: string; suite: string; createdAt: number; runs: number }[]>("/api/benchmarks");
    expect(list.body).toEqual([
      { name: "2026-10-02-ablations", suite: "ablations", createdAt: 2000, runs: 5 },
      { name: "2026-10-01-modes", suite: "modes", createdAt: 1000, runs: 3 },
    ]);
    const one = await getJson<{ suite: string }>("/api/benchmarks/2026-10-01-modes");
    expect(one.status).toBe(200);
    expect(one.body.suite).toBe("modes");
    expect((await getJson("/api/benchmarks/2026-10-01-modes.json")).status).toBe(200);
    // (fetch itself normalizes literal or %2E-encoded ".." segments, so those never reach the route.)
    for (const bad of ["..%2F..%2Fpackage", "..%2Fapi", "a..b", ".hidden", "a%00b", "a%5C..%5Cb"]) {
      expect((await getJson(`/api/benchmarks/${bad}`)).status, bad).toBe(400);
    }
    expect((await getJson("/api/benchmarks/does-not-exist")).status).toBe(404);
  });
});

describe("SSE backpressure", () => {
  it("bounds the live queue for a stalled client and still delivers every event in order", async () => {
    const bus = new EventBus("run-bp");
    let finished = false;
    let refetches = 0;
    const handle = {
      events(after: number, limit = 1000) {
        if (after > 0 && after < bus.lastSeq) refetches++;
        const i = bus.events.findIndex((e) => e.seq > after);
        return i < 0 ? [] : bus.events.slice(i, i + limit);
      },
      subscribe: (l: (e: RunEvent) => void) => bus.subscribe(l),
      finished: () => finished,
    } as unknown as RunHandle; // only the members streamRun uses
    const srv: Server = createServer((_req, res) => streamRun(res, handle, { after: 0, maxQueue: 100, batchSize: 50, heartbeatMs: 1000 }));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as AddressInfo).port;
    try {
      const res = await new Promise<IncomingMessage>((r) => httpGet(`http://127.0.0.1:${port}/`, r));
      res.pause(); // stalled client
      const pad = "x".repeat(2048);
      const total = 5000;
      for (let i = 0; i < total; i++) {
        bus.emit({ type: "log", level: "info", message: `${i} ${pad}` });
        if (i % 250 === 0) await sleep(1); // let the stream hit the full socket buffer
      }
      bus.emit({ type: "run.completed", summary: summaryFor("run-bp", []) });
      finished = true;
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      const ended = new Promise<void>((r) => res.on("end", r));
      res.resume();
      await ended;
      const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
      expect(ids).toEqual(range(total + 1));
      expect(text.endsWith("event: end\ndata: {}\n\n")).toBe(true);
      expect(refetches).toBeGreaterThan(0); // the bounded queue overflowed and was re-read from the log
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
