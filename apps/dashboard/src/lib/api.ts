import type {
  ApprovalDecision,
  BenchmarkResultFile,
  CheckResult,
  CreateRunResponse,
  EngineHealth,
  EventsPage,
  PublicScenario,
  RunConfigInput,
  RunListItem,
  RunResultResponse,
  RunStatusResponse,
  ScenarioRequest,
} from "@overclock/contracts";
import { ARENA_ADMIN_URL, ENGINE_URL } from "./config";

/** Thrown for non-2xx responses; carries the parsed error body when the server sent JSON. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: init?.body !== undefined ? { "content-type": "application/json", ...init.headers } : init?.headers,
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string" ? body.error : `${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

const get = <T>(base: string, path: string, signal?: AbortSignal) => request<T>(base, path, { signal });
const post = <T>(base: string, path: string, body: unknown = {}) => request<T>(base, path, { method: "POST", body: JSON.stringify(body) });

/** `GET /api/benchmarks` row. Not part of @overclock/contracts yet. */
export interface BenchmarkListItem {
  name: string;
  suite: string;
  createdAt: number;
  runs: number;
}

export type RunControl = "cancel" | "pause" | "resume";

const run = (id: string) => `/api/runs/${encodeURIComponent(id)}`;

/** One run's outcome in a network transfer report (scripts/network-demo.ts). */
export interface TransferRun {
  runtime: string;
  status: string;
  wallMs: number;
  firstVerifiedMs: number | null;
  modelCalls: number;
  modelCostUsd: number;
  records: number;
  checker: { accuracy: number; correct: number; total: number; duplicateWrites: number; collateralWrites: number };
}

/** `GET /api/transfers` row: a recorded `pnpm network:demo` report. Not part of @overclock/contracts. */
export interface TransferReport {
  name: string;
  at: string;
  passed: boolean;
  expectRefusal?: boolean;
  /** Set on regression runs where runtime A reused its own cached plan instead of learning cold. */
  aWarmCache?: string | null;
  /** The conflict arm: a runtime asking for the same task with one value changed (null when not run). */
  conflict?: { goal: string; lookup: string; importOutcome: string | null; refused: string[]; writes: number | null; receipts: number; plannerCalls: number; status: string; error: string | null } | null;
  records: number;
  seed: number;
  variation: string | null;
  versionId: string;
  checks: { check: string; ok: boolean; detail: string }[];
  validation: { outcome: string; category: string; ms: number } | null;
  overhead: { aPublishMs: number | null; validationMs: number | null; promoteMs: number | null; bLookupMs: number | null; bFetchMs: number | null; bRebindMs: number | null };
  plannerCalls: { a: number; b: number };
  comparison: { wallSpeedup?: number; timeToFirstVerifiedSpeedup?: number | null; costUsd?: { strictCold: number; networkWarm: number }; note?: string };
  transfer?: {
    identities: { a: string | null; b: string | null; publisher: string | null };
    bCacheBefore: number;
    variations: { renameButtons?: Record<string, Record<string, string>>; editInTab?: Record<string, boolean> } | null;
    relabeled: { key: string; from: string; to: string; evidence: string }[];
    writeCanary: boolean;
    canaryPassed: number;
    refused: string[];
    importOutcome: string | null;
    actionsB: Record<string, number>;
    verifiedB: number;
    /** Writes the arena itself committed while B ran (absent in older recordings). */
    arenaWritesB?: number;
  };
  a: TransferRun;
  b: TransferRun;
  c: TransferRun | null;
  /** C again on the same records from its own local cache (--warm-arm); absent in older reports. */
  warm?: TransferRun | null;
}

export const engine = {
  health: (signal?: AbortSignal) => get<EngineHealth>(ENGINE_URL, "/api/health", signal),
  listRuns: (signal?: AbortSignal) => get<RunListItem[]>(ENGINE_URL, "/api/runs", signal),
  createRun: (config: RunConfigInput) => post<CreateRunResponse>(ENGINE_URL, "/api/runs", config),
  run: (id: string, signal?: AbortSignal) => get<RunStatusResponse>(ENGINE_URL, run(id), signal),
  events: (id: string, after: number, limit: number, signal?: AbortSignal) => get<EventsPage>(ENGINE_URL, `${run(id)}/events?after=${after}&limit=${limit}`, signal),
  streamUrl: (id: string, after: number) => `${ENGINE_URL}${run(id)}/stream?after=${after}`,
  control: (id: string, action: RunControl) => post<unknown>(ENGINE_URL, `${run(id)}/${action}`),
  approve: (id: string, decision: ApprovalDecision) => post<unknown>(ENGINE_URL, `${run(id)}/approvals`, decision),
  result: (id: string, signal?: AbortSignal) => get<RunResultResponse>(ENGINE_URL, `${run(id)}/result`, signal),
  program: (id: string, signal?: AbortSignal) => get<unknown>(ENGINE_URL, `${run(id)}/program`, signal),
  artifact: (id: string, artifactId: string, signal?: AbortSignal) => get<unknown>(ENGINE_URL, `${run(id)}/artifacts/${encodeURIComponent(artifactId)}`, signal),
  benchmarks: (signal?: AbortSignal) => get<BenchmarkListItem[]>(ENGINE_URL, "/api/benchmarks", signal),
  benchmark: (name: string, signal?: AbortSignal) => get<BenchmarkResultFile>(ENGINE_URL, `/api/benchmarks/${encodeURIComponent(name)}`, signal),
  transfers: (signal?: AbortSignal) => get<TransferReport[]>(ENGINE_URL, "/api/transfers", signal),
};

/** Judge surprises the arena admin API accepts. Not part of @overclock/contracts yet. */
export const SURPRISE_KINDS = ["rename-save", "confirm-modal", "announcement", "latency", "partial-failure", "fields-in-tab", "shuffle-fields", "concurrency-limit", "clear"] as const;
export type SurpriseKind = (typeof SURPRISE_KINDS)[number];
export type ArenaApp = "CRM" | "Orders" | "Support" | "all";

export const arena = {
  scenario: (signal?: AbortSignal) => get<PublicScenario>(ARENA_ADMIN_URL, "/api/scenario", signal),
  createScenario: (req: ScenarioRequest) => post<PublicScenario>(ARENA_ADMIN_URL, "/api/scenario", req),
  check: () => get<CheckResult>(ARENA_ADMIN_URL, "/api/check"),
  surprise: (kind: SurpriseKind, app: ArenaApp) => post<unknown>(ARENA_ADMIN_URL, "/api/judge/surprise", { kind, app }),
  editUnprocessed: () => post<unknown>(ARENA_ADMIN_URL, "/api/judge/edit-unprocessed"),
};

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof TypeError) return "Could not reach the server";
  if (err instanceof Error) return err.message;
  return String(err);
}
