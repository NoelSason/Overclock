import type { AgentRole, ArtifactSummary, FragmentState, RunEvent, StageName } from "./events";
import type { CostEstimate, ExecutionMode, PassReport, PhaseTemplate, RunStatus, RunSummary, SegmentTemplate, TaskState, VerificationStatus, WorkerState } from "./run";
import { TERMINAL_TASK_STATES } from "./run";

/**
 * Shared run-state reducer. The engine and the dashboard both build their view of a run by
 * applying the same events through this function, so what the UI shows is exactly what the
 * engine recorded. The reducer mutates `view` in place for speed; callers that need
 * immutability (React) bump `view.version` and re-render.
 */

export interface AgentView {
  id: string;
  role: AgentRole;
  label: string;
  model?: string | undefined;
  app?: string | undefined;
  status: "running" | "done" | "failed";
  startedT: number;
  endedT?: number | undefined;
  ms?: number | undefined;
  error?: string | undefined;
  artifacts: ArtifactSummary[];
}

export interface CandidateView {
  id: string;
  name: string;
  summary: string;
  agentId: string;
  estimate: CostEstimate | null;
  valid: boolean | null;
  issues: string[];
  selected: boolean;
}

export interface TaskView {
  taskId: string;
  segmentId: string;
  phaseId: string;
  recordKey: string;
  state: TaskState;
  workerId?: string | undefined;
  attempts: number;
  lastError?: string | undefined;
  startedT?: number | undefined;
  endedT?: number | undefined;
}

export interface WorkerView {
  id: string;
  state: WorkerState;
  app?: string | undefined;
  taskId?: string | undefined;
  op?: string | undefined;
  label?: string | undefined;
  sinceT: number;
  busyMs: number;
  tasksDone: number;
  thumbUrl?: string | undefined;
}

export interface RecoveryView {
  taskId: string;
  level: number;
  phase: "started" | "succeeded" | "failed" | "escalated";
  reason: string;
  detail?: string | undefined;
  t: number;
  ms?: number | undefined;
  propagatedTo?: number | undefined;
}

export interface RunView {
  version: number;
  runId: string;
  lastSeq: number;
  status: RunStatus;
  mode?: ExecutionMode | undefined;
  goal?: string | undefined;
  createdTs?: number | undefined;
  lastT: number;
  phaseT: Partial<Record<RunStatus, number>>;
  policy?: { intelligence: string; candidates: number; reason: string; features: Record<string, number | string | boolean> } | undefined;
  agents: Record<string, AgentView>;
  candidates: Record<string, CandidateView>;
  selection?: { candidateId: string; reason: string; ranking: { candidateId: string; totalMs: number | null }[] } | undefined;
  program?: { programId: string; strategy: string; phases: PhaseTemplate[]; segments: SegmentTemplate[]; passes: PassReport[]; nodeCount: number; compileMs: number; patches: number } | undefined;
  tasks: Record<string, TaskView>;
  /** segmentId -> state -> count */
  segmentCounts: Record<string, Partial<Record<TaskState, number>>>;
  taskCounts: Partial<Record<TaskState, number>>;
  workers: Record<string, WorkerView>;
  receipts: Record<VerificationStatus, number>;
  recordReceipts: Record<string, Partial<Record<VerificationStatus, number>>>;
  recoveries: RecoveryView[];
  invalidations: number;
  lockConflicts: number;
  actions: { count: number; modelFree: number; totalMs: number; byType: Record<string, { count: number; ms: number }> };
  modelCalls: { count: number; inputTokens: number; outputTokens: number; costUsd: number; ms: number; failures: number; byPurpose: Record<string, { count: number; ms: number; costUsd: number }>; byProvider: Record<string, number> };
  concurrency: Record<string, { limit: number; history: { t: number; limit: number; reason: string }[] }>;
  /** t (ms since start) of each VERIFIED receipt, for throughput charts. */
  verifiedTimeline: number[];
  reopt: { t: number; switched: boolean; reason: string; remainingMs: number; alternativeMs: number | null; alternative?: string | undefined }[];
  approvals: Record<string, { approvalId: string; taskId: string; nodeId: string; description: string; resolved?: boolean | undefined; approved?: boolean | undefined }>;
  logs: { t: number; level: string; message: string }[];
  /** Review rounds of plans before their writes (see the `review` event). */
  reviews: { t: number; subject: string; round: number; status: string; highRisks: number; reason?: string | undefined; ms?: number | undefined }[];
  summary?: RunSummary | undefined;
  /** Stage intervals for the overlap (Gantt) view; open intervals have end undefined. */
  stages: { stage: StageName; start: number; end?: number | undefined; detail?: string | undefined }[];
  fragments: Record<string, { fragmentId: string; phaseId: string; segmentIds: string[]; state: FragmentState; label: string; reason?: string | undefined; effect?: string | undefined; history: { t: number; state: FragmentState; reason?: string | undefined }[] }>;
  scoutPages: { t: number; agentId: string; app: string; url: string; routePattern: string; loadMs: number; controls: number }[];
  network: {
    lookups: { t: number; outcome: string; source: string; candidates: number; ms: number; capabilityId?: string | undefined; version?: number | undefined }[];
    imports: { t: number; capabilityId: string; version: number; outcome: string; bound: number; unbound: number; rebindMs: number; fetchMs: number; source: string; avoided?: { modelCalls: number; discoveryMs: number; estimated: true } | undefined }[];
    publishes: { t: number; capabilityId: string; version: number; state: string; ms: number; redactions: number; bytes: number; rejected?: string | undefined }[];
    repairs: { t: number; capabilityId: string; jobId: string; phase: string; fencingToken?: number | undefined; ms?: number | undefined; detail?: string | undefined }[];
    updates: { t: number; capabilityId: string; version: number; state: string; propagationMs?: number | undefined }[];
  };
  /** First browser action and first VERIFIED write (ms since submission). */
  firstActionT?: number | undefined;
  firstVerifiedT?: number | undefined;
}

