/** Errors thrown by the Overclock Network client. Callers can branch on `instanceof`. */

export class NetworkError extends Error {
  override readonly name: string = "NetworkError";
}

/** The network could not be reached (connect timeout, connection lost, call not delivered). */
export class NetworkUnavailableError extends NetworkError {
  override readonly name = "NetworkUnavailableError";
}

/** The client is disabled by configuration (OVERCLOCK_NETWORK_ENABLED / publish flags). */
export class NetworkDisabledError extends NetworkError {
  override readonly name = "NetworkDisabledError";
}

/** The module rejected the call (authorization, validation, state machine, lease checks). */
export class NetworkRejectedError extends NetworkError {
  override readonly name = "NetworkRejectedError";
  constructor(
    readonly operation: string,
    readonly reason: string,
  ) {
    super(`${operation} rejected: ${reason}`);
  }
}

/** A fetched or cached artifact failed hash, size, or schema verification. */
export class CapabilityIntegrityError extends NetworkError {
  override readonly name = "CapabilityIntegrityError";
}

/** A capability is larger than MAX_CAPABILITY_BYTES once serialized. */
export class CapabilityTooLargeError extends NetworkError {
  override readonly name = "CapabilityTooLargeError";
}

/** The requested capability version does not exist on the network. */
export class CapabilityNotFoundError extends NetworkError {
  override readonly name = "CapabilityNotFoundError";
}
