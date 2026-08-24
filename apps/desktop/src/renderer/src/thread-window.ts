import { reuseKeyedList, type KeyedReuse } from "./keyed-list.ts";
import type { InboxViewItem } from "./types";

export const THREAD_OVERSCAN = 10;
export const THREAD_STICK_PX = 96;
export const THREAD_LOAD_OLDER_PX = 12;
export const THREAD_LOAD_OLDER_REARM_PX = 80;
export const THREAD_PAGE_SIZE = 50;

export type InboxReuse = KeyedReuse<InboxViewItem>;

export function itemRevision(item: InboxViewItem): string {
  const body = item.event.content_hash ? "" : (item.body_text ?? "");
  return `${item.event.id}\t${item.event.content_hash ?? ""}\t${item.event.occurred_at}\t${
    item.title ?? ""
  }\t${item.pinned ? "1" : "0"}\t${item.pref_updated_at ?? ""}\t${item.actor_label ?? ""}\t${
    item.conversation_label ?? ""
  }\t${item.list_title ?? ""}\t${body}\t${item.attachments?.length ?? 0}\t${
    item.unread ? "1" : "0"
  }\t${(item.prompts ?? []).map((prompt) => prompt.prompt_id).join(",")}`;
}

export function inboxRevision(items: InboxViewItem[]): string {
  let revision = String(items.length);
  for (const item of items) {
    revision += `\n${itemRevision(item)}`;
  }
  return revision;
}

export function reuseInboxItems(
  previous: InboxViewItem[],
  next: InboxViewItem[],
): InboxViewItem[] {
  return reuseInboxList(previous, next).items;
}

export function mergeInboxDelta(
  previous: InboxViewItem[],
  delta: InboxViewItem[],
): InboxViewItem[] {
  if (delta.length === 0) {
    return previous;
  }
  if (previous.length === 0) {
    return delta;
  }
  const replacements = new Map(delta.map((item) => [item.event.id, item]));
  const updated = previous.map((item) => replacements.get(item.event.id) ?? item);
  const seen = new Set(previous.map((item) => item.event.id));
  const oldest = previous[0];
  const appended = delta.filter((item) => {
    if (seen.has(item.event.id)) {
      return false;
    }
    return !isBeforeEvent(item.event, oldest.event.occurred_at, oldest.event.id);
  });
  return appended.length === 0 ? updated : [...updated, ...appended];
}

export function mergeRecentInbox(
  previous: InboxViewItem[],
  recent: InboxViewItem[],
): InboxViewItem[] {
  if (recent.length === 0) {
    return previous;
  }
  if (previous.length === 0) {
    return recent;
  }
  const oldestRecent = recent[0];
  const recentIds = new Set(recent.map((item) => item.event.id));
  const older = previous.filter(
    (item) =>
      !recentIds.has(item.event.id) &&
      isBeforeEvent(
        item.event,
        oldestRecent.event.occurred_at,
        oldestRecent.event.id,
      ),
  );
  const reusedRecent = reuseInboxItems(
    previous.filter((item) => recentIds.has(item.event.id)),
    recent,
  );
  return older.length === 0 ? reusedRecent : [...older, ...reusedRecent];
}

export function mergeOlderInbox(
  previous: InboxViewItem[],
  older: InboxViewItem[],
): InboxViewItem[] {
  if (older.length === 0) {
    return previous;
  }
  if (previous.length === 0) {
    return older;
  }
  const seen = new Set(previous.map((item) => item.event.id));
  const prepend = older.filter((item) => !seen.has(item.event.id));
  return prepend.length === 0 ? previous : [...prepend, ...previous];
}

export function olderInboxCursor(
  items: InboxViewItem[],
): { before: string; before_id: string } | null {
  const first = items[0];
  if (!first) {
    return null;
  }
  return {
    before: first.event.occurred_at,
    before_id: first.event.id,
  };
}

export function hasOlderPage(
  pageLength: number,
  limit = THREAD_PAGE_SIZE,
): boolean {
  return pageLength >= limit;
}

function isBeforeEvent(
  event: { occurred_at: string; id: string },
  before: string,
  beforeId: string,
): boolean {
  if (event.occurred_at < before) {
    return true;
  }
  return event.occurred_at === before && event.id < beforeId;
}

export function shouldFetchInboxDelta(input: {
  loaded: boolean;
  loadedCount: number;
  hasCursor: boolean;
}): boolean {
  return input.loaded && input.hasCursor && input.loadedCount > 1;
}

