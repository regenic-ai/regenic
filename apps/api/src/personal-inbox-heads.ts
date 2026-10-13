import {
  conversationId,
  isBeforeEvent,
  normalizeInboxLimit,
  normalizeInboxListView,
  type CopyLocale,
} from "@regenic/domain";
import type { InboxAttachment } from "./inbox-body";
import type { InboxViewItem } from "./personal-inbox-view";

export interface InboxListQuery {
  since?: string;
  since_id?: string;
  before?: string;
  before_id?: string;
  heads?: boolean;
  live?: boolean;
  split?: boolean;
  changed?: boolean;
  since_digest?: string;
  thread_id?: string;
  thread_ids?: string[];
  limit?: number;
  list?: string;
  locale?: CopyLocale;
}

export type InboxHeadsCursor = { before: string; before_id: string };

export interface InboxHeadsPage {
  pinned: InboxViewItem[];
  live: InboxViewItem[];
  active_work?: InboxViewItem[];
  next_before: InboxHeadsCursor | null;
  has_older: boolean;
  patch?: boolean;
  gone?: string[];
}

export const CHANGED_INBOX_EVENT_CAP = 200;
export const CHANGED_INBOX_THREAD_CAP = 80;

export function shouldSplitInboxHeads(query: InboxListQuery): boolean {
  return query.heads === true && query.split === true && !query.thread_id;
}

export function shouldLoadChangedInboxHeads(query: InboxListQuery): boolean {
  return (
    query.heads === true &&
    query.split === true &&
    query.changed === true &&
    Boolean(query.since_digest?.trim()) &&
    !query.thread_id &&
    !query.before
  );
}

