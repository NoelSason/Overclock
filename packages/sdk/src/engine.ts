import {
  RunConfigSchema,
  type CreateRunResponse,
  type EngineHealth,
  type EventsPage,
  type RunConfigInput,
  type RunEvent,
  type RunListItem,
  type RunResultResponse,
  type RunStatus,
  type RunStatusResponse,
} from "@overclock/contracts";
import { OverclockError } from "./errors";
import { HttpClient, combineSignals, describeFetchError, envVar, errorMessageFromBody, parseBody, sleep, type FetchLike } from "./http";
import { readSseMessages } from "./sse";

export const DEFAULT_ENGINE_URL = "http://127.0.0.1:4000";

export interface OverclockOptions {
  /** Engine base URL. Defaults to `$OVERCLOCK_URL`, then http://127.0.0.1:4000. */
  endpoint?: string | undefined;
  /** Custom fetch (tests, proxies). Defaults to the global fetch. */
  fetch?: FetchLike | undefined;
  /** Timeout for each JSON request in ms (default 30000; 0 disables). Streams use `streamIdleTimeoutMs`. */
  timeoutMs?: number | undefined;
  /** Consecutive failed reconnects before `stream()` gives up (default 5). Any received event resets the count. */
  maxReconnects?: number | undefined;
  /** Base delay before reconnecting a dropped stream, doubling per attempt up to 5s (default 250). A server `retry:` field overrides it. */
  reconnectDelayMs?: number | undefined;
  /** Treat a stream that delivers nothing, not even a heartbeat, for this long as dropped and reconnect (default 60000). */
  streamIdleTimeoutMs?: number | undefined;
}

export interface StreamOptions {
  /** Only yield events with `seq` greater than this (default 0 = from the start). */
  after?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface FollowOptions {
  signal?: AbortSignal | undefined;
  /** Called for every event, in `seq` order, starting from the first event of the run. */
  onEvent?: ((event: RunEvent) => void) | undefined;
}

export type ControlResponse = { ok: boolean; status: RunStatus };

/** HTTP statuses on (re)connect that mean "try again" rather than "this will never work". */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RECONNECT_DELAY_MS = 5_000;
const CANCEL_ON_ABORT_TIMEOUT_MS = 2_000;

/** Internal control flow: the stream dropped and should be resumed from the last seq. */
class StreamDropped {
  constructor(readonly cause: unknown) {}
}

/**
 * Validates a run config with the contract schema without sending anything.
 * Throws `OverclockError` (`status: 0`, `code: "validation"`, `body`: the zod issues).
 */
export function validateRunConfig(config: RunConfigInput): void {
  const parsed = RunConfigSchema.safeParse(config);
  if (parsed.success) return;
  const issues = parsed.error.issues;
  const detail = issues.map((i) => `${i.path.map(String).join(".") || "(config)"}: ${i.message}`).join("; ");
  throw new OverclockError(`Invalid run config: ${detail}`, { status: 0, code: "validation", body: issues });
}

function parseRunEvent(data: string): RunEvent {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch (err) {
    throw new OverclockError("Engine stream sent an event that is not valid JSON", { status: 0, code: "protocol", body: data, cause: err });
  }
  if (typeof value !== "object" || value === null || !("seq" in value) || typeof value.seq !== "number" || !("type" in value) || typeof value.type !== "string") {
    throw new OverclockError("Engine stream sent an event without `seq` and `type`", { status: 0, code: "protocol", body: value });
  }
  // Shape beyond seq/type is the engine's contract (same `RunEvent` type on both sides).
  return value as RunEvent;
}

/** Client for the Overclock engine HTTP API. */
export class Overclock {
  readonly endpoint: string;
  private readonly http: HttpClient;
  private readonly maxReconnects: number;
  private readonly reconnectDelayMs: number;
  private readonly streamIdleTimeoutMs: number;

