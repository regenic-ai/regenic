export class PersonalConnectorError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "PersonalConnectorError";
  }
}

export const STORE_BUSY_MESSAGE =
  "Cannot clear local data while the kernel is still syncing";

export function storeBusyError(): PersonalConnectorError {
  return new PersonalConnectorError("disabled", STORE_BUSY_MESSAGE, 409);
}