export function createRunView(runId: string): RunView {
  return {
    version: 0,
    runId,
    lastSeq: 0,
    status: "pending",
    lastT: 0,
    phaseT: {},
    agents: {},
    candidates: {},
    tasks: {},
    segmentCounts: {},
    taskCounts: {},
    workers: {},
    receipts: { VERIFIED: 0, FAILED: 0, UNCONFIRMED: 0, SKIPPED: 0, NEEDS_APPROVAL: 0 },
    recordReceipts: {},
    recoveries: [],
    invalidations: 0,
    lockConflicts: 0,
    actions: { count: 0, modelFree: 0, totalMs: 0, byType: {} },
    modelCalls: { count: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ms: 0, failures: 0, byPurpose: {}, byProvider: {} },
    concurrency: {},
    verifiedTimeline: [],
    reopt: [],
    approvals: {},
    logs: [],
    reviews: [],
    stages: [],
    fragments: {},
    scoutPages: [],
    network: { lookups: [], imports: [], publishes: [], repairs: [], updates: [] },
  };
}

const MAX_LOGS = 300;
const MAX_RECOVERIES = 500;

function bump(counts: Partial<Record<string, number>>, key: string, delta: number): void {
  counts[key] = (counts[key] ?? 0) + delta;
  if (counts[key] === 0) delete counts[key];
}

