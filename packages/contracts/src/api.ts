import { z } from "zod";
import type { RunEvent } from "./events";
import type { RunView } from "./reducer";
import type { RecordOutcome, RunStatus, RunSummary } from "./run";

/** Engine HTTP API shapes shared by the engine, the SDK, the CLI, and the dashboard. */

export interface CreateRunResponse {
  runId: string;
  status: RunStatus;
}

export interface RunListItem {
  runId: string;
  status: RunStatus;
  mode: string;
  goal: string;
  createdAt: number;
  label?: string | undefined;
  summary?: RunSummary | undefined;
}

export interface RunStatusResponse {
  runId: string;
  status: RunStatus;
  view: RunView;
}

export interface RunResultResponse {
  runId: string;
  status: RunStatus;
  summary: RunSummary | null;
  outcomes: RecordOutcome[];
  /**
   * Verification semantics: an outcome is VERIFIED only when every state-changing step for that
   * record was read back from the application after a fresh navigation and matched the expected
   * values. UNCONFIRMED means a write may or may not have committed and could not be confirmed.
   */
  verificationSemantics: string;
}

export interface EventsPage {
  runId: string;
  events: RunEvent[];
  nextSeq: number;
}

export const ApprovalDecision = z.object({ approvalId: z.string(), approved: z.boolean() });
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

export interface EngineHealth {
  ok: boolean;
  version: string;
  capabilities: {
    anthropic: { available: boolean; plannerModel: string; helperModel: string; reason?: string | undefined };
    typesafe: { available: boolean; model: string; visionModel: string; reason?: string | undefined };
    browser: { available: boolean; reason?: string | undefined };
  };
}
