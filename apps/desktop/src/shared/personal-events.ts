/**
 * Keep in sync with @regenic/domain personal-events (Personal SSE contract).
 */
export const PERSONAL_SSE_INBOX_DIGEST = "inbox.digest";
export const PERSONAL_SSE_THREAD_UPDATED = "thread.updated";

export type PersonalSseEventType =
  | typeof PERSONAL_SSE_INBOX_DIGEST
  | typeof PERSONAL_SSE_THREAD_UPDATED;
