import type { InboxItem } from "./arrangement";
import type {
  EventListQuery,
  EventRecord,
  InboxQuery,
  InboxSummary,
} from "./ingestion";
import { conversationId } from "./message-contract";

export function eventThreadId(event: EventRecord): string {
  return conversationId(event.source, event.external_id, event.id);
}

export function matchesEventQuery(
  event: EventRecord,
  orgId: string,
  query?: EventListQuery,
): boolean {
  if (event.org_id !== orgId) {
    return false;
  }
  if (query?.source && event.source !== query.source) {
    return false;
  }
  if (
    query?.target &&
    event.external_id !== query.target &&
    !event.external_id.startsWith(`${query.target}:`)
  ) {
    return false;
  }
  if (query?.thread_ids) {
    if (
      query.thread_ids.length === 0 ||
      !query.thread_ids.includes(eventThreadId(event))
    ) {
      return false;
    }
  }
  if (query?.since) {
    const at = event.ingested_at;
    if (at < query.since) {
      return false;
    }
    if (at === query.since && event.id <= (query.since_id ?? "")) {
      return false;
    }
  }
  return true;
}

export function latestByThread<T extends { event: EventRecord }>(items: T[]): T[] {
  const best = new Map<string, T>();
  for (const item of items) {
    const id = eventThreadId(item.event);
    const current = best.get(id);
    if (!current || isNewerEvent(item.event, current.event)) {
      best.set(id, item);
    }
  }
  return [...best.values()];
}

export function isThreadStatusItem(item: unknown): boolean {
  if (!item || typeof item !== "object") {
    return false;
  }
  const record = item as {
    activity?: string;
    decision?: { reason_codes?: string[] };
  };
  if (record.activity === "working") {
    return true;
  }
  return record.decision?.reason_codes?.includes("thread_status") === true;
}

/**
 * List heads are the last visible message. Status markers stay off the list
 * payload; the desktop titles the row from this face only.
 */
export function headsByThread<T extends { event: EventRecord }>(
  items: T[],
  isStatus: (item: T) => boolean = (item) => isThreadStatusItem(item),
): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = eventThreadId(item.event);
    const bucket = groups.get(id);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(id, [item]);
    }
  }
  const heads: T[] = [];
  for (const bucket of groups.values()) {
    let face: T | undefined;
    for (const item of bucket) {
      if (
        !isStatus(item) &&
        item.event.operation !== "tombstone" &&
        (!face || isNewerEvent(item.event, face.event))
      ) {
        face = item;
      }
    }
    if (!face) {
      continue;
    }
    heads.push(face);
  }
  return heads;
}

function isNewerEvent(left: EventRecord, right: EventRecord): boolean {
  return (
    left.occurred_at > right.occurred_at ||
    (left.occurred_at === right.occurred_at && left.id > right.id)
  );
}

export function escapeLikeLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export function threadExternalIdLike(target: string): string {
  return `${escapeLikeLiteral(target)}:%`;
}

export function formatInboxDigest(input: {
  count: number;
  latest_at?: string;
  latest_id?: string;
  pref_count?: number;
  pref_updated_at?: string;
}): string {
  return `${input.count}:${input.latest_at ?? ""}:${input.latest_id ?? ""}:${
    input.pref_count ?? 0
  }:${input.pref_updated_at ?? ""}`;
}

export function inboxDigest(
  items: Array<{
    event: { id: string; ingested_at: string; source?: string; external_id?: string };
  }>,
  prefs: Array<{ updated_at: string }> = [],
): string {
  const threads = new Set<string>();
  let latestAt = "";
  let latestId = "";
  for (const item of items) {
    threads.add(threadKey(item.event));
    const at = item.event.ingested_at;
    if (at > latestAt || (at === latestAt && item.event.id > latestId)) {
      latestAt = at;
      latestId = item.event.id;
    }
  }
  let prefUpdatedAt = "";
  for (const pref of prefs) {
    if (pref.updated_at > prefUpdatedAt) {
      prefUpdatedAt = pref.updated_at;
    }
  }
  return formatInboxDigest({
    count: threads.size,
    latest_at: latestAt,
    latest_id: latestId,
    pref_count: prefs.length,
    pref_updated_at: prefUpdatedAt,
  });
}

export function summarizeInboxItems(
  items: InboxItem[],
  prefs: Array<{ updated_at: string }> = [],
): InboxSummary {
  const withFace = new Set(
    items
      .filter(
        (item) =>
          !isThreadStatusItem(item) && item.event.operation !== "tombstone",
      )
      .map((item) => eventThreadId(item.event)),
  );
  const listable = items.filter((item) =>
    withFace.has(eventThreadId(item.event)),
  );
  return {
    count: withFace.size,
    digest: inboxDigest(listable, prefs),
  };
}

function threadKey(event: {
  id: string;
  source?: string;
  external_id?: string;
}): string {
  if (event.source && event.external_id) {
    return conversationId(event.source, event.external_id, event.id);
  }
  return event.id;
}

export function selectInboxItems(
  items: InboxItem[],
  query?: InboxQuery,
): InboxItem[] {
  let selected = items;
  if (query && hasEventFilter(query)) {
    selected = selected.filter((item) =>
      matchesEventQuery(item.event, item.event.org_id, query),
    );
  }
  if (query?.heads) {
    const currentThreads = new Set(
      selected
        .filter((item) => item.decision.disposition === "current_work")
        .map((item) => eventThreadId(item.event)),
    );
    selected = headsByThread(
      selected.filter((item) => currentThreads.has(eventThreadId(item.event))),
    );
  }
  return selected;
}

function hasEventFilter(query: EventListQuery): boolean {
  return Boolean(
    query.source ||
      query.target ||
      query.since ||
      (query.thread_ids && query.thread_ids.length > 0),
  );
}
