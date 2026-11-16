export class PersonalConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
    /** Sent as `Retry-After` when the caller should back off. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PersonalConnectorError";
  }
}

/** Only for failures known to precede channel acceptance. */
export class WorkDeliveryNotSentError extends PersonalConnectorError {}

export const STORE_BUSY_MESSAGE =
  "Cannot clear local data while the kernel is still syncing";

export function storeBusyError(): PersonalConnectorError {
  return new PersonalConnectorError("disabled", STORE_BUSY_MESSAGE, 409);
}
