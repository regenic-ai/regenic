import type { InboxReuse } from "./thread-window";
import type { InboxViewItem, ListTitleMode, ThreadPrompt } from "./types";

export interface InboxThread {
  id: string;
  source: string;
  channel: string;
  channel_label: string;
  label: string;
  title: string | null;
  conversation_label: string | null;
  conversation_kind: string | null;
  pinned: boolean;
  pref_updated_at?: string;
  can_send: boolean;
  await_reply?: boolean;
  list_title?: ListTitleMode;
  messages: InboxViewItem[];
  opened_at?: string;
  prompts: ThreadPrompt[];
  unread: boolean;
  unread_count: number;
}

export type PinFilter = "all" | "pinned" | "unpinned";

export const MAX_CACHED_THREADS = 8;

export interface ConversationPrefOverlay {
  title: string | null;
  pinned: boolean;
  updated_at: string;
}

export function workThreadId(
  source: string,
  externalId: string,
  fallbackId: string,
): string {
  const cut = externalId.indexOf(":out:");
  const withoutOut = cut >= 0 ? externalId.slice(0, cut) : externalId;
  const colon = withoutOut.lastIndexOf(":");
  if (colon > 0) {
    return `${source}:${withoutOut.slice(0, colon)}`;
  }
  return `${source}:${withoutOut || fallbackId}`;
}

export function groupInboxThreads(
  items: InboxViewItem[],
  previous: InboxThread[] = [],
  reuse?: InboxReuse,
): InboxThread[] {
  if (reuse?.same && previous.length > 0) {
    return previous;
  }
  if (
    reuse &&
    previous.length > 0 &&
    reuse.oldLength > 0 &&
    reuse.unchangedPrefix === reuse.oldLength &&
    items.length >= reuse.oldLength
  ) {
    return appendInboxThreads(previous, items.slice(reuse.oldLength));
  }
  return rebuildInboxThreads(items, previous);
}

export function applyPrefOverlay(
  threads: InboxThread[],
  overlay: Record<string, ConversationPrefOverlay>,
): InboxThread[] {
  if (isEmptyRecord(overlay)) {
    return threads;
  }
  let changed = false;
  const next = threads.map((thread) => {
    const local = overlay[thread.id];
    if (!local) {
      return thread;
    }
    if (thread.pref_updated_at && thread.pref_updated_at > local.updated_at) {
      return thread;
    }
    if (
      thread.title === local.title &&
      thread.pinned === local.pinned &&
      thread.pref_updated_at === local.updated_at
    ) {
      return thread;
    }
    changed = true;
    return {
      ...thread,
      title: local.title,
      pinned: local.pinned,
      pref_updated_at: local.updated_at,
    };
  });
  return changed ? next : threads;
}

export function prunePrefOverlay(
  overlay: Record<string, ConversationPrefOverlay>,
  threads: InboxThread[],
): Record<string, ConversationPrefOverlay> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  let changed = false;
  const next = { ...overlay };
  for (const [id, local] of Object.entries(overlay)) {
    const thread = byId.get(id);
    if (thread?.pref_updated_at && thread.pref_updated_at >= local.updated_at) {
      delete next[id];
      changed = true;
    }
  }
  return changed ? next : overlay;
}

export function sortInboxThreads(threads: InboxThread[]): InboxThread[] {
  if (threads.length < 2) {
    return threads;
  }
  for (let index = 1; index < threads.length; index += 1) {
    if (compareInboxThreads(threads[index - 1], threads[index]) > 0) {
      return [...threads].sort(compareInboxThreads);
    }
  }
  return threads;
}

export function filterInboxThreads(
  threads: InboxThread[],
  pin: PinFilter,
  channel: string,
): InboxThread[] {
  return threads.filter((thread) => {
    if (pin === "pinned" && !thread.pinned) {
      return false;
    }
    if (pin === "unpinned" && thread.pinned) {
      return false;
    }
    if (channel !== "all" && thread.channel !== channel) {
      return false;
    }
    return true;
  });
}

export function threadChannels(
  threads: InboxThread[],
): Array<{ id: string; label: string }> {
  const seen = new Map<string, string>();
  for (const thread of threads) {
    if (!seen.has(thread.channel)) {
      seen.set(thread.channel, thread.channel_label);
    }
  }
  return [...seen.entries()].map(([id, label]) => ({ id, label }));
}

export function evictThreadCache<T>(
  cache: Record<string, T>,
  prefer: Array<string | null | undefined>,
  limit = MAX_CACHED_THREADS,
): Record<string, T> {
  const keys = Object.keys(cache);
  if (keys.length <= limit) {
    return cache;
  }
  const keep = new Set<string>();
  for (const id of prefer) {
    if (id && cache[id]) {
      keep.add(id);
    }
    if (keep.size >= limit) {
      break;
    }
  }
  for (const id of keys) {
    if (keep.size >= limit) {
      break;
    }
    keep.add(id);
  }
  if (keep.size === keys.length) {
    return cache;
  }
  const next: Record<string, T> = {};
  for (const id of keep) {
    next[id] = cache[id];
  }
  return next;
}

