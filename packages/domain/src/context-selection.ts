export type ContextSelectionReason = "hit" | "reply_target" | "neighbor";

export interface ContextSelectionEvent {
  id: string;
  source: string;
  external_id: string;
  parent_external_id?: string;
}

export interface ContextSelection {
  /** Chronological indexes kept within `maxMessages`. */
  indexes: number[];
  /** Every candidate index, most important first: seeds, then reply chains, then nearest neighbors. */
  ranked: number[];
  reasons: Map<number, ContextSelectionReason>;
  truncated: boolean;
}

/** Choose messages around seed events in a chronologically sorted thread. */
export function selectContextIndexes(
  events: readonly ContextSelectionEvent[],
  seedIds: readonly string[],
  options: { before: number; after: number; replyDepth: number; maxMessages: number },
): ContextSelection {
  const priorities = new Map<number, { priority: number; distance: number; reason: ContextSelectionReason }>();
  const offer = (index: number, priority: number, distance: number, reason: ContextSelectionReason) => {
    const current = priorities.get(index);
    if (!current || priority < current.priority || (priority === current.priority && distance < current.distance)) {
      priorities.set(index, { priority, distance, reason });
    }
  };
  for (const seedId of seedIds) {
    const seedIndex = events.findIndex((event) => event.id === seedId);
    if (seedIndex < 0) continue;
    offer(seedIndex, 0, 0, "hit");
    let replyIndex = seedIndex;
    for (let depth = 0; depth < options.replyDepth; depth += 1) {
      const parentExternalId = events[replyIndex].parent_external_id;
      if (!parentExternalId) break;
      const parent = events.findIndex((event) =>
        event.source === events[replyIndex].source
        && event.external_id === parentExternalId);
      if (parent < 0 || parent === replyIndex) break;
      offer(parent, 1, depth + 1, "reply_target");
      replyIndex = parent;
    }
    for (let index = Math.max(0, seedIndex - options.before); index < seedIndex; index += 1) {
      offer(index, 2, seedIndex - index, "neighbor");
    }
    for (let index = seedIndex + 1; index <= Math.min(events.length - 1, seedIndex + options.after); index += 1) {
      offer(index, 2, index - seedIndex, "neighbor");
    }
  }
  const ranked = [...priorities.entries()].sort((left, right) =>
    left[1].priority - right[1].priority
    || left[1].distance - right[1].distance
    || left[0] - right[0]).map(([index]) => index);
  const indexes = ranked.slice(0, options.maxMessages).sort((left, right) => left - right);
  return {
    indexes,
    ranked,
    reasons: new Map(ranked.map((index) => [index, priorities.get(index)!.reason])),
    truncated: ranked.length > indexes.length,
  };
}