  constructor(opts: OverclockOptions = {}) {
    this.http = new HttpClient({
      service: "Overclock engine",
      endpoint: opts.endpoint || envVar("OVERCLOCK_URL") || DEFAULT_ENGINE_URL,
      fetch: opts.fetch,
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
    this.endpoint = this.http.endpoint;
    this.maxReconnects = opts.maxReconnects ?? 5;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 250;
    this.streamIdleTimeoutMs = opts.streamIdleTimeoutMs ?? 60_000;
  }

  health(): Promise<EngineHealth> {
    return this.http.request("GET", "/api/health");
  }

  /**
   * Creates a run and returns immediately. The config is validated client-side against
   * `RunConfigSchema` first; invalid input rejects with `OverclockError` (`status: 0`,
   * `code: "validation"`) and nothing is sent.
   */
  start(config: RunConfigInput, opts: { signal?: AbortSignal | undefined } = {}): Promise<CreateRunResponse> {
    try {
      validateRunConfig(config);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.http.request("POST", "/api/runs", { body: config, signal: opts.signal });
  }

  /**
   * Starts a run, follows its event stream until the run finishes, and returns the verified result.
   *
   * Verification semantics: an outcome is `VERIFIED` only when every state-changing step for that
   * record was read back from the application after a fresh navigation and matched the expected
   * values. `UNCONFIRMED` means a write may or may not have committed and could not be confirmed;
   * treat it as needing a human check, never as success.
   *
   * Resolves for every terminal run status (`completed`, `failed`, `cancelled`); inspect
   * `result.status` and `result.outcomes`. Rejects on validation, transport, or HTTP errors.
   * Aborting `signal` stops following the run, asks the engine to cancel it (best effort, since
   * this call started it), and rejects with the signal's reason.
   */
  async execute(config: RunConfigInput, opts: FollowOptions = {}): Promise<RunResultResponse> {
    const { signal } = opts;
    const { runId } = await this.start(config, { signal });
    try {
      await this.waitForCompletion(runId, opts);
    } catch (err) {
      if (signal?.aborted) {
        await this.http.request("POST", `/api/runs/${encodeURIComponent(runId)}/cancel`, { timeoutMs: CANCEL_ON_ABORT_TIMEOUT_MS }).catch(() => undefined);
      }
      throw err;
    }
    return this.http.request("GET", `/api/runs/${encodeURIComponent(runId)}/result`, { signal });
  }

  status(runId: string): Promise<RunStatusResponse> {
    return this.http.request("GET", `/api/runs/${encodeURIComponent(runId)}`);
  }

  list(): Promise<RunListItem[]> {
    return this.http.request("GET", "/api/runs");
  }

  /** One page of persisted events with `seq > after`. Use `page.nextSeq` as the next `after`. */
  events(runId: string, after?: number, limit?: number): Promise<EventsPage> {
    return this.http.request("GET", `/api/runs/${encodeURIComponent(runId)}/events`, { query: { after, limit } });
  }

  /**
   * Live run events over Server-Sent Events, in `seq` order with no duplicates. If the connection
   * drops (network error, server close without `end`, or no bytes for `streamIdleTimeoutMs`), it
   * reconnects with `Last-Event-ID` and `?after=` set to the last seq received, up to
   * `maxReconnects` consecutive attempts, then throws `OverclockError` (`code: "network"`).
   * Ends when the server sends `end` (after `run.completed`). Aborting `signal` throws its reason.
   */
  async *stream(runId: string, opts: StreamOptions = {}): AsyncGenerator<RunEvent, void, undefined> {
    const { signal } = opts;
    const path = `/api/runs/${encodeURIComponent(runId)}/stream`;
    let lastSeq = opts.after ?? 0;
    let failures = 0;
    let baseDelayMs = this.reconnectDelayMs;
    let completed = false;

    for (;;) {
      signal?.throwIfAborted();
      const conn = new AbortController();
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => conn.abort(new Error(`no data for ${this.streamIdleTimeoutMs}ms`)), this.streamIdleTimeoutMs);
      };
      let dropCause: unknown;
      try {
        armIdle();
        const headers: Record<string, string> = { accept: "text/event-stream", "cache-control": "no-cache" };
        if (lastSeq > 0) headers["last-event-id"] = String(lastSeq);
        let res: Response;
        try {
          res = await this.http.fetch(this.http.url(path, { after: lastSeq }), { headers, signal: combineSignals(signal, conn.signal) ?? null });
        } catch (err) {
          if (signal?.aborted) throw signal.reason;
          throw new StreamDropped(err);
        }
        if (!res.ok) {
          const body = parseBody(await res.text().catch(() => ""));
          if (RETRYABLE_STATUS.has(res.status)) throw new StreamDropped(new Error(`HTTP ${res.status}`));
          const detail = errorMessageFromBody(body, res.statusText || "request failed");
          throw new OverclockError(`Overclock engine GET ${path} failed with HTTP ${res.status}: ${detail}`, { status: res.status, code: "http", body });
        }
        if (!res.body) throw new OverclockError(`Overclock engine GET ${path} returned no body`, { status: res.status, code: "protocol" });

        try {
          for await (const msg of readSseMessages(res.body, armIdle)) {
            if (msg.retry !== undefined) baseDelayMs = msg.retry;
            if (msg.event === "end") return;
            if (msg.event !== "run-event" && msg.event !== "message") continue;
            const event = parseRunEvent(msg.data);
            if (event.seq <= lastSeq) continue; // replayed after a reconnect
            lastSeq = event.seq;
            failures = 0;
            if (event.type === "run.completed") completed = true;
            // Don't count time spent in the consumer as connection idleness.
            clearTimeout(idleTimer);
            yield event;
            armIdle();
          }
        } catch (err) {
          if (signal?.aborted) throw signal.reason;
          if (err instanceof OverclockError) throw err;
          throw new StreamDropped(err);
        }
        throw new StreamDropped(new Error("stream closed before the end event"));
      } catch (err) {
        if (!(err instanceof StreamDropped)) throw err;
        dropCause = err.cause;
      } finally {
        clearTimeout(idleTimer);
        conn.abort();
      }

      // The run finished; only the trailing `end` was lost.
      if (completed) return;
      failures++;
      if (failures > this.maxReconnects) {
        throw new OverclockError(`Lost the event stream for run ${runId} after ${this.maxReconnects} reconnect attempts (${describeFetchError(dropCause)})`, {
          status: 0,
          code: "network",
          cause: dropCause,
        });
      }
      await sleep(Math.min(baseDelayMs * 2 ** (failures - 1), MAX_RECONNECT_DELAY_MS), signal);
    }
  }

  /**
   * Follows the run's stream from its first event until the run finishes, then returns its final
   * status. Aborting `signal` stops following (the run keeps going) and rejects with its reason.
   */
  async waitForCompletion(runId: string, opts: FollowOptions = {}): Promise<RunStatusResponse> {
    for await (const event of this.stream(runId, { signal: opts.signal })) opts.onEvent?.(event);
    return this.http.request("GET", `/api/runs/${encodeURIComponent(runId)}`, { signal: opts.signal });
  }

  cancel(runId: string): Promise<ControlResponse> {
    return this.http.request("POST", `/api/runs/${encodeURIComponent(runId)}/cancel`);
  }

  pause(runId: string): Promise<ControlResponse> {
    return this.http.request("POST", `/api/runs/${encodeURIComponent(runId)}/pause`);
  }

  resume(runId: string): Promise<ControlResponse> {
    return this.http.request("POST", `/api/runs/${encodeURIComponent(runId)}/resume`);
  }

  /** Answers an `approval.requested` event. */
  approve(runId: string, approvalId: string, approved: boolean): Promise<{ ok: boolean }> {
    return this.http.request("POST", `/api/runs/${encodeURIComponent(runId)}/approvals`, { body: { approvalId, approved } });
  }

  /**
   * Final outcomes with evidence. Verification semantics: an outcome is `VERIFIED` only when every
   * state-changing step for that record was read back from the application after a fresh
   * navigation and matched the expected values. `UNCONFIRMED` means a write may or may not have
   * committed and could not be confirmed.
   */
  result(runId: string): Promise<RunResultResponse> {
    return this.http.request("GET", `/api/runs/${encodeURIComponent(runId)}/result`);
  }

  metrics(runId: string): Promise<unknown> {
    return this.http.request("GET", `/api/runs/${encodeURIComponent(runId)}/metrics`);
  }

  /** OTLP/JSON trace export. */
  trace(runId: string): Promise<unknown> {
    return this.http.request("GET", `/api/runs/${encodeURIComponent(runId)}/trace`);
  }

  /** Compiled program; rejects with HTTP 404 before compilation finishes. */
  program(runId: string): Promise<unknown> {
    return this.http.request("GET", `/api/runs/${encodeURIComponent(runId)}/program`);
  }
}