export function orderThreadMessages(
  messages: InboxViewItem[],
): InboxViewItem[] {
  return orderMessages(messages);
}

export function overlayThreadMessages(
  threads: InboxThread[],
  messagesByThread: Record<string, InboxViewItem[]>,
): InboxThread[] {
  let changed = false;
  const next = threads.map((thread) => {
    const raw = messagesByThread[thread.id];
    if (!raw) {
      return thread;
    }
    const messages = orderMessages(raw);
    if (messages === thread.messages || sameMessageList(messages, thread.messages)) {
      return thread;
    }
    changed = true;
    return {
      ...thread,
      messages,
      can_send: messages.some((item) => item.can_send) || thread.can_send,
      await_reply:
        messages.some((item) => item.await_reply === true) || thread.await_reply === true,
      list_title: threadListTitle(messages, thread.list_title),
      ...threadSurface(messages, thread),
    };
  });
  return changed ? next : threads;
}

export function openedThreadView(
  thread: InboxThread,
  opened: InboxViewItem[] | undefined,
  _opening = false,
): InboxThread {
  if (opened) {
    const messages = orderMessages(opened);
    if (messages === thread.messages || sameMessageList(messages, thread.messages)) {
      return thread;
    }
    return {
      ...thread,
      messages,
      can_send: messages.some((item) => item.can_send) || thread.can_send,
      await_reply:
        messages.some((item) => item.await_reply === true) ||
        thread.await_reply === true,
      ...threadSurface(messages, thread),
    };
  }
  if (thread.messages.length > 0) {
    return { ...thread, messages: [] };
  }
  return thread;
}

export function latestMessage(thread: InboxThread): InboxViewItem | undefined {
  return thread.messages[thread.messages.length - 1];
}

export function messagesForAttentionAck(
  loaded: InboxViewItem[] | undefined,
  opened: InboxViewItem[],
  heads: InboxViewItem[],
): InboxViewItem[] {
  if (loaded && loaded.length > 0) {
    return loaded;
  }
  if (opened.length > 0) {
    return opened;
  }
  return heads;
}

export function latestInboundOf(items: InboxViewItem[]): InboxViewItem | undefined {
  let best: InboxViewItem | undefined;
  for (const item of items) {
    if (item.direction !== "inbound") {
      continue;
    }
    if (
      !best ||
      item.event.occurred_at > best.event.occurred_at ||
      (item.event.occurred_at === best.event.occurred_at &&
        item.event.external_id > best.event.external_id)
    ) {
      best = item;
    }
  }
  return best;
}

export function markInboxThreadRead(
  items: InboxViewItem[],
  threadId: string,
): InboxViewItem[] {
  let changed = false;
  const next = items.map((item) => {
    if (item.thread_id !== threadId || item.unread !== true) {
      return item;
    }
    changed = true;
    return { ...item, unread: false, unread_count: 0 };
  });
  return changed ? next : items;
}

function rebuildInboxThreads(
  items: InboxViewItem[],
  previous: InboxThread[],
): InboxThread[] {
  const groups = new Map<string, InboxViewItem[]>();
  for (const item of items) {
    const id = threadIdOf(item);
    const bucket = groups.get(id);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(id, [item]);
    }
  }
  const prevById = new Map(previous.map((thread) => [thread.id, thread]));
  const next: InboxThread[] = [];
  for (const [id, messages] of groups) {
    const old = prevById.get(id);
    if (old && sameMessageList(old.messages, messages)) {
      next.push(old);
      continue;
    }
    const ordered = orderMessages(messages);
    if (old && sameMessageList(old.messages, ordered)) {
      next.push(old);
      continue;
    }
    next.push(buildThread(id, ordered));
  }
  return sortInboxThreads(next);
}

function appendInboxThreads(
  previous: InboxThread[],
  added: InboxViewItem[],
): InboxThread[] {
  if (added.length === 0) {
    return previous;
  }
  const dirty = new Map<string, InboxViewItem[]>();
  for (const item of added) {
    const id = threadIdOf(item);
    const bucket = dirty.get(id);
    if (bucket) {
      bucket.push(item);
    } else {
      dirty.set(id, [item]);
    }
  }
  const next = previous.map((thread) => {
    const extra = dirty.get(thread.id);
    if (!extra) {
      return thread;
    }
    dirty.delete(thread.id);
    return buildThread(thread.id, mergeMessages(thread.messages, extra));
  });
  for (const [id, extra] of dirty) {
    next.push(buildThread(id, orderMessages(extra)));
  }
  return sortInboxThreads(next);
}

function threadIdOf(item: InboxViewItem): string {
  return (
    item.thread_id ??
    workThreadId(item.event.source, item.event.external_id, item.event.id)
  );
}

