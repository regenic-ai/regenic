import { reuseKeyedList, type KeyedReuse } from "./keyed-list.ts";
import type { InboxViewItem } from "./types";

export const THREAD_OVERSCAN = 10;
export const THREAD_STICK_PX = 96;

export type InboxReuse = KeyedReuse<InboxViewItem>;

export function itemRevision(item: InboxViewItem): string {
  const body = item.event.content_hash ? "" : (item.body_text ?? "");
  return `${item.event.id}\t${item.event.content_hash ?? ""}\t${item.event.occurred_at}\t${
    item.title ?? ""
  }\t${item.pinned ? "1" : "0"}\t${item.pref_updated_at ?? ""}\t${item.actor_label ?? ""}\t${
    item.conversation_label ?? ""
  }\t${body}\t${item.attachments?.length ?? 0}`;
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
  const appended = delta.filter((item) => !seen.has(item.event.id));
  return appended.length === 0 ? updated : [...updated, ...appended];
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
    previous.activity !== next.activity
  ) {
    return false;
  }
  if ((previous.attachments?.length ?? 0) !== (next.attachments?.length ?? 0)) {
    return false;
  }
  return Boolean(left.content_hash) || previous.body_text === next.body_text;
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
