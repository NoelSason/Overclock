import { z } from "zod";
import { AppBinding, Effect } from "./ir";

/**
 * A: sequential-agent — observe/decide/act loop, one model call per action.
 * B: compiled-single — one planner, compiled program, one worker.
 * C: compiled-parallel — one planner, compiled program, fixed parallel workers.
 * D: overclock-staged — full discovery swarm, then compile, then execute (stage-gated).
 * E: overclock — streaming discovery + incremental compilation + online optimization (flagship).
 */
export const ExecutionMode = z.enum(["sequential-agent", "compiled-single", "compiled-parallel", "overclock-staged", "overclock"]);
export type ExecutionMode = z.infer<typeof ExecutionMode>;

export const IntelligenceMode = z.enum(["single-planner", "parallel-scout", "adaptive"]);
export type IntelligenceMode = z.infer<typeof IntelligenceMode>;

export const ConcurrencyMode = z.enum(["fixed", "adaptive"]);
export type ConcurrencyMode = z.infer<typeof ConcurrencyMode>;

export const RunConfigSchema = z.object({
  goal: z.string().min(1),
  applications: z.array(AppBinding).min(1),
  records: z.array(z.record(z.string(), z.unknown())).default([]),
  mode: ExecutionMode.default("overclock"),
  intelligence: IntelligenceMode.default("adaptive"),
  concurrency: ConcurrencyMode.default("adaptive"),
  maxWorkers: z.number().int().min(1).max(32).default(8),
  /** Initial worker count for adaptive concurrency; the fixed count otherwise. */
  initialWorkers: z.number().int().min(1).max(32).optional(),
  useJev: z.boolean().default(true),
  dryRun: z.boolean().default(false),
  verification: z.literal("required").default("required"),
  optimization: z.literal("minimize-wall-time").default("minimize-wall-time"),
  thumbnails: z.boolean().default(true),
  /** cold = ignore cached app models / compiled programs; warm = reuse when fingerprints match. */
  cache: z.enum(["cold", "warm"]).default("cold"),
  /**
   * Knowledge policy (Overclock Network). When omitted it is derived from `cache` and stays
   * backward compatible: cold -> "strict-cold", warm -> "local-only". Network policies require
   * OVERCLOCK_NETWORK_ENABLED=true on the engine.
   */
  knowledge: z.enum(["strict-cold", "local-only", "network-read", "network-read-and-contribute"]).optional(),
  budgetUsd: z.number().positive().optional(),
  label: z.string().optional(),
  /** Ablation switches (benchmarks). */
  ablation: z
    .object({
      competitiveSynthesis: z.boolean().default(true),
      dryRunProbes: z.boolean().default(true),
      criticalPathPriority: z.boolean().default(true),
      onlineReoptimization: z.boolean().default(true),
      /** E only: execute validated fragments while the plan is still streaming. */
      streaming: z.boolean().default(true),
      /** Online access-path substitution (per-record detail reads -> shared list scans). */
      accessPaths: z.boolean().default(true),
      /** Release each write template for one record first; fan out only after its read-back verifies. */
      writeCanary: z.boolean().default(true),
    })
    .partial()
    .default({}),
});
export type RunConfig = z.infer<typeof RunConfigSchema>;
export type RunConfigInput = z.input<typeof RunConfigSchema>;