export function applyEvent(view: RunView, ev: RunEvent): RunView {
  if (ev.seq <= view.lastSeq) return view; // idempotent replay
  view.lastSeq = ev.seq;
  view.lastT = Math.max(view.lastT, ev.t);
  view.version++;
  switch (ev.type) {
    case "run.created":
      view.mode = ev.config.mode;
      view.goal = ev.config.goal;
      view.createdTs = ev.ts;
      break;
    case "run.status":
      view.status = ev.status;
      view.phaseT[ev.status] ??= ev.t;
      break;
    case "run.completed":
      view.summary = ev.summary;
      view.status = ev.summary.status;
      view.phaseT[ev.summary.status] ??= ev.t;
      break;
    case "policy.decision":
      view.policy = { intelligence: ev.intelligence, candidates: ev.candidates, reason: ev.reason, features: ev.features };
      break;
    case "agent.started":
      view.agents[ev.agentId] = { id: ev.agentId, role: ev.role, label: ev.label, model: ev.model, app: ev.app, status: "running", startedT: ev.t, artifacts: [] };
      break;
    case "agent.artifact": {
      const a = view.agents[ev.agentId];
      if (a) a.artifacts.push(ev.artifact);
      break;
    }
    case "agent.finished": {
      const a = view.agents[ev.agentId];
      if (a) {
        a.status = ev.ok ? "done" : "failed";
        a.endedT = ev.t;
        a.ms = ev.ms;
        a.error = ev.error;
      }
      break;
    }
    case "candidate.proposed":
      view.candidates[ev.candidateId] = { id: ev.candidateId, name: ev.name, summary: ev.summary, agentId: ev.agentId, estimate: null, valid: null, issues: [], selected: false };
      break;
    case "candidate.evaluated": {
      const c = view.candidates[ev.candidateId];
      if (c) {
        c.estimate = ev.estimate;
        c.valid = ev.valid;
        c.issues = ev.issues;
      }
      break;
    }
    case "candidate.selected": {
      view.selection = { candidateId: ev.candidateId, reason: ev.reason, ranking: ev.ranking };
      for (const c of Object.values(view.candidates)) c.selected = c.id === ev.candidateId;
      break;
    }
    case "program.compiled":
      view.program = { programId: ev.programId, strategy: ev.strategy, phases: ev.phases, segments: ev.segments, passes: ev.passes, nodeCount: ev.nodeCount, compileMs: ev.compileMs, patches: 0 };
      break;
    case "program.patched":
      if (view.program) view.program.patches++;
      break;
    case "tasks.created":
      for (const t of ev.tasks) {
        if (view.tasks[t.taskId]) continue;
        view.tasks[t.taskId] = { ...t, state: "PENDING", attempts: 0 };
        const sc = (view.segmentCounts[t.segmentId] ??= {});
        bump(sc, "PENDING", 1);
        bump(view.taskCounts, "PENDING", 1);
      }
      break;
    case "task.state": {
      const task = view.tasks[ev.taskId];
      if (!task) break;
      const sc = (view.segmentCounts[task.segmentId] ??= {});
      bump(sc, task.state, -1);
      bump(view.taskCounts, task.state, -1);
      task.state = ev.state;
      bump(sc, ev.state, 1);
      bump(view.taskCounts, ev.state, 1);
      if (ev.workerId) task.workerId = ev.workerId;
      if (ev.attempt !== undefined) task.attempts = ev.attempt;
      if (ev.error) task.lastError = ev.error;
      if (ev.state === "RUNNING" && task.startedT === undefined) task.startedT = ev.t;
      if (TERMINAL_TASK_STATES.has(ev.state)) task.endedT = ev.t;
      break;
    }
    case "worker.state": {
      const prev = view.workers[ev.workerId];
      const w: WorkerView = prev ?? { id: ev.workerId, state: ev.state, sinceT: ev.t, busyMs: 0, tasksDone: 0 };
      if (prev && prev.state !== "IDLE" && prev.state !== "STOPPED") w.busyMs += ev.t - prev.sinceT;
      if (prev && ev.state === "COMPLETED") w.tasksDone++;
      w.state = ev.state;
      w.sinceT = ev.t;
      w.taskId = ev.taskId;
      w.app = ev.app ?? (ev.state === "IDLE" ? undefined : w.app);
      w.op = ev.op;
      w.label = ev.label;
      view.workers[ev.workerId] = w;
      break;
    }
    case "worker.thumb": {
      const w = view.workers[ev.workerId];
      if (w) w.thumbUrl = ev.url;
      break;
    }
    case "action": {
      if (view.firstActionT === undefined && ev.ok) view.firstActionT = ev.t;
      view.actions.count++;
      view.actions.totalMs += ev.ms;
      if (ev.modelCalls === 0) view.actions.modelFree++;
      const bt = (view.actions.byType[ev.actionType] ??= { count: 0, ms: 0 });
      bt.count++;
      bt.ms += ev.ms;
      break;
    }
    case "receipt": {
      view.receipts[ev.status]++;
      const rr = (view.recordReceipts[ev.recordKey] ??= {});
      rr[ev.status] = (rr[ev.status] ?? 0) + 1;
      if (ev.status === "VERIFIED") {
        view.verifiedTimeline.push(ev.t);
        view.firstVerifiedT ??= ev.t;
      }
      break;
    }
    case "lock.conflict":
      view.lockConflicts++;
      break;
    case "recovery":
      view.recoveries.push({ taskId: ev.taskId, level: ev.level, phase: ev.phase, reason: ev.reason, detail: ev.detail, t: ev.t, ms: ev.ms, propagatedTo: ev.propagatedTo });
      if (view.recoveries.length > MAX_RECOVERIES) view.recoveries.shift();
      break;
    case "invalidation":
      view.invalidations++;
      break;
    case "model.call": {
      const m = view.modelCalls;
      m.count++;
      m.inputTokens += ev.inputTokens;
      m.outputTokens += ev.outputTokens;
      m.costUsd += ev.costUsd;
      m.ms += ev.ms;
      if (!ev.ok) m.failures++;
      const p = (m.byPurpose[ev.purpose] ??= { count: 0, ms: 0, costUsd: 0 });
      p.count++;
      p.ms += ev.ms;
      p.costUsd += ev.costUsd;
      m.byProvider[ev.provider] = (m.byProvider[ev.provider] ?? 0) + 1;
      break;
    }
    case "concurrency": {
      const c = (view.concurrency[ev.app] ??= { limit: ev.limit, history: [] });
      c.limit = ev.limit;
      c.history.push({ t: ev.t, limit: ev.limit, reason: ev.reason });
      break;
    }
    case "reopt.decision":
      view.reopt.push({ t: ev.t, switched: ev.switched, reason: ev.reason, remainingMs: ev.remainingMs, alternativeMs: ev.alternativeMs, alternative: ev.alternative });
      break;
    case "approval.requested":
      view.approvals[ev.approvalId] = { approvalId: ev.approvalId, taskId: ev.taskId, nodeId: ev.nodeId, description: ev.description };
      break;
    case "approval.resolved": {
      const a = view.approvals[ev.approvalId];
      if (a) {
        a.resolved = true;
        a.approved = ev.approved;
      }
      break;
    }
    case "review":
      view.reviews.push({ t: ev.t, subject: ev.subject, round: ev.round, status: ev.status, highRisks: ev.highRisks, reason: ev.reason, ms: ev.ms });
      break;
    case "log":
      view.logs.push({ t: ev.t, level: ev.level, message: ev.message });
      if (view.logs.length > MAX_LOGS) view.logs.shift();
      break;
    case "stage":
      if (ev.phase === "start") view.stages.push({ stage: ev.stage, start: ev.t, detail: ev.detail });
      else {
        const open = [...view.stages].reverse().find((s) => s.stage === ev.stage && s.end === undefined);
        if (open) open.end = ev.t;
      }
      break;
    case "scout.page":
      view.scoutPages.push({ t: ev.t, agentId: ev.agentId, app: ev.app, url: ev.url, routePattern: ev.routePattern, loadMs: ev.loadMs, controls: ev.controls });
      if (view.scoutPages.length > 500) view.scoutPages.shift();
      break;
    case "network.lookup":
      view.network.lookups.push({ t: ev.t, outcome: ev.outcome, source: ev.source, candidates: ev.candidates, ms: ev.ms, capabilityId: ev.capabilityId, version: ev.version });
      break;
    case "network.import":
      view.network.imports.push({ t: ev.t, capabilityId: ev.capabilityId, version: ev.version, outcome: ev.outcome, bound: ev.bound, unbound: ev.unbound, rebindMs: ev.rebindMs, fetchMs: ev.fetchMs, source: ev.source, avoided: ev.avoided });
      break;
    case "network.publish":
      view.network.publishes.push({ t: ev.t, capabilityId: ev.capabilityId, version: ev.version, state: ev.state, ms: ev.ms, redactions: ev.redactions, bytes: ev.bytes, rejected: ev.rejected });
      break;
    case "network.repair":
      view.network.repairs.push({ t: ev.t, capabilityId: ev.capabilityId, jobId: ev.jobId, phase: ev.phase, fencingToken: ev.fencingToken, ms: ev.ms, detail: ev.detail });
      break;
    case "network.update":
      view.network.updates.push({ t: ev.t, capabilityId: ev.capabilityId, version: ev.version, state: ev.state, propagationMs: ev.propagationMs });
      break;
    case "fragment": {
      const f = (view.fragments[ev.fragmentId] ??= { fragmentId: ev.fragmentId, phaseId: ev.phaseId, segmentIds: ev.segmentIds, state: ev.state, label: ev.label, history: [] });
      f.state = ev.state;
      f.segmentIds = ev.segmentIds;
      f.label = ev.label;
      f.reason = ev.reason;
      if (ev.effect) f.effect = ev.effect;
      f.history.push({ t: ev.t, state: ev.state, reason: ev.reason });
      break;
    }
  }
  return view;
}

