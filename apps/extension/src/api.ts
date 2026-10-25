import type { AgentStepRequest, AgentStepResponse, AgentTaskInfo, RecordOutcome, RunEvent, RunStatus, RunSummary, RunView } from "@overclock/contracts";
import { SseParser } from "./sse";

/**
 * Client for the engine's extension gateway (`/api/x/*`). Every call but pairing carries the
 * session token; the stream is read with fetch, because EventSource can't send headers.
 * The response shapes mirror services/engine/src/{extension,workflows}.ts.
 */

export interface WorkflowApp {
  name: string;
  origin: string;
}

export interface WorkflowSummary {
  id: string;
  title: string;
  instructions: string | null;
  applications: WorkflowApp[];
  recordFields: string[];
  learnedRecords: number | null;
  learnedAt: number | null;
  requiredRecords: number | null;
  source: "learned-here" | "imported";
  importedFrom: string | null;
  review: { status: string; reason?: string } | null;
  steps: number;
  changingSteps: number;
  runnable: boolean;
  whyNot: string | null;
}

export type StepAction = "open" | "read" | "read-table" | "fill" | "choose" | "click" | "submit" | "decide" | "check" | "wait";

export interface PreviewStep {
  id: string;
  action: StepAction;
  app: string | null;
  text: string;
  changesData: boolean;
  needsApproval: boolean;
  conditional: boolean;
  verifiedBy: string | null;
  detail: string | null;
}

export interface WorkflowPreview {
  previewId: string;
  source: "local" | "network" | "new";
  workflowId: string | null;
  title: string;
  instructions: string;
  applications: WorkflowApp[];
  recordFields: string[];
  records: number;
  review: { status: string; reason?: string } | null;
  network: { versionId: string; publisher: string; state: string; validations: number; successfulReuses: number } | null;
  phases: { id: string; runs: "once" | "per-record" | "per-derived-item"; steps: PreviewStep[] }[];
  writes: { steps: number; maxWrites: number | null };
  approvals: number;
  modelCalls: "none" | "planning";
  blocking: string[];
  notes: string[];
}

export interface EngineStatus {
  version: string;
  browser: { kind: "overclock-chromium"; visible: boolean; available: boolean };
  planning: { available: boolean };
  network: { enabled: boolean; connected: boolean };
  environment: { label: string; applications: WorkflowApp[] };
  agent: { available: boolean; model: string | null };
  google: { configured: boolean; email: string | null };
}

export interface Receipt {
  taskId: string;
  recordKey: string;
  nodeId: string;
  status: string;
  fields: { name: string; expected: unknown; actual: unknown }[];
}

export interface RunResult {
  runId: string;
  status: RunStatus;
  summary: RunSummary | null;
  outcomes: RecordOutcome[];
  verificationSemantics: string;
  receipts: Receipt[];
}

export interface RunRequest {
  previewId: string;
  workflowId?: string;
  instructions?: string;
  applications?: string[];
  records: Record<string, string>[];
  allowModelCalls?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = typeof fetch;
/** fetch must be called with the global as `this`; a stored reference called as a method throws "Illegal invocation" in browsers. */
const globalFetch: Fetch = (input, init) => fetch(input, init);

/** Normalize an engine address the user typed: loopback only, no path. */
export function engineOrigin(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim().includes("://") ? input.trim() : `http://${input.trim()}`);
  } catch {
    throw new ApiError(0, "That isn't a valid address.");
  }
  if (u.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(u.hostname)) throw new ApiError(0, "Overclock's engine runs on this computer: use http://127.0.0.1:<port> or http://localhost:<port>.");
  return u.origin;
}

async function errorOf(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // not JSON
  }
  return new ApiError(res.status, message);
}

