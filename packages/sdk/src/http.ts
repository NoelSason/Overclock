import { OverclockError } from "./errors";

/** Shared JSON-over-HTTP plumbing for the engine and arena clients. */

export type FetchLike = typeof fetch;

export type Query = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  body?: unknown;
  query?: Query;
  signal?: AbortSignal | undefined;
  /** Overrides the client default; 0 disables the timeout. */
  timeoutMs?: number;
}

export interface HttpClientOptions {
  /** Human name used in error messages, e.g. "Overclock engine". */
  service: string;
  endpoint: string;
  fetch: FetchLike | undefined;
  timeoutMs: number;
}

/** Reads an env var without assuming a Node runtime. */
export function envVar(name: string): string | undefined {
  const value = globalThis.process?.env?.[name];
  return value === "" ? undefined : value;
}

/** Parses a response body: JSON when it parses, the raw text otherwise, undefined when empty. */
export function parseBody(text: string): unknown {
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The server's `{ error }` message, or a short excerpt of a non-JSON body. */
export function errorMessageFromBody(body: unknown, fallback: string): string {
  if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "string") return body.error;
  if (typeof body === "string" && body.trim() !== "") return body.trim().slice(0, 200);
  return fallback;
}

/** Best-effort description of a fetch failure (undici hides the useful part in `cause`). */
export function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause;
    if (typeof cause === "object" && cause !== null) {
      if ("code" in cause && typeof cause.code === "string") return cause.code;
      if ("message" in cause && typeof cause.message === "string") return cause.message;
    }
    return err.message;
  }
  return String(err);
}

export function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length <= 1) return present[0];
  return AbortSignal.any(present);
}

/** Resolves after `ms`, or rejects with the signal's reason if it aborts first. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class HttpClient {
  readonly endpoint: string;
  readonly service: string;
  readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: HttpClientOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.service = opts.service;
    this.timeoutMs = opts.timeoutMs;
    // Wrap so a browser fetch is never invoked with the wrong `this`.
    const impl = opts.fetch ?? globalThis.fetch;
    this.fetch = (input, init) => impl(input, init);
  }

  url(path: string, query?: Query): string {
    const url = new URL(this.endpoint + path);
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
  }

  /**
   * Sends a JSON request and returns the parsed JSON body. Non-GET requests always carry a JSON
   * body (`{}` when none is given) because the servers reject an empty body with a JSON content type.
   */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    opts.signal?.throwIfAborted();
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const hasBody = method !== "GET" && method !== "HEAD";
    const init: RequestInit = {
      method,
      headers: hasBody ? { accept: "application/json", "content-type": "application/json" } : { accept: "application/json" },
      body: hasBody ? JSON.stringify(opts.body ?? {}) : undefined,
      signal: combineSignals(opts.signal, timeout) ?? null,
    };

    let res: Response;
    let text: string;
    try {
      res = await this.fetch(this.url(path, opts.query), init);
      text = await res.text();
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      if (timeout?.aborted) {
        throw new OverclockError(`${this.service} ${method} ${path} timed out after ${timeoutMs}ms`, { status: 0, code: "timeout", cause: err });
      }
      throw new OverclockError(`Cannot reach ${this.service} at ${this.endpoint} (${describeFetchError(err)})`, { status: 0, code: "network", cause: err });
    }

    const body = parseBody(text);
    if (!res.ok) {
      const detail = errorMessageFromBody(body, res.statusText || "request failed");
      throw new OverclockError(`${this.service} ${method} ${path} failed with HTTP ${res.status}: ${detail}`, { status: res.status, code: "http", body });
    }
    // Responses are not schema-checked at runtime: the engine and arena are typed against the same
    // contracts package, so the cast documents that shared contract rather than hiding a guess.
    return body as T;
  }
}
