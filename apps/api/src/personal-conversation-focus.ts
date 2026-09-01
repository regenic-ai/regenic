/** Body for POST /v1/me/conversations/focus — schedules connector work off the read path. */
export type ConversationFocusInput = {
  thread_id?: string;
  /** Cold open: ask the connector to hydrate when the driver supports it. */
  hydrate?: boolean;
  /** Interactive focus for live receipt/read_status overlays. */
  live?: boolean;
  /** Scroll-up: ask the connector for an older history page. */
  pull_older?: boolean;
  before?: string;
  before_id?: string;
  /** Drain queued attachment downloads for this thread. */
  media?: boolean;
  /** Marks human presence for connector pacing (default true). */
  present?: boolean;
};

export function conversationFocusThreadId(
  body: ConversationFocusInput,
): string | undefined {
  const id = body.thread_id?.trim();
  return id ? id : undefined;
}

export function shouldMarkHumanPresent(body: ConversationFocusInput): boolean {
  return body.present !== false;
}

export function shouldPullOlderFocus(body: ConversationFocusInput): boolean {
  return Boolean(
    body.pull_older && conversationFocusThreadId(body) && body.before?.trim(),
  );
}

export function shouldDrainMediaFocus(body: ConversationFocusInput): boolean {
  return Boolean(body.media && conversationFocusThreadId(body));
}