/** Derived metrics shared by the dashboard and benchmark reports. */
export function deriveMetrics(view: RunView): {
  elapsedMs: number;
  verified: number;
  throughputPerMin: number;
  recentThroughputPerMin: number;
  utilization: number;
  activeWorkers: number;
  costPerVerifiedUsd: number | null;
  modelFreeActionRatio: number | null;
  firstActionMs: number | null;
  firstVerifiedMs: number | null;
  overlapMs: number;
} {
  const elapsedMs = view.summary?.wallMs ?? view.lastT;
  const verified = view.receipts.VERIFIED;
  const runStart = view.phaseT.running ?? 0;
  const execMs = Math.max(1, elapsedMs - runStart);
  const windowMs = 10_000;
  const recent = view.verifiedTimeline.filter((t) => t >= view.lastT - windowMs).length;
  const workers = Object.values(view.workers);
  const totalBusy = workers.reduce((s, w) => s + w.busyMs + (w.state !== "IDLE" && w.state !== "STOPPED" ? view.lastT - w.sinceT : 0), 0);
  const utilization = workers.length ? totalBusy / (workers.length * execMs) : 0;
  return {
    elapsedMs,
    verified,
    throughputPerMin: verified / (execMs / 60_000),
    recentThroughputPerMin: recent / (windowMs / 60_000),
    utilization: Math.min(1, utilization),
    activeWorkers: workers.filter((w) => w.state !== "IDLE" && w.state !== "STOPPED").length,
    costPerVerifiedUsd: verified > 0 ? view.modelCalls.costUsd / verified : null,
    modelFreeActionRatio: view.actions.count > 0 ? view.actions.modelFree / view.actions.count : null,
    firstActionMs: view.firstActionT ?? null,
    firstVerifiedMs: view.firstVerifiedT ?? null,
    overlapMs: stageOverlapMs(view.stages, view.lastT),
  };
}

/**
 * Wall time during which a thinking stage (discovery, planning, compilation, critique, probe) and
 * browser execution were both active. Zero for strictly stage-gated runs.
 */
export function stageOverlapMs(stages: RunView["stages"], now: number): number {
  const merge = (xs: { start: number; end: number }[]) => {
    const s = [...xs].sort((a, b) => a.start - b.start);
    const out: { start: number; end: number }[] = [];
    for (const x of s) {
      const last = out.at(-1);
      if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
      else out.push({ ...x });
    }
    return out;
  };
  const thinking = merge(stages.filter((s) => s.stage !== "execution" && s.stage !== "optimization").map((s) => ({ start: s.start, end: s.end ?? now })));
  const exec = merge(stages.filter((s) => s.stage === "execution").map((s) => ({ start: s.start, end: s.end ?? now })));
  let total = 0;
  for (const a of thinking) for (const b of exec) total += Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
  return Math.round(total);
}