export function inboxCursor(
  items: InboxViewItem[],
): { since: string; since_id: string } | null {
  let since = "";
  let sinceId = "";
  for (const item of items) {
    const at = item.event.ingested_at;
    if (!at) {
      continue;
    }
    if (at > since || (at === since && item.event.id > sinceId)) {
      since = at;
      sinceId = item.event.id;
    }
  }
  return since ? { since, since_id: sinceId } : null;
}

export function reuseInboxList(
  previous: InboxViewItem[],
  next: InboxViewItem[],
): InboxReuse {
  return reuseKeyedList(previous, next, inboxItemKey, sameInboxProps);
}

export function inboxItemKey(item: InboxViewItem): string {
  return item.event.id;
}

export function sameInboxProps(
  previous: InboxViewItem,
  next: InboxViewItem,
): boolean {
  if (previous === next) {
    return true;
  }
  const left = previous.event;
  const right = next.event;
  if (left.id !== right.id || left.content_hash !== right.content_hash) {
    return false;
  }
  if (left.occurred_at !== right.occurred_at) {
    return false;
  }
  if (
    previous.title !== next.title ||
    previous.pinned !== next.pinned ||
    previous.pref_updated_at !== next.pref_updated_at ||
    previous.actor_label !== next.actor_label ||
    previous.conversation_label !== next.conversation_label ||
    previous.conversation_kind !== next.conversation_kind ||
    previous.thread_id !== next.thread_id ||
    previous.kind !== next.kind ||
    previous.can_send !== next.can_send ||
    previous.await_reply !== next.await_reply ||
    previous.list_title !== next.list_title ||
    previous.activity !== next.activity ||
    previous.unread !== next.unread ||
    previous.unread_count !== next.unread_count ||
    promptRevision(previous) !== promptRevision(next)
  ) {
    return false;
  }
  if ((previous.attachments?.length ?? 0) !== (next.attachments?.length ?? 0)) {
    return false;
  }
  return Boolean(left.content_hash) || previous.body_text === next.body_text;
}

function promptRevision(item: InboxViewItem): string {
  return (item.prompts ?? []).map((prompt) => prompt.prompt_id).join(",");
}

export function prefixOffsets(sizes: number[]): number[] {
  const offsets = new Array<number>(sizes.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < sizes.length; index += 1) {
    offsets[index + 1] = offsets[index] + sizes[index];
  }
  return offsets;
}

export function computeWindow(input: {
  offsets: number[];
  scrollTop: number;
  viewport: number;
  overscan?: number;
}): { start: number; end: number } {
  const count = input.offsets.length - 1;
  if (count <= 0) {
    return { start: 0, end: 0 };
  }
  const overscan = input.overscan ?? THREAD_OVERSCAN;
  const top = Math.max(0, input.scrollTop);
  const bottom = top + Math.max(0, input.viewport);
  const start = Math.max(0, lastIndexAtMost(input.offsets, top) - overscan);
  const end = Math.min(count, firstIndexAtLeast(input.offsets, bottom) + overscan);
  if (end <= start) {
    return { start, end: Math.min(count, start + 1) };
  }
  return { start, end };
}

export function estimateMessageHeight(
  item: InboxViewItem,
  follow: boolean,
): number {
  if (item.kind === "system") {
    return 36;
  }
  const text = item.body_text ?? "";
  const lines = Math.max(
    1,
    text.split(/\r?\n/).reduce((sum, line) => {
      return sum + Math.max(1, Math.ceil(Math.max(line.length, 1) / 72));
    }, 0),
  );
  const body = Math.min(520, 8 + lines * 22);
  const files = (item.attachments ?? []).reduce((sum, file) => {
    return sum + (file.media_type.startsWith("image/") ? 168 : 32);
  }, 0);
  return 36 + (follow ? 2 : 20) + body + files + (follow ? 10 : 18);
}

export function isStuckToEnd(node: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= THREAD_STICK_PX;
}

export function shouldRearmLoadOlder(scrollTop: number): boolean {
  return scrollTop > THREAD_LOAD_OLDER_REARM_PX;
}

export function shouldLoadOlder(input: {
  hasOlder: boolean;
  loadingOlder: boolean;
  opening: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrolledUp: boolean;
  armed: boolean;
}): boolean {
  if (!input.hasOlder || input.loadingOlder || input.opening) {
    return false;
  }
  if (input.scrollHeight <= input.clientHeight + 1) {
    return true;
  }
  return (
    input.armed &&
    input.scrolledUp &&
    input.scrollTop <= THREAD_LOAD_OLDER_PX
  );
}

function lastIndexAtMost(offsets: number[], value: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 2);
  while (low < high) {
    const mid = Math.ceil((low + high + 1) / 2);
    if (offsets[mid] <= value) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return low;
}

function firstIndexAtLeast(offsets: number[], value: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid] >= value) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  return low;
}