export async function pair(origin: string, code: string, fetchImpl: Fetch = globalFetch): Promise<{ token: string; expiresAt: number }> {
  let res: Response;
  try {
    res = await fetchImpl(`${origin}/api/x/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  } catch {
    throw new ApiError(0, `Can't reach the engine at ${origin}. Is it running (pnpm engine)?`);
  }
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as { token: string; expiresAt: number };
}

export class OverclockApi {
  constructor(
    readonly origin: string,
    private readonly token: string,
    private readonly fetchImpl: Fetch = globalFetch,
  ) {}

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.origin}/api/x/${path}`, { ...init, headers: { authorization: `Bearer ${this.token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) } });
    } catch (err) {
      if (init.signal?.aborted) throw err;
      throw new ApiError(0, `Lost the connection to the engine at ${this.origin}.`);
    }
    if (!res.ok) throw await errorOf(res);
    return (await res.json()) as T;
  }

  status(): Promise<EngineStatus> {
    return this.call("status");
  }
  workflows(): Promise<{ workflows: WorkflowSummary[]; applications: WorkflowApp[] }> {
    return this.call("workflows");
  }
  preview(body: Omit<RunRequest, "previewId" | "allowModelCalls">): Promise<WorkflowPreview> {
    return this.call("preview", { method: "POST", body: JSON.stringify(body) });
  }
  startRun(body: RunRequest): Promise<{ runId: string; status: RunStatus }> {
    return this.call("runs", { method: "POST", body: JSON.stringify(body) });
  }
  run(id: string): Promise<{ runId: string; status: RunStatus; view: RunView }> {
    return this.call(`runs/${encodeURIComponent(id)}`);
  }
  result(id: string): Promise<RunResult> {
    return this.call(`runs/${encodeURIComponent(id)}/result`);
  }
  approve(id: string, approvalId: string, approved: boolean): Promise<{ ok: boolean }> {
    return this.call(`runs/${encodeURIComponent(id)}/approvals`, { method: "POST", body: JSON.stringify({ approvalId, approved }) });
  }
  cancel(id: string): Promise<{ ok: boolean }> {
    return this.call(`runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: "{}" });
  }

  agentStart(task: string): Promise<AgentTaskInfo> {
    return this.call("agent/tasks", { method: "POST", body: JSON.stringify({ task }) });
  }
  agentStep(id: string, body: AgentStepRequest, signal?: AbortSignal): Promise<AgentStepResponse> {
    return this.call(`agent/tasks/${encodeURIComponent(id)}/step`, { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  }
  agentStop(id: string): Promise<{ ok: boolean }> {
    return this.call(`agent/tasks/${encodeURIComponent(id)}/stop`, { method: "POST", body: "{}" });
  }
  googleConnect(): Promise<{ url: string }> {
    return this.call("google/connect", { method: "POST", body: "{}" });
  }
  googleDisconnect(): Promise<{ ok: boolean }> {
    return this.call("google/disconnect", { method: "POST", body: "{}" });
  }

  async thumbnail(id: string, workerId: string): Promise<Blob | null> {
    const res = await this.fetchImpl(`${this.origin}/api/x/runs/${encodeURIComponent(id)}/workers/${encodeURIComponent(workerId)}/thumb.jpg`, { headers: { authorization: `Bearer ${this.token}` } }).catch(() => null);
    return res?.ok ? res.blob() : null;
  }

  /**
   * Stream a run's events from `after`, calling `onEvent` for each, until the run ends or the
   * signal aborts. Resolves true when the engine sent the end of the stream.
   */
  async stream(id: string, after: number, onEvent: (e: RunEvent) => void, signal?: AbortSignal): Promise<boolean> {
    const res = await this.fetchImpl(`${this.origin}/api/x/runs/${encodeURIComponent(id)}/stream?after=${after}`, { headers: { authorization: `Bearer ${this.token}`, accept: "text/event-stream" }, signal: signal ?? null });
    if (!res.ok || !res.body) throw res.ok ? new ApiError(0, "The engine sent no event stream.") : await errorOf(res);
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return false;
      for (const m of parser.push(decoder.decode(value, { stream: true }))) {
        if (m.event === "end") return true;
        if (m.event === "run-event") onEvent(JSON.parse(m.data) as RunEvent);
      }
    }
  }
}
