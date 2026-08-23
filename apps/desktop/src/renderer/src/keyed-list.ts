/**
 * Keyed list reconcile, same shape as React's reconcileChildrenArray:
 * 1. Walk from the start while keys match (update in place).
 * 2. If one side is exhausted, append or delete the rest.
 * 3. Walk from the end while keys match.
 * 4. Only then build a map of the leftover old items.
 */
export interface KeyedReuse<T> {
  items: T[];
  same: boolean;
  oldLength: number;
  unchangedPrefix: number;
}

export function reuseKeyedList<T>(
  previous: T[],
  next: T[],
  keyOf: (item: T) => string,
  sameProps: (previous: T, next: T) => boolean,
): KeyedReuse<T> {
  if (previous === next) {
    return reuseResult(previous, true, previous.length, previous.length);
  }
  if (next.length === 0) {
    return reuseResult(previous.length === 0 ? previous : next, previous.length === 0, previous.length, 0);
  }
  if (previous.length === 0) {
    return reuseResult(next, false, 0, 0);
  }

  const result = new Array<T>(next.length);
  let unchanged = previous.length === next.length;
  let index = 0;
  let unchangedPrefix = 0;
  const minLen = Math.min(previous.length, next.length);

  while (index < minLen && keyOf(previous[index]) === keyOf(next[index])) {
    const kept = keep(previous[index], next[index], sameProps);
    result[index] = kept;
    if (kept !== previous[index]) {
      unchanged = false;
    } else if (unchangedPrefix === index) {
      unchangedPrefix += 1;
    }
    index += 1;
  }

  if (index === previous.length && index === next.length) {
    return reuseResult(
      unchanged ? previous : result,
      unchanged,
      previous.length,
      unchangedPrefix,
    );
  }

  if (index === previous.length) {
    for (let cursor = index; cursor < next.length; cursor += 1) {
      result[cursor] = next[cursor];
    }
    return reuseResult(result, false, previous.length, unchangedPrefix);
  }

  if (index === next.length) {
    return reuseResult(
      unchangedPrefix === next.length ? previous.slice(0, next.length) : result,
      false,
      previous.length,
      unchangedPrefix,
    );
  }

  let prevEnd = previous.length - 1;
  let nextEnd = next.length - 1;
  while (
    prevEnd >= index &&
    nextEnd >= index &&
    keyOf(previous[prevEnd]) === keyOf(next[nextEnd])
  ) {
    const kept = keep(previous[prevEnd], next[nextEnd], sameProps);
    result[nextEnd] = kept;
    if (kept !== previous[prevEnd]) {
      unchanged = false;
    }
    prevEnd -= 1;
    nextEnd -= 1;
  }

  const leftover = new Map<string, T>();
  for (let cursor = index; cursor <= prevEnd; cursor += 1) {
    leftover.set(keyOf(previous[cursor]), previous[cursor]);
  }
  for (let cursor = index; cursor <= nextEnd; cursor += 1) {
    const incoming = next[cursor];
    const key = keyOf(incoming);
    const old = leftover.get(key);
    if (old) {
      leftover.delete(key);
      const kept = keep(old, incoming, sameProps);
      result[cursor] = kept;
      if (kept !== old) {
        unchanged = false;
      }
    } else {
      result[cursor] = incoming;
      unchanged = false;
    }
  }

  return reuseResult(result, false, previous.length, unchangedPrefix);
}

function keep<T>(
  previous: T,
  next: T,
  sameProps: (previous: T, next: T) => boolean,
): T {
  return sameProps(previous, next) ? previous : next;
}

function reuseResult<T>(
  items: T[],
  same: boolean,
  oldLength: number,
  unchangedPrefix: number,
): KeyedReuse<T> {
  return { items, same, oldLength, unchangedPrefix };
}
