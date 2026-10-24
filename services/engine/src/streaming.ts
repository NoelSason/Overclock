import type { StorageState } from "@overclock/browser-runtime";
import type { RecoveryEngine } from "@overclock/recovery";
import type { SwarmDeps } from "@overclock/swarm";
import type { Executor } from "./executor";
import type { RunController } from "./run";

export interface StreamingArgs {
  run: RunController;
  swarmDeps: SwarmDeps;
  executeState: StorageState | undefined;
  recovery: RecoveryEngine;
  setExecutor(e: Executor): void;
  setProgram(p: unknown): void;
}

/** Streaming pipeline (mode E). Implemented in the next step; see docs/ARCHITECTURE.md. */
export async function runStreamingPipeline(_args: StreamingArgs): Promise<void> {
  throw new Error("streaming pipeline not implemented yet");
}
