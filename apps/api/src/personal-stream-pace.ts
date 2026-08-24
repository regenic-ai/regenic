export const CATCH_UP_STREAMS_PER_TICK = 3;

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
