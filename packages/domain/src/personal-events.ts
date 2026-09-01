/** SSE event names on GET /v1/me/events (Personal kernel → desktop). */
export const PERSONAL_SSE_INBOX_DIGEST = "inbox.digest";
export const PERSONAL_SSE_THREAD_UPDATED = "thread.updated";

export type PersonalSseEventType =
  | typeof PERSONAL_SSE_INBOX_DIGEST
  | typeof PERSONAL_SSE_THREAD_UPDATED;

export type PersonalSsePayload = {
  [PERSONAL_SSE_INBOX_DIGEST]: { digest: string };
  [PERSONAL_SSE_THREAD_UPDATED]: { thread_id: string };
};
