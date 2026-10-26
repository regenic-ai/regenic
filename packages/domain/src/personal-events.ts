/** SSE event names on GET /v1/me/events (Personal kernel → desktop). */
export const PERSONAL_SSE_INBOX_DIGEST = "inbox.digest";
export const PERSONAL_SSE_THREAD_UPDATED = "thread.updated";
export const PERSONAL_SSE_WORK_UPDATED = "work.updated";

export type PersonalSseEventType =
  | typeof PERSONAL_SSE_INBOX_DIGEST
  | typeof PERSONAL_SSE_THREAD_UPDATED
  | typeof PERSONAL_SSE_WORK_UPDATED;

export type PersonalSsePayload = {
  [PERSONAL_SSE_INBOX_DIGEST]: { digest: string };
  [PERSONAL_SSE_THREAD_UPDATED]: { thread_id: string };
  [PERSONAL_SSE_WORK_UPDATED]: { work_item_id: string };
};