function buildThread(id: string, ordered: InboxViewItem[]): InboxThread {
  const latest = ordered[ordered.length - 1];
  const pref = latestPref(ordered);
  return {
    id,
    source: latest.event.source,
    channel: latest.channel ?? latest.event.source,
    channel_label: latest.channel_label ?? latest.event.source.toUpperCase(),
    label: threadLabel(id, latest),
    title: pref.title,
    conversation_label: conversationField(ordered, "conversation_label"),
    conversation_kind: conversationField(ordered, "conversation_kind"),
    pinned: pref.pinned,
    pref_updated_at: pref.updated_at,
    can_send: ordered.some((item) => item.can_send),
    await_reply: ordered.some((item) => item.await_reply === true),
    list_title: threadListTitle(ordered),
    messages: ordered,
    ...threadSurface(ordered),
  };
}

function sameMessageList(left: InboxViewItem[], right: InboxViewItem[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function orderMessages(messages: InboxViewItem[]): InboxViewItem[] {
  if (messages.length < 2) {
    return messages;
  }
  for (let index = 1; index < messages.length; index += 1) {
    if (byOccurredAt(messages[index - 1], messages[index]) > 0) {
      return [...messages].sort(byOccurredAt);
    }
  }
  return messages;
}

function mergeMessages(
  existing: InboxViewItem[],
  added: InboxViewItem[],
): InboxViewItem[] {
  if (added.length === 0) {
    return existing;
  }
  if (added.length === 1) {
    const last = existing[existing.length - 1];
    if (!last || byOccurredAt(last, added[0]) <= 0) {
      return [...existing, added[0]];
    }
  }
  return orderMessages([...existing, ...added]);
}

function compareInboxThreads(left: InboxThread, right: InboxThread): number {
  if (left.pinned !== right.pinned) {
    return left.pinned ? -1 : 1;
  }
  return byRecentActivity(left, right);
}

function isEmptyRecord(value: Record<string, unknown>): boolean {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return false;
    }
  }
  return true;
}

function latestPref(messages: InboxViewItem[]): {
  title: string | null;
  pinned: boolean;
  updated_at?: string;
} {
  let best: InboxViewItem | undefined;
  for (const item of messages) {
    if (!item.pref_updated_at) {
      continue;
    }
    if (!best || (best.pref_updated_at ?? "") < item.pref_updated_at) {
      best = item;
    }
  }
  const source = best ?? messages[messages.length - 1];
  return {
    title: source?.title ?? null,
    pinned: source?.pinned === true,
    updated_at: source?.pref_updated_at ?? undefined,
  };
}

function byOccurredAt(left: InboxViewItem, right: InboxViewItem): number {
  const byTime = compareStamp(left.event.occurred_at, right.event.occurred_at);
  if (byTime !== 0) {
    return byTime;
  }
  return compareStamp(left.event.external_id, right.event.external_id);
}

function byRecentActivity(left: InboxThread, right: InboxThread): number {
  return compareStamp(activityStamp(right), activityStamp(left));
}

function activityStamp(thread: InboxThread): string {
  const latest = latestMessage(thread)?.event.occurred_at ?? "";
  const opened = thread.opened_at ?? "";
  return latest > opened ? latest : opened;
}

function compareStamp(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function threadListTitle(
  messages: InboxViewItem[],
  fallback?: InboxThread["list_title"],
): InboxThread["list_title"] {
  if (
    messages.some((item) => item.list_title === "conversation") ||
    fallback === "conversation"
  ) {
    return "conversation";
  }
  if (
    messages.some((item) => item.list_title === "prompt") ||
    fallback === "prompt"
  ) {
    return "prompt";
  }
  return "face";
}

function conversationField(
  messages: InboxViewItem[],
  key: "conversation_label" | "conversation_kind",
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index]?.[key]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function threadSurface(
  messages: InboxViewItem[],
  fallback?: Pick<InboxThread, "prompts" | "unread" | "unread_count">,
): Pick<InboxThread, "prompts" | "unread" | "unread_count"> {
  const fromMessages = messages.find((item) => (item.prompts?.length ?? 0) > 0)?.prompts;
  const prompts = fromMessages ?? fallback?.prompts ?? [];
  const unread =
    prompts.length > 0 ||
    (messages.length > 0
      ? messages.some((item) => item.unread === true)
      : fallback?.unread === true);
  const counts = [
    ...messages.map((item) => item.unread_count ?? 0),
    fallback?.unread_count ?? 0,
  ];
  const unread_count = unread ? Math.max(1, ...counts) : 0;
  return { prompts, unread, unread_count };
}

function threadLabel(id: string, latest: InboxViewItem): string {
  const prefix = id.slice(latest.event.source.length + 1);
  if (prefix.startsWith("session-") && prefix.length > 16) {
    return `${prefix.slice(0, 8)}…${prefix.slice(-4)}`;
  }
  return prefix || latest.event.external_id;
}
