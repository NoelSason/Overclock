import type { CostEstimate, ExecutionMode, PassReport, RunConfig, RunStatus, RunSummary, SegmentTemplate, PhaseTemplate, TaskState, VerificationStatus, WorkerState } from "./run";

/**
 * Append-only execution history. Every event is persisted before it is broadcast, and the
 * dashboard reconstructs run state by replaying events through the shared reducer.
 */

export type AgentRole = "ui-scout" | "workflow-scout" | "dependency-scout" | "optimization-scout" | "adversarial-verifier" | "planner" | "repair";

export interface ArtifactSummary {
  artifactId: string;
  kind: "app-model" | "plan-candidates" | "risk-report" | "dependency-report" | "cost-estimates" | "dry-run" | "effect-classification" | "plan" | "patch";
  title: string;
  /** Short human summary; full artifact is fetched from /runs/:id/artifacts/:artifactId. */
  summary: string;
  stats?: Record<string, number | string> | undefined;
}

type E<T extends string, P> = { type: T } & P;

export type EventPayload =
  | E<"run.created", { config: RunConfig }>
  | E<"run.status", { status: RunStatus; reason?: string }>
  | E<"run.completed", { summary: RunSummary }>
  /** Adversarial review of a plan before its writes may run: one event per round, then a rejection if it fails closed. */
  | E<"review", { subject: string; round: number; status: "passed" | "risks" | "unavailable" | "rejected"; highRisks: number; reason?: string; ms?: number }>
  | E<"policy.decision", { intelligence: "single-planner" | "parallel-scout" | "warm-cache" | "network-import"; candidates: number; reason: string; features: Record<string, number | string | boolean> }>
  | E<"agent.started", { agentId: string; role: AgentRole; label: string; model?: string; app?: string }>
  | E<"agent.artifact", { agentId: string; artifact: ArtifactSummary }>
  | E<"agent.finished", { agentId: string; ok: boolean; ms: number; error?: string }>
  | E<"candidate.proposed", { candidateId: string; name: string; summary: string; agentId: string }>
  | E<"candidate.evaluated", { candidateId: string; estimate: CostEstimate | null; valid: boolean; issues: string[] }>
  | E<"candidate.selected", { candidateId: string; reason: string; ranking: { candidateId: string; totalMs: number | null }[] }>
  | E<"program.compiled", { programId: string; strategy: string; phases: PhaseTemplate[]; segments: SegmentTemplate[]; passes: PassReport[]; nodeCount: number; compileMs: number }>
  | E<"program.patched", { programId: string; segmentIds: string[]; reason: string; level: number }>
  | E<"tasks.created", { tasks: { taskId: string; segmentId: string; phaseId: string; recordKey: string }[] }>
  | E<"task.state", { taskId: string; state: TaskState; workerId?: string; attempt?: number; error?: string; ms?: number }>
  | E<"worker.state", { workerId: string; state: WorkerState; taskId?: string; app?: string; op?: string; label?: string }>
  | E<"worker.thumb", { workerId: string; url: string }>
  | E<"action", { taskId: string; nodeId: string; actionType: string; ms: number; ok: boolean; modelCalls: number; locatorTier?: number; detail?: string }>
  | E<"receipt", { taskId: string; recordKey: string; status: VerificationStatus; nodeId: string; fields: { name: string; expected: unknown; actual: unknown }[] }>
  | E<"lock.conflict", { taskId: string; resource: string; holder: string }>
  | E<"recovery", { taskId: string; level: number; phase: "started" | "succeeded" | "failed" | "escalated"; reason: string; detail?: string; ms?: number; propagatedTo?: number }>
  | E<"invalidation", { taskId: string; recordKey: string; reason: string; invalidated: string[] }>
  | E<"model.call", { provider: "anthropic" | "typesafe"; model: string; purpose: string; ms: number; inputTokens: number; outputTokens: number; costUsd: number; ok: boolean; error?: string; speed?: "standard" | "fast"; ttftMs?: number | null }>
  | E<"concurrency", { app: string; limit: number; reason: string }>
  | E<"reopt.decision", { switched: boolean; reason: string; remainingMs: number; alternativeMs: number | null; alternative?: string }>
  | E<"approval.requested", { approvalId: string; taskId: string; nodeId: string; description: string }>
  | E<"approval.resolved", { approvalId: string; approved: boolean }>
  | E<"log", { level: "debug" | "info" | "warn" | "error"; message: string }>
  /** Pipeline stage intervals (stages may overlap in streaming mode). */
  | E<"stage", { stage: StageName; phase: "start" | "end"; detail?: string }>
  /** A scout loaded and observed a page (live discovery progress). */
  | E<"scout.page", { agentId: string; app: string; url: string; routePattern: string; loadMs: number; controls: number }>
  /** Overclock Network: capability lookup / import / publication / repair / live updates. */
  | E<"network.lookup", { origins: string[]; outcome: string; source: string; candidates: number; ms: number; capabilityId?: string; version?: number; /** First 16 hex characters of this runtime's public network identity. */ identity?: string }>
  | E<"network.import", { capabilityId: string; version: number; outcome: string; bound: number; unbound: number; rebindMs: number; fetchMs: number; source: string; avoided?: { modelCalls: number; discoveryMs: number; estimated: true }; publisher?: string; writeCanary?: boolean; relabeled?: { key: string; from: string; to: string; evidence: string }[]; refused?: string[] }>
  | E<"network.publish", { capabilityId: string; version: number; state: string; ms: number; redactions: number; bytes: number; rejected?: string }>
  | E<"network.repair", { capabilityId: string; jobId: string; phase: "reported" | "claimed" | "waiting" | "proposed" | "validated" | "promoted" | "fallback" | "released" | "lost-lease"; fencingToken?: number; ms?: number; detail?: string }>
  | E<"network.update", { capabilityId: string; version: number; state: string; propagationMs?: number }>
  /** Incrementally compiled executable fragment lifecycle. */
  | E<"fragment", { fragmentId: string; phaseId: string; segmentIds: string[]; state: FragmentState; label: string; reason?: string; effect?: string }>;

export type StageName = "discovery" | "planning" | "compilation" | "critique" | "probe" | "execution" | "optimization";

/**
 * compiled: lowered and segmented; validated: selectors/expressions/effects checked; canary: running for
 * one record; released: fanned out to all records; deferred: waiting for a safety gate (reason says which);
 * revised: replaced by a newer version; rejected: will not run.
 */
export type FragmentState = "compiled" | "validated" | "canary" | "released" | "deferred" | "revised" | "rejected";

export type EventType = EventPayload["type"];

export type RunEvent = EventPayload & {
  runId: string;
  seq: number;
  /** Wall clock (ms since epoch). */
  ts: number;
  /** Monotonic ms since run start. */
  t: number;
};

export type EventOf<T extends EventType> = Extract<RunEvent, { type: T }>;

export interface EventSink {
  emit(event: EventPayload): RunEvent;
}

export type { ExecutionMode };
