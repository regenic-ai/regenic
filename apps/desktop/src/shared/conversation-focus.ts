/** Pure helpers for POST /v1/me/conversations/focus payloads (desktop client). */
export type ThreadFocusRequest = {
  thread_id: string;
  hydrate?: boolean;
  live?: boolean;
  pull_older?: boolean;
  before?: string;
  before_id?: string;
  present?: boolean;
};

export function openThreadFocusRequest(
  threadId: string,
  coldOpen: boolean,
): ThreadFocusRequest {
  return {
    thread_id: threadId,
    hydrate: coldOpen,
    present: true,
  };
}

export function liveReceiptFocusRequest(threadId: string): ThreadFocusRequest {
  return {
    thread_id: threadId,
    live: true,
    present: true,
  };
}

export function pullOlderFocusRequest(
  threadId: string,
  before: string,
  beforeId?: string,
): ThreadFocusRequest {
  return {
    thread_id: threadId,
    pull_older: true,
    before,
    ...(beforeId ? { before_id: beforeId } : {}),
    present: true,
  };
}