export function parseSinceInboxDigest(value: string): {
  count: number;
  latest_at: string;
  latest_id: string;
  pref_updated_at: string;
} | null {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return null;
  }
  const pref = peelInboxDigestTail(trimmed.split("&")[0] ?? "");
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
  const latestAt = middle.slice(0, idSep);
  if (!latestAt) {
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
    latest_at: latestAt,
    latest_id: middle.slice(idSep + 1),
    pref_updated_at: pref.tail,
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

export function shouldFallbackChangedInboxHeads(collected: {
  ids: readonly string[];
  tooMany: boolean;
  countChanged?: boolean;
}): boolean {
  return (
    collected.tooMany ||
    (collected.ids.length === 0 && collected.countChanged === true)
  );
}

export function collectChangedInboxThreadIds(input: {
  events: Array<{ source: string; external_id: string; id: string }>;
  prefs: Array<{ thread_id: string; updated_at: string }>;
  prefSince: string;
}): { ids: string[]; tooMany: boolean } {
  if (input.events.length >= CHANGED_INBOX_EVENT_CAP) {
    return { ids: [], tooMany: true };
  }
  const ids = new Set<string>();
  for (const event of input.events) {
    ids.add(conversationId(event.source, event.external_id, event.id));
  }
  for (const pref of input.prefs) {
    if (!input.prefSince || pref.updated_at > input.prefSince) {
      ids.add(pref.thread_id);
    }
  }
  const list = [...ids];
  return { ids: list, tooMany: list.length > CHANGED_INBOX_THREAD_CAP };
}

export function splitChangedInboxHeads<
  T extends { thread_id?: string; pinned?: boolean; hidden?: boolean },
>(input: {
  views: T[];
  collectedIds: readonly string[];
  prefs: Array<{ thread_id: string; hidden?: boolean }>;
  workIds: readonly string[];
  list?: string;
}): {
  pinned: T[];
  live: T[];
  active_work: T[];
  gone: string[];
} {
  const hiddenList = normalizeInboxListView(input.list) === "hidden";
  const work = new Set(input.workIds);
  const loaded = new Set<string>();
  const kept: T[] = [];
  for (const item of input.views) {
    const id = item.thread_id?.trim();
    if (!id) {
      continue;
    }
    loaded.add(id);
    if (item.hidden === hiddenList) {
      kept.push(item);
    }
  }
  const returned = new Set(
    kept.flatMap((item) => (item.thread_id ? [item.thread_id] : [])),
  );
  const hiddenByPref = new Map(
    input.prefs.map((pref) => [pref.thread_id, pref.hidden] as const),
  );
  return {
    pinned: kept.filter((item) => item.pinned),
    live: kept.filter(
      (item) => !item.pinned && !work.has(item.thread_id ?? ""),
    ),
    active_work: hiddenList
      ? []
      : kept.filter(
          (item) => !item.pinned && work.has(item.thread_id ?? ""),
        ),
    gone: input.collectedIds.filter((id) => {
      if (returned.has(id)) {
        return false;
      }
      if (loaded.has(id)) {
        return true;
      }
      const prefHidden = hiddenByPref.get(id);
      if (prefHidden === true && !hiddenList) {
        return true;
      }
      if (prefHidden === false && hiddenList) {
        return true;
      }
      return false;
    }),
  };
}

export function headsNextBefore(
  live: Array<{ event: { occurred_at: string; id: string } }>,
): InboxHeadsCursor | null {
  let oldest: { occurred_at: string; id: string } | undefined;
  for (const item of live) {
    if (!oldest || isBeforeEvent(item.event, oldest.occurred_at, oldest.id)) {
      oldest = item.event;
    }
  }
  return oldest
    ? { before: oldest.occurred_at, before_id: oldest.id }
    : null;
}

export function splitHeadExcludeIds(input: {
  prefs: Array<{ thread_id: string; pinned?: boolean; hidden?: boolean }>;
  workIds: readonly string[];
  list?: string;
}): { pinnedIds: string[]; workIds: string[] } {
  const hiddenList = normalizeInboxListView(input.list) === "hidden";
  const pinnedIds = [
    ...new Set(
      input.prefs
        .filter(
          (pref) => pref.pinned && (hiddenList ? pref.hidden : !pref.hidden),
        )
        .map((pref) => pref.thread_id),
    ),
  ];
  const pinned = new Set(pinnedIds);
  const workIds = hiddenList
    ? []
    : [...new Set(input.workIds.filter((id) => id && !pinned.has(id)))];
  return { pinnedIds, workIds };
}

export function headsLiveFetchLimit(
  limit: number | undefined,
  excludeCount: number,
): number | undefined {
  if (typeof limit !== "number") {
    return undefined;
  }
  return normalizeInboxLimit(limit + Math.max(0, excludeCount)) ?? limit;
}

export function partitionLiveInboxHeads<
  T extends {
    thread_id?: string;
    event: {
      id: string;
      source?: string;
      external_id?: string;
      occurred_at: string;
    };
  },
>(input: {
  items: T[];
  pinnedIds: readonly string[];
  workIds: readonly string[];
  limit?: number;
  fetchedCount: number;
  fetchLimit?: number;
}): {
  live: T[];
  pinned: T[];
  work: T[];
  hasOlder: boolean;
} {
  const pinnedSet = new Set(input.pinnedIds);
  const workSet = new Set(input.workIds);
  const pinned: T[] = [];
  const work: T[] = [];
  const liveAll: T[] = [];
  for (const item of input.items) {
    const id = headThreadId(item);
    if (!id) {
      continue;
    }
    if (pinnedSet.has(id)) {
      pinned.push(item);
    } else if (workSet.has(id)) {
      work.push(item);
    } else {
      liveAll.push(item);
    }
  }
  const live = takeRecentHeads(liveAll, input.limit);
  const hasOlder =
    (typeof input.limit === "number" && liveAll.length > live.length) ||
    (typeof input.fetchLimit === "number" &&
      input.fetchedCount >= input.fetchLimit);
  return { live, pinned, work, hasOlder };
}

export function splitInboxHeadViews(
  views: InboxViewItem[],
  input: {
    liveIds: readonly string[];
    pinnedIds: readonly string[];
    workIds: readonly string[];
    liveCount: number;
    limit?: number;
    hasOlder?: boolean;
  },
): InboxHeadsPage {
  const byId = new Map<string, InboxViewItem>();
  for (const view of views) {
    if (view.thread_id) {
      byId.set(view.thread_id, view);
    }
  }
  const take = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  const workSet = new Set(input.workIds);
  const takenLive = take(input.liveIds);
  const pinned = uniqueHeadViews([
    ...take(input.pinnedIds),
    ...takenLive.filter((item) => item.pinned),
  ]);
  const pinnedKeys = new Set(pinned.map(headConversationKey).filter(Boolean));
  const live = uniqueHeadViews(
    takenLive.filter((item) => {
      const key = headConversationKey(item);
      return (
        !item.pinned &&
        !workSet.has(item.thread_id ?? "") &&
        !(key && pinnedKeys.has(key))
      );
    }),
  );
  return {
    pinned,
    live,
    active_work: uniqueHeadViews([
      ...take(input.workIds),
      ...takenLive.filter(
        (item) => !item.pinned && workSet.has(item.thread_id ?? ""),
      ),
    ]),
    next_before: headsNextBefore(live),
    has_older:
      input.hasOlder ??
      (typeof input.limit === "number" && input.liveCount >= input.limit),
  };
}

function takeRecentHeads<T extends { event: { occurred_at: string; id: string } }>(
  items: T[],
  limit?: number,
): T[] {
  const cap = normalizeInboxLimit(limit);
  if (cap === undefined || items.length <= cap) {
    return items;
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      if (left.item.event.occurred_at !== right.item.event.occurred_at) {
        return left.item.event.occurred_at < right.item.event.occurred_at
          ? -1
          : 1;
      }
      if (left.item.event.id !== right.item.event.id) {
        return left.item.event.id < right.item.event.id ? -1 : 1;
      }
      return left.index - right.index;
    })
    .slice(items.length - cap)
    .map((row) => row.item);
}

function uniqueHeadViews<T extends {
  thread_id?: string;
  event?: { source?: string; external_id?: string; id?: string };
}>(items: T[]): T[] {
  const seen = new Set<string>();
  const next: T[] = [];
  for (const item of items) {
    const id = headConversationKey(item);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    next.push(item);
  }
  return next;
}

function headConversationKey(item: {
  thread_id?: string;
  event?: { source?: string; external_id?: string; id?: string };
}): string | undefined {
  if (item.event?.source && item.event.external_id) {
    return conversationId(
      item.event.source,
      item.event.external_id,
      item.event.id,
    );
  }
  const id = item.thread_id?.trim();
  return id ? id : undefined;
}

function headThreadId(item: {
  thread_id?: string;
  event: { id: string; source?: string; external_id?: string };
}): string | undefined {
  const id = item.thread_id?.trim();
  if (id) {
    return id;
  }
  if (item.event.source && item.event.external_id) {
    return conversationId(
      item.event.source,
      item.event.external_id,
      item.event.id,
    );
  }
  return undefined;
}

export function trimInboxHead<T extends {
  list_title?: string;
  conversation_label?: string | null;
  body_text?: string;
  attachments?: InboxAttachment[];
}>(item: T): T {
  if (item.list_title === "prompt" && item.conversation_label) {
    return { ...item, body_text: undefined, attachments: undefined };
  }
  return { ...item, attachments: undefined };
}
