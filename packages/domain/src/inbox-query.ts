import type { InboxItem } from "./arrangement";
import type {
  EventListQuery,
  EventRecord,
  InboxQuery,
  InboxSummary,
} from "./ingestion";
import { normalizeInboxListView } from "./list-surface";
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
  if (query?.before && !isBeforeEvent(event, query.before, query.before_id ?? "")) {
    return false;
  }
  return true;
}

export const INBOX_PAGE_MAX = 200;

export function normalizeInboxLimit(value: unknown): number | undefined {
  const limit =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(limit) || limit < 1) {
    return undefined;
  }
  return Math.min(limit, INBOX_PAGE_MAX);
}

export function isBeforeEvent(
  event: { occurred_at: string; id: string },
  before: string,
  beforeId = "",
): boolean {
  if (event.occurred_at < before) {
    return true;
  }
  return event.occurred_at === before && event.id < beforeId;
}

export function takeRecentInboxItems<T extends { event: EventRecord }>(
  items: T[],
  query?: Pick<InboxQuery, "before" | "before_id" | "limit">,
): T[] {
  let selected = items;
  if (query?.before) {
    selected = selected.filter((item) =>
      isBeforeEvent(item.event, query.before as string, query.before_id ?? ""),
    );
  }
  const limit = normalizeInboxLimit(query?.limit);
  if (limit === undefined || selected.length <= limit) {
    return selected;
  }
  const ranked = selected
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const byTime = compareOccurredAt(left.item.event, right.item.event);
      if (byTime !== 0) {
        return byTime;
      }
      return left.index - right.index;
    });
  return ranked.slice(ranked.length - limit).map((row) => row.item);
}

/** Drop page cursors so heads can rank the face, then page that face. */
export function headsScanQuery(query?: InboxQuery): InboxQuery | undefined {
  if (!query?.heads) {
    return query;
  }
  return {
    ...query,
    before: undefined,
    before_id: undefined,
    since: undefined,
    since_id: undefined,
    limit: undefined,
  };
}

function compareOccurredAt(
  left: { occurred_at: string; id: string },
  right: { occurred_at: string; id: string },
): number {
  if (left.occurred_at !== right.occurred_at) {
    return left.occurred_at < right.occurred_at ? -1 : 1;
  }
  return left.id < right.id ? -1 : 1;
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

export type InboxDigestParts = {
  count: number;
  latest_at: string;
  latest_id: string;
  pref_count: number;
  pref_updated_at: string;
  work_updated_at: string;
  surface_generation: string;
};

export function parseInboxDigest(value: string): InboxDigestParts | null {
  const parsed = parseInboxDigestBase(value);
  if (!parsed) {
    return null;
  }
  let work = "";
  let surface = "";
  for (const flag of parsed.flags) {
    if (flag.startsWith("w=")) {
      work = flag.slice(2);
    } else if (flag.startsWith("s=")) {
      surface = flag.slice(2);
    }
  }
  return {
    count: parsed.count,
    latest_at: parsed.latest_at,
    latest_id: parsed.latest_id,
    pref_count: parsed.pref_count,
    pref_updated_at: parsed.pref_updated_at,
    work_updated_at: work,
    surface_generation: surface,
  };
}

function parseInboxDigestBase(value: string): {
  count: number;
  latest_at: string;
  latest_id: string;
  pref_count: number;
  pref_updated_at: string;
  flags: string[];
} | null {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return null;
  }
  const flags = trimmed.split("&");
  const pref = peelInboxDigestTail(flags[0] ?? "");
  const prefCountSep = pref.head.lastIndexOf(":");
  if (prefCountSep < 0) {
    return null;
  }
  const prefCount = Number(pref.head.slice(prefCountSep + 1));
  const left = pref.head.slice(0, prefCountSep);
  const countSep = left.indexOf(":");
  if (countSep < 0) {
    return null;
  }
  const count = Number(left.slice(0, countSep));
  const middle = left.slice(countSep + 1);
  const idSep = middle.lastIndexOf(":");
  if (idSep < 0) {
    return null;
  }
  if (!Number.isInteger(count) || count < 0) {
    return null;
  }
  if (!Number.isInteger(prefCount) || prefCount < 0) {
    return null;
  }
  return {
    count,
    latest_at: middle.slice(0, idSep),
    latest_id: middle.slice(idSep + 1),
    pref_count: prefCount,
    pref_updated_at: pref.tail,
    flags: flags.slice(1),
  };
}

function peelInboxDigestTail(base: string): { head: string; tail: string } {
  if (base.endsWith(":")) {
    return { head: base.slice(0, -1), tail: "" };
  }
  const iso = base.match(
    /^(.*):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/,
  );
  if (iso) {
    return { head: iso[1] ?? "", tail: iso[2] ?? "" };
  }
  const last = base.lastIndexOf(":");
  if (last < 0) {
    return { head: "", tail: base };
  }
  return { head: base.slice(0, last), tail: base.slice(last + 1) };
}

export function inboxDigestEventOrPrefChanged(
  previous: InboxDigestParts,
  next: InboxDigestParts,
): boolean {
  return (
    previous.count !== next.count ||
    previous.latest_at !== next.latest_at ||
    previous.latest_id !== next.latest_id ||
    previous.pref_count !== next.pref_count ||
    previous.pref_updated_at !== next.pref_updated_at
  );
}

export function formatInboxDigest(input: {
  count: number;
  latest_at?: string;
  latest_id?: string;
  pref_count?: number;
  pref_updated_at?: string;
  work_updated_at?: string;
  surface_generation?: string;
}): string {
  const base = `${input.count}:${input.latest_at ?? ""}:${input.latest_id ?? ""}:${
    input.pref_count ?? 0
  }:${input.pref_updated_at ?? ""}`;
  const work = input.work_updated_at?.replace(/\s+/g, " ").trim() ?? "";
  const withWork = work ? `${base}&w=${work}` : base;
  const surface = input.surface_generation?.replace(/\s+/g, " ").trim() ?? "";
  return surface ? `${withWork}&s=${surface}` : withWork;
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
    if (normalizeInboxListView(query.list) === "hidden") {
      selected = headsByThread(selected);
    } else {
      const openThreads = new Set(
        selected
          .filter((item) => item.decision.disposition === "current_work")
          .map((item) => eventThreadId(item.event)),
      );
      selected = headsByThread(
        selected.filter((item) => openThreads.has(eventThreadId(item.event))),
      );
    }
  }
  return takeRecentInboxItems(selected, query);
}

function hasEventFilter(query: EventListQuery): boolean {
  return Boolean(
    query.source ||
      query.target ||
      query.since ||
      query.before ||
      (query.thread_ids && query.thread_ids.length > 0),
  );
}