export const RunStatus = z.enum(["pending", "discovering", "compiling", "running", "paused", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;

export const TaskState = z.enum([
  "PENDING",
  "READY",
  "LEASED",
  "RUNNING",
  "VERIFYING",
  "REPAIRING",
  "RECONCILING",
  "SUSPENDED",
  "VERIFIED",
  "COMPLETED",
  "FAILED",
  "UNCONFIRMED",
  "SKIPPED",
  "NEEDS_APPROVAL",
  "CANCELLED",
]);
export type TaskState = z.infer<typeof TaskState>;

export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set([
  "VERIFIED",
  "COMPLETED",
  "FAILED",
  "UNCONFIRMED",
  "SKIPPED",
  "NEEDS_APPROVAL",
  "CANCELLED",
]);

export const VerificationStatus = z.enum(["VERIFIED", "FAILED", "UNCONFIRMED", "SKIPPED", "NEEDS_APPROVAL"]);
export type VerificationStatus = z.infer<typeof VerificationStatus>;

export const WorkerState = z.enum([
  "IDLE",
  "LEASED",
  "PRECONDITION_CHECK",
  "EXECUTING",
  "VERIFYING",
  "REPAIRING",
  "RECONCILING",
  "COMPLETED",
  "FAILED",
  "STOPPED",
]);
export type WorkerState = z.infer<typeof WorkerState>;

/** A schedulable basic block: consecutive IR nodes on one app/page executed by one worker. */
export const SegmentTemplate = z.object({
  id: z.string(),
  phaseId: z.string(),
  app: z.string().optional(),
  nodeIds: z.array(z.string()),
  dependsOn: z.array(z.string()),
  effect: Effect,
  kind: z.enum(["read", "write", "compute", "scan"]),
  reads: z.array(z.string()),
  writes: z.array(z.string()),
  label: z.string(),
  estimatedMs: z.number(),
});
export type SegmentTemplate = z.infer<typeof SegmentTemplate>;

export const PhaseTemplate = z.object({
  id: z.string(),
  kind: z.enum(["once", "foreach"]),
  dependsOn: z.array(z.string()),
  segmentIds: z.array(z.string()),
});
export type PhaseTemplate = z.infer<typeof PhaseTemplate>;

export const TemplateGraph = z.object({
  phases: z.array(PhaseTemplate),
  segments: z.array(SegmentTemplate),
});
export type TemplateGraph = z.infer<typeof TemplateGraph>;

export const CostEstimate = z.object({
  modelMs: z.number(),
  browserCriticalPathMs: z.number(),
  recoveryMs: z.number(),
  coordinationMs: z.number(),
  verificationMs: z.number(),
  totalMs: z.number(),
  workers: z.number(),
  modelCostUsd: z.number(),
  /** Which inputs were measured vs assumed. */
  basis: z.array(z.object({ input: z.string(), source: z.enum(["measured", "estimated", "default"]), value: z.number() })),
});
export type CostEstimate = z.infer<typeof CostEstimate>;

export const PassReport = z.object({ name: z.string(), ms: z.number(), changes: z.number(), detail: z.string() });
export type PassReport = z.infer<typeof PassReport>;

export const RunSummary = z.object({
  runId: z.string(),
  mode: ExecutionMode,
  status: RunStatus,
  wallMs: z.number(),
  discoveryMs: z.number(),
  compileMs: z.number(),
  executionMs: z.number(),
  records: z.number(),
  tasks: z.number(),
  verified: z.number(),
  failed: z.number(),
  unconfirmed: z.number(),
  skipped: z.number(),
  needsApproval: z.number(),
  recordsVerified: z.number(),
  recoveries: z.number(),
  modelCalls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  modelCostUsd: z.number(),
  workerUtilization: z.number(),
  maxConcurrency: z.number(),
  strategy: z.string().optional(),
  /** Cold-start metrics (ms since the instruction was submitted). */
  firstActionMs: z.number().nullable().default(null),
  firstVerifiedMs: z.number().nullable().default(null),
  /** Time during which discovery/planning and browser execution ran concurrently. */
  overlapMs: z.number().default(0),
  recoveryMs: z.number().default(0),
  stageMs: z.record(z.string(), z.number()).default({}),
  knowledge: z.string().optional(),
  network: z
    .object({
      lookups: z.number(),
      hits: z.number(),
      outcome: z.string().optional(),
      capabilityId: z.string().optional(),
      version: z.number().optional(),
      lookupMs: z.number(),
      fetchMs: z.number(),
      rebindMs: z.number(),
      published: z.boolean(),
      repairs: z.number(),
    })
    .optional(),
});
export type RunSummary = z.infer<typeof RunSummary>;

/** Per-record outcome the engine reports (what it claims, with evidence). */
export const RecordOutcome = z.object({
  recordKey: z.string(),
  status: VerificationStatus,
  writes: z.number(),
  receipts: z.array(z.string()),
  notes: z.array(z.string()),
});
export type RecordOutcome = z.infer<typeof RecordOutcome>;
