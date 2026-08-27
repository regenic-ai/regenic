import { AuthorityConflictError } from "@regenic/domain";

export const AUTHORITY_WRITE_METHODS = [
  "append",
  "appendRevision",
  "markTombstone",
  "commitIngest",
  "repointContentHash",
  "vacuumStore",
  "putDisposition",
  "putConversationPref",
  "clearOperationalData",
  "putRecipe",
  "deleteRecipe",
  "putWorkItem",
  "putWorkRun",
  "putWorkDelivery",
  "putUiPref",
  "putExecutorInstallation",
  "deleteExecutorInstallation",
  "createInstallation",
  "setInstallationStatus",
  "updateInstallationConfig",
  "deleteInstallation",
  "acquireLease",
  "releaseLease",
  "resetCursor",
  "beginAttempt",
  "settleAttempt",
] as const;

export type AuthorityWriteMethod = (typeof AUTHORITY_WRITE_METHODS)[number];

export const AUTHORITY_WRITE_METHOD_SET = new Set<string>(AUTHORITY_WRITE_METHODS);

export interface SqliteWriteRequest {
  id: number;
  method: string;
  args: unknown[];
}

export interface SqliteWriteResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: SerializedStoreError;
}

export interface SerializedStoreError {
  name: string;
  message: string;
  stack?: string;
}

export function serializeStoreError(error: unknown): SerializedStoreError {
  if (error instanceof AuthorityConflictError) {
    return { name: "AuthorityConflictError", message: error.message };
  }
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { name: "Error", message: String(error) };
}

export function reviveStoreError(error: SerializedStoreError): Error {
  if (error.name === "AuthorityConflictError") {
    return new AuthorityConflictError();
  }
  const revived = new Error(error.message);
  revived.name = error.name;
  if (error.stack) {
    revived.stack = error.stack;
  }
  return revived;
}

export function isAuthorityWriteMethod(
  method: string,
): method is AuthorityWriteMethod {
  return AUTHORITY_WRITE_METHOD_SET.has(method);
}
