export type PersonalContextErrorCode =
  | "invalid_request"
  | "not_found"
  | "context_changed"
  | "replay_forbidden"
  | "no_context"
  | "model_unavailable"
  | "model_timeout"
  | "model_upstream"
  | "retrieval_unavailable"
  | "invalid_model_output"
  | "executor_unavailable"
  | "executor_session_unavailable"
  | "busy";

export class PersonalContextError extends Error {
  constructor(
    readonly code: PersonalContextErrorCode,
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "PersonalContextError";
  }
}
