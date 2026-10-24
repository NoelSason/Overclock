import type { RunStatus, TaskState, WorkerState } from "@overclock/contracts";

/**
 * Visual grouping of task states. Colors are hex so the heatmap canvas and CSS share them.
 * Order is the legend order (pipeline order, then outcomes).
 */
export type StateCategory = "pending" | "ready" | "running" | "recovering" | "approval" | "verified" | "done" | "unconfirmed" | "failed" | "skipped";

export const CATEGORY: Record<StateCategory, { label: string; color: string }> = {
  pending: { label: "Waiting", color: "#3b4757" },
  ready: { label: "Ready", color: "#8ab4ff" },
  running: { label: "Running", color: "#3d8bff" },
  recovering: { label: "Recovering", color: "#f2b13c" },
  approval: { label: "Needs approval", color: "#b28cff" },
  verified: { label: "Verified", color: "#2fd27a" },
  done: { label: "Done (no write)", color: "#4fa894" },
  unconfirmed: { label: "Unconfirmed", color: "#ff8a3d" },
  failed: { label: "Failed", color: "#f0524f" },
  skipped: { label: "Skipped", color: "#6b7482" },
};

export const CATEGORY_ORDER = Object.keys(CATEGORY) as StateCategory[];

export const TASK_CATEGORY: Record<TaskState, StateCategory> = {
  PENDING: "pending",
  SUSPENDED: "pending",
  READY: "ready",
  LEASED: "running",
  RUNNING: "running",
  VERIFYING: "running",
  REPAIRING: "recovering",
  RECONCILING: "recovering",
  NEEDS_APPROVAL: "approval",
  VERIFIED: "verified",
  COMPLETED: "done",
  UNCONFIRMED: "unconfirmed",
  FAILED: "failed",
  SKIPPED: "skipped",
  CANCELLED: "skipped",
};

/** Every task state in pipeline order (matches the TaskState enum order). */
export const TASK_STATES: TaskState[] = ["PENDING", "READY", "LEASED", "RUNNING", "VERIFYING", "REPAIRING", "RECONCILING", "SUSPENDED", "VERIFIED", "COMPLETED", "FAILED", "UNCONFIRMED", "SKIPPED", "NEEDS_APPROVAL", "CANCELLED"];

export const taskColor = (s: TaskState): string => CATEGORY[TASK_CATEGORY[s]].color;

export const WORKER_COLOR: Record<WorkerState, string> = {
  IDLE: "#4a5566",
  LEASED: "#8ab4ff",
  PRECONDITION_CHECK: "#8ab4ff",
  EXECUTING: "#3d8bff",
  VERIFYING: "#38c6e8",
  REPAIRING: "#f2b13c",
  RECONCILING: "#f2b13c",
  COMPLETED: "#2fd27a",
  FAILED: "#f0524f",
  STOPPED: "#3b4757",
};

export const STATUS_TONE: Record<RunStatus, "neutral" | "accent" | "ok" | "warn" | "bad"> = {
  pending: "neutral",
  discovering: "accent",
  compiling: "accent",
  running: "accent",
  paused: "warn",
  completed: "ok",
  failed: "bad",
  cancelled: "neutral",
};

export const ACTIVE_STATUSES: ReadonlySet<RunStatus> = new Set(["pending", "discovering", "compiling", "running", "paused"]);
