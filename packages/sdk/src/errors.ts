/**
 * What went wrong, so callers can branch without parsing messages:
 * - `http`: the server answered with a non-2xx status (`status` is that status, `body` its parsed JSON).
 * - `network`: the server could not be reached, or a stream dropped and could not be resumed.
 * - `timeout`: a request did not finish within `timeoutMs`.
 * - `validation`: the input failed client-side validation; `body` holds the zod issues. Nothing was sent.
 * - `protocol`: the server answered with something the SDK cannot interpret.
 */
export type OverclockErrorCode = "http" | "network" | "timeout" | "validation" | "protocol";

export interface OverclockErrorOptions {
  /** HTTP status, or 0 when no HTTP response was involved (network, timeout, validation). */
  status: number;
  code: OverclockErrorCode;
  body?: unknown;
  cause?: unknown;
}

/** Every failure the SDK raises, except aborts, which reject with the signal's `reason`. */
export class OverclockError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly code: OverclockErrorCode;

  constructor(message: string, opts: OverclockErrorOptions) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "OverclockError";
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
  }
}
