export const CATCH_UP_STREAMS_PER_TICK = 3;
export const HUMAN_LIVE_STREAMS_BUSY = 2;
export const HUMAN_LIVE_STREAMS_IDLE = 1;
export const HUMAN_HISTORY_STREAMS_IDLE = 1;
export const SEED_UNSEEN_PER_TICK = 16;

export function humanPaceLimits(idle: boolean): {
  liveLimit: number;
  historyLimit: number;
} {
  return idle
    ? {
        liveLimit: HUMAN_LIVE_STREAMS_IDLE,
        historyLimit: HUMAN_HISTORY_STREAMS_IDLE,
      }
    : {
        liveLimit: HUMAN_LIVE_STREAMS_BUSY,
        historyLimit: 0,
      };
}

export interface PlannedStream<T = unknown> {
  key: string;
  catchingUp: boolean;
  threadId?: string;
  item: T;
}

export function selectStreamsForTick<T>(
  items: Array<PlannedStream<T>>,
  options: {
    limit?: number;
    rotateFrom?: string;
    preferredThreadId?: string | null;
  } = {},
): Array<PlannedStream<T>> {
  const limit = options.limit ?? CATCH_UP_STREAMS_PER_TICK;
  const preferredIndex = options.preferredThreadId
    ? items.findIndex((item) => item.threadId === options.preferredThreadId)
    : -1;
  const preferred = preferredIndex >= 0 ? items[preferredIndex] : undefined;
  const rest = items.filter((_, index) => index !== preferredIndex);
  const catchingUp = rest.filter((item) => item.catchingUp);
  const live = rest.filter((item) => !item.catchingUp);
  const rotated = rotateFromKey(catchingUp, options.rotateFrom);
  const remaining = preferred ? Math.max(0, limit - 1) : limit;
  return [
    ...(preferred ? [preferred] : []),
    ...rotated.slice(0, remaining),
    ...live,
  ];
}

export function rotateFromKey<T extends { key: string }>(
  items: T[],
  from?: string,
): T[] {
  if (!from || items.length === 0) {
    return items;
  }
  const index = items.findIndex((item) => item.key === from);
  if (index < 0) {
    return items;
  }
  const start = (index + 1) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

export function lastCatchUpKey(
  selected: Array<{ key: string; catchingUp: boolean }>,
): string | undefined {
  return [...selected].reverse().find((item) => item.catchingUp)?.key;
}

export interface PacedStream<T = unknown> {
  key: string;
  catchingUp: boolean;
  older: boolean;
  item: T;
}

/**
 * Live watermarks stay first. History is scroll-up first; idle ticks may
 * backfill other threads, never the conversation the human has open.
 */
export function selectHumanPacedStreams<T>(
  items: Array<PlannedStream<T>>,
  options: {
    liveLimit: number;
    historyLimit: number;
    rotateFrom?: string;
    preferredThreadId?: string | null;
  },
): Array<PacedStream<T>> {
  const preferredId = options.preferredThreadId ?? null;
  const preferredIndex = preferredId
    ? items.findIndex((item) => item.threadId === preferredId)
    : -1;
  const preferred = preferredIndex >= 0 ? items[preferredIndex] : undefined;
  const rest = items.filter((_, index) => index !== preferredIndex);
  const restRanked = [
    ...rest.filter((item) => item.catchingUp),
    ...rest.filter((item) => !item.catchingUp),
  ];
  const livePool = preferred ? [preferred, ...restRanked] : restRanked;
  const live = livePool.slice(0, Math.max(0, options.liveLimit)).map((stream) => ({
    key: stream.key,
    catchingUp: stream.catchingUp,
    older: false,
    item: stream.item,
  }));
  const liveKeys = new Set(live.map((stream) => stream.key));
  const history = rotateFromKey(
    items.filter(
      (item) =>
        item.catchingUp &&
        !liveKeys.has(item.key) &&
        item.threadId !== preferredId,
    ),
    options.rotateFrom,
  )
    .slice(0, Math.max(0, options.historyLimit))
    .map((stream) => ({
      key: stream.key,
      catchingUp: true,
      older: true,
      item: stream.item,
    }));
  return [...live, ...history];
}

export function lastHistoryKey(
  selected: Array<{ key: string; older: boolean }>,
): string | undefined {
  return [...selected].reverse().find((item) => item.older)?.key;
}

export function streamCursorUnseeded(value?: string | null): boolean {
  if (!value?.trim()) {
    return true;
  }
  try {
    const parsed = JSON.parse(value) as { recent_seeded?: unknown };
    if (parsed && typeof parsed === "object" && "recent_seeded" in parsed) {
      return parsed.recent_seeded !== true;
    }
  } catch {
    // A non-JSON cursor still means this stream has been polled.
  }
  return false;
}

export function prependUnseenStreams<T extends { key: string }>(
  unseen: T[],
  selected: T[],
  limit = SEED_UNSEEN_PER_TICK,
): T[] {
  const seeds = unseen.slice(0, Math.max(0, limit));
  const keys = new Set(seeds.map((item) => item.key));
  return [...seeds, ...selected.filter((item) => !keys.has(item.key))];
}

export function shouldKeepCatchingUp(input: {
  pages: Array<{ status: string; has_more?: boolean }>;
  pagesBudget: number;
  acceptedCount: number;
  quarantinedCount: number;
  error?: unknown;
}): boolean {
  if (input.pages.length === 0) {
    return Boolean(input.error);
  }
  if (
    input.error ||
    input.pages.some((page) => page.status === "retryable_failure")
  ) {
    return true;
  }
  if (input.pages.some((page) => page.has_more === true)) {
    return true;
  }
  const progressed = input.acceptedCount > 0 || input.quarantinedCount > 0;
  return progressed && input.pages.length >= input.pagesBudget;
}
