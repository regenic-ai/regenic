export type PersonalEventHandlers = {
  onInboxDigest?: (digest: string) => void;
  onThreadUpdated?: (threadId: string) => void;
  onConnected?: () => void;
  onDisconnected?: () => void;
};

export type PersonalEventsDeps = {
  origin: () => string;
  subscribeOrigin: (listener: () => void) => () => void;
  EventSource: typeof EventSource;
  setTimeout: (handler: () => void, ms: number) => number;
  clearTimeout: (timer: number) => void;
};

export function personalEventsUrl(origin: string): string {
  return `${origin}/v1/me/events`;
}

export function connectPersonalEventsWithDeps(
  handlers: PersonalEventHandlers,
  deps: PersonalEventsDeps,
): () => void {
  let source: EventSource | null = null;
  let retryTimer = 0;
  let retryMs = 1_000;
  let closed = false;

  const connect = () => {
    if (closed) {
      return;
    }
    source?.close();
    source = new deps.EventSource(personalEventsUrl(deps.origin()));
    source.addEventListener("inbox.digest", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          digest?: string;
        };
        if (payload.digest) {
          handlers.onInboxDigest?.(payload.digest);
        }
      } catch {
        // Ignore malformed push payloads.
      }
    });
    source.addEventListener("thread.updated", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as {
          thread_id?: string;
        };
        if (payload.thread_id) {
          handlers.onThreadUpdated?.(payload.thread_id);
        }
      } catch {
        // Ignore malformed push payloads.
      }
    });
    source.onopen = () => {
      retryMs = 1_000;
      handlers.onConnected?.();
    };
    source.onerror = () => {
      handlers.onDisconnected?.();
      source?.close();
      source = null;
      if (!closed) {
        retryTimer = deps.setTimeout(connect, retryMs);
        retryMs = Math.min(retryMs * 2, 30_000);
      }
    };
  };

  connect();
  const unsubOrigin = deps.subscribeOrigin(() => {
    deps.clearTimeout(retryTimer);
    retryMs = 1_000;
    connect();
  });
  return () => {
    closed = true;
    unsubOrigin();
    deps.clearTimeout(retryTimer);
    source?.close();
    source = null;
  };
}
