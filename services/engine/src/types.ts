import type { EngineHealth, RunConfig, RunEvent, RunListItem, RunResultResponse, RunStatus, RunView } from "@overclock/contracts";

/**
 * Contract between the HTTP layer (server.ts, store.ts) and the run orchestrator (run.ts).
 * The orchestrator implements RunManager/RunHandle; the server only talks to these interfaces.
 */
export interface RunHandle {
  readonly runId: string;
  readonly config: RunConfig;
  readonly createdAt: number;
  status(): RunStatus;
  /** Reducer state built from this run's events (same reducer the dashboard uses). */
  view(): RunView;
  /** Events with seq > after, in order. */
  events(after: number, limit?: number): RunEvent[];
  /** Subscribe to new events; returns an unsubscribe function. */
  subscribe(listener: (e: RunEvent) => void): () => void;
  /** True once run.completed has been emitted (stream can close after flushing). */
  finished(): boolean;
  result(): RunResultResponse;
  metrics(): unknown;
  /** OTLP/JSON trace export. */
  trace(): unknown;
  artifact(artifactId: string): unknown | undefined;
  /** Latest JPEG thumbnail for a worker, if any. */
  thumbnail(workerId: string): Buffer | undefined;
  /** Compiled program summary (template graph + IR) once compiled. */
  program(): unknown | undefined;
  cancel(reason?: string): void;
  pause(): void;
  resume(): void;
  approve(approvalId: string, approved: boolean): boolean;
}

export interface RunManager {
  create(config: RunConfig): Promise<RunHandle>;
  get(runId: string): RunHandle | undefined;
  list(): RunListItem[];
  health(): Promise<EngineHealth>;
}
