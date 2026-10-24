/** Typed runtime failures. The recovery engine dispatches on these classes. */

export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly nodeId?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class LocatorNotFoundError extends RuntimeError {
  constructor(
    message: string,
    nodeId: string | undefined,
    readonly controlId?: string,
  ) {
    super(message, nodeId);
  }
}

export class AmbiguousLocatorError extends RuntimeError {
  constructor(
    message: string,
    nodeId: string | undefined,
    readonly matches: number,
  ) {
    super(message, nodeId);
  }
}

/** A page load failed with a status that is safe to retry (reads) or back off on (429/503). */
export class NavigationError extends RuntimeError {
  constructor(
    message: string,
    nodeId: string | undefined,
    readonly status: number | null,
    readonly url: string,
  ) {
    super(message, nodeId);
  }
  get throttled(): boolean {
    return this.status === 429;
  }
}

/**
 * A state-changing request returned an error or no response. The write may or may not have
 * committed, so it must be reconciled by reading back state, never blindly retried.
 */
export class WriteUncertainError extends RuntimeError {
  constructor(
    message: string,
    nodeId: string | undefined,
    readonly status: number | null,
  ) {
    super(message, nodeId);
  }
}

/** The write was rejected before reaching the server-side commit point (e.g. 429, 503 before commit is unknowable, so only 429/400 qualify). */
export class WriteRejectedError extends RuntimeError {
  constructor(
    message: string,
    nodeId: string | undefined,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message, nodeId);
  }
}

export class PreconditionFailedError extends RuntimeError {
  constructor(
    message: string,
    nodeId: string | undefined,
    readonly stale: { name: string; expected: unknown; actual: unknown }[] = [],
  ) {
    super(message, nodeId);
  }
}

export class AssertionFailedError extends RuntimeError {}

export class OriginBlockedError extends RuntimeError {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
  }
}

export class UnexpectedDialogError extends RuntimeError {
  constructor(
    message: string,
    nodeId: string | undefined,
    readonly dialogText: string,
  ) {
    super(message, nodeId);
  }
}

export class CancelledError extends RuntimeError {}

export class ApprovalRequiredError extends RuntimeError {}
