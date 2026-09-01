import { t } from "../../shared/i18n.ts";
import { deliveryNeedsYou } from "./message-view.ts";
import { collapseSourceRevisions, type InboxReuse } from "./thread-window.ts";
import type {
  AttentionClass,
  InboxSortMode,
  InboxViewItem,
  ListTitleMode,
  RecordClass,
  ThreadFacet,
  ThreadPrompt,
  WorkFace,
} from "./types";

export interface InboxThread {
  id: string;
  source: string;
  channel: string;
  channel_label: string;
  label: string;
  title: string | null;
  conversation_label: string | null;
  conversation_kind: string | null;
  unit_kind: string | null;
  unit_kind_label: string | null;
  pinned: boolean;
  hidden: boolean;
  pref_updated_at?: string;
  can_send: boolean;
  await_reply?: boolean;
  hold_while_working?: boolean;
  list_title?: ListTitleMode;
  draft_installation_id?: string;
  messages: InboxViewItem[];
  opened_at?: string;
  prompts: ThreadPrompt[];
  unread: boolean;
  unread_count: number;
  record_class?: RecordClass;
  thread_facet?: ThreadFacet;
  attention?: AttentionClass;
  work?: WorkFace;
}

export type PinFilter = "all" | "pinned" | "unpinned";

export const MAX_CACHED_THREADS = 8;

export interface ConversationPrefOverlay {
  title: string | null;
  pinned: boolean;
  hidden: boolean;
  updated_at: string;
}

export function workThreadId(
  source: string,
  externalId: string,
  fallbackId: string,
): string {
  const cut = externalId.indexOf(":out:");
  if (cut >= 0) {
    const target = externalId.slice(0, cut).trim();
    return `${source}:${target || fallbackId}`;
  }
  const colon = externalId.lastIndexOf(":");
  if (colon > 0) {
    return `${source}:${externalId.slice(0, colon)}`;
  }
  return `${source}:${externalId || fallbackId}`;
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
      thread.hidden === local.hidden &&
      thread.pref_updated_at === local.updated_at
    ) {
      return thread;
    }
    changed = true;
    return {
      ...thread,
      title: local.title,
      pinned: local.pinned,
      hidden: local.hidden,
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

export function sortInboxThreads(
  threads: InboxThread[],
  mode: InboxSortMode = "normal",
): InboxThread[] {
  if (threads.length < 2) {
    return threads;
  }
  const compare = (left: InboxThread, right: InboxThread) =>
    compareInboxThreads(left, right, mode);
  for (let index = 1; index < threads.length; index += 1) {
    if (compare(threads[index - 1], threads[index]) > 0) {
      return [...threads].sort(compare);
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

export function mergeInboxThreadLists(
  ...lists: Array<readonly InboxThread[]>
): InboxThread[] {
  const seen = new Set<string>();
  const next: InboxThread[] = [];
  for (const list of lists) {
    for (const thread of list) {
      if (seen.has(thread.id)) {
        continue;
      }
      seen.add(thread.id);
      next.push(thread);
    }
  }
  return next;
}

export function filterInboxThreadsByTitle(
  threads: readonly InboxThread[],
  query: string,
  titleOf: (thread: InboxThread) => string,
): InboxThread[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...threads];
  }
  return threads.filter((thread) =>
    titleOf(thread).toLowerCase().includes(needle),
  );
}

export function adjacentInboxThreadId(
  ids: readonly string[],
  current: string | null,
  delta: -1 | 1,
): string | null {
  if (ids.length === 0) {
    return current;
  }
  if (!current) {
    return ids[0] ?? null;
  }
  const index = ids.indexOf(current);
  if (index < 0) {
    return ids[0] ?? current;
  }
  const next = index + delta;
  if (next < 0 || next >= ids.length) {
    return current;
  }
  return ids[next] ?? current;
}

export function canMoveInboxThread(
  ids: readonly string[],
  current: string | null,
  delta: -1 | 1,
): boolean {
  if (!current) {
    return false;
  }
  return adjacentInboxThreadId(ids, current, delta) !== current;
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
  return orderMessages(collapseSourceRevisions(messages));
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
      hold_while_working:
        messages.some((item) => item.hold_while_working === true)
        || thread.hold_while_working === true,
      list_title: threadListTitle(messages, thread.list_title),
      ...threadSurface(messages, thread),
      ...threadWork(messages, thread),
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
      ...threadWork(messages, thread),
    };
  }
  if (thread.messages.length > 0) {
    return { ...thread, messages: [] };
  }
  return thread;
}

export function holdOpenedThread(
  previous: InboxThread | null,
  next: InboxThread,
  opened: InboxViewItem[] | undefined,
): InboxThread {
  const view = openedThreadView(next, opened);
  if (
    opened === undefined &&
    view.messages.length === 0 &&
    previous?.id === next.id &&
    previous.messages.length > 0
  ) {
    return { ...view, messages: previous.messages };
  }
  return view;
}

export function keepSelectedThreadId(
  current: string | null,
  firstVisibleId: string | null,
): string | null {
  return current ?? firstVisibleId;
}

export function resolveSelectedThread(
  selectedId: string | null,
  catalog: readonly InboxThread[],
  held: InboxThread | null,
): InboxThread | null {
  if (!selectedId) {
    return null;
  }
  return (
    catalog.find((thread) => thread.id === selectedId) ??
    (held?.id === selectedId ? held : null)
  );
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
    return {
      ...item,
      unread: false,
      unread_count: 0,
      attention: item.attention === "unread" ? "quiet" : item.attention,
    };
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
    next.push(buildThread(id, ordered, old));
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
    return buildThread(thread.id, mergeMessages(thread.messages, extra), thread);
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

function buildThread(
  id: string,
  ordered: InboxViewItem[],
  previous?: InboxThread,
): InboxThread {
  const latest = ordered[ordered.length - 1];
  const pref = latestPref(ordered);
  const rawId = threadLabel(id, latest);
  return {
    id,
    source: latest.event.source,
    channel: latest.channel ?? latest.event.source,
    channel_label: latest.channel_label ?? latest.event.source.toUpperCase(),
    label: rawId,
    title: pref.title,
    conversation_label: keepConversationValue(
      conversationField(ordered, "conversation_label"),
      previous?.conversation_label,
      rawId,
    ),
    conversation_kind: threadConversationKind(ordered, previous?.conversation_kind),
    unit_kind: threadUnitKind(ordered, previous?.unit_kind),
    unit_kind_label: threadUnitKindLabel(ordered, previous?.unit_kind_label),
    pinned: pref.pinned,
    hidden: pref.hidden,
    pref_updated_at: pref.updated_at,
    can_send: ordered.some((item) => item.can_send),
    await_reply: ordered.some((item) => item.await_reply === true),
    hold_while_working: ordered.some((item) => item.hold_while_working === true),
    list_title: threadListTitle(ordered),
    messages: ordered,
    ...threadSurface(ordered),
    ...threadWork(ordered),
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
    return applyForwardedTo(messages);
  }
  for (let index = 1; index < messages.length; index += 1) {
    if (byOccurredAt(messages[index - 1], messages[index]) > 0) {
      return applyForwardedTo([...messages].sort(byOccurredAt));
    }
  }
  return applyForwardedTo(messages);
}

function applyForwardedTo(messages: InboxViewItem[]): InboxViewItem[] {
  const traces = new Map<string, NonNullable<InboxViewItem["forwarded_to"]>>();
  const ranked = messages
    .filter((item) => {
      const trace = item.forwarded_to;
      return Boolean(trace && !trace.event_ids.includes(item.event.id));
    })
    .sort(byOccurredAt);
  for (const item of ranked) {
    const trace = item.forwarded_to;
    if (!trace) {
      continue;
    }
    for (const eventId of trace.event_ids) {
      traces.set(eventId, trace);
    }
  }
  if (traces.size === 0) {
    return messages;
  }
  let changed = false;
  const next = messages.map((item) => {
    const joined = traces.get(item.event.id);
    if (!joined || sameForwardedTo(item.forwarded_to, joined)) {
      return item;
    }
    changed = true;
    return { ...item, forwarded_to: joined };
  });
  return changed ? next : messages;
}

function sameForwardedTo(
  left?: InboxViewItem["forwarded_to"],
  right?: InboxViewItem["forwarded_to"],
): boolean {
  return (
    left?.thread_id === right?.thread_id &&
    left?.source === right?.source &&
    left?.channel_label === right?.channel_label &&
    (left?.event_ids ?? []).join("\0") === (right?.event_ids ?? []).join("\0")
  );
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
      return applyForwardedTo([...existing, added[0]]);
    }
  }
  return orderMessages([...existing, ...added]);
}

export function resolveThreadAttention(thread: InboxThread): AttentionClass {
  if (
    thread.attention === "waiting_you" ||
    thread.attention === "needs_ack" ||
    thread.attention === "running"
  ) {
    return thread.attention;
  }
  if (
    (thread.prompts?.length ?? 0) > 0 ||
    thread.work?.status === "waiting_human" ||
    thread.work?.status === "failed" ||
    deliveryNeedsYou(thread.work?.delivery)
  ) {
    return "waiting_you";
  }
  if (
    thread.work?.status === "done" &&
    thread.work.has_result &&
    thread.work.can_write_back === false
  ) {
    return "needs_ack";
  }
  if (
    thread.work?.status === "running" ||
    thread.messages.some((item) => item.activity === "working")
  ) {
    return "running";
  }
  if (thread.unread || (thread.unread_count ?? 0) > 0) {
    return "unread";
  }
  if (thread.attention && thread.attention !== "unread") {
    return thread.attention;
  }
  return "quiet";
}

export function groupThreadsByAttention(
  threads: InboxThread[],
): Array<{ key: string; label: string | null; items: InboxThread[] }> {
  const labels: Record<AttentionClass, string> = {
    waiting_you: t("inbox.needsYou"),
    needs_ack: t("inbox.needsYou"),
    running: t("inbox.sectionRunning"),
    unread: t("inbox.unread"),
    quiet: t("inbox.theRest"),
  };
  const sections: Array<{ key: string; label: string; items: InboxThread[] }> = [];
  for (const thread of threads) {
    const attention = resolveThreadAttention(thread);
    const key = attention === "needs_ack" ? "waiting_you" : attention;
    const last = sections[sections.length - 1];
    if (last?.key === key) {
      last.items.push(thread);
    } else {
      sections.push({ key, label: labels[attention], items: [thread] });
    }
  }
  if (sections.length <= 1) {
    return [{ key: "all", label: null, items: threads }];
  }
  return sections;
}

function compareInboxThreads(
  left: InboxThread,
  right: InboxThread,
  mode: InboxSortMode = "normal",
): number {
  if (left.pinned !== right.pinned) {
    return left.pinned ? -1 : 1;
  }
  if (mode === "attention") {
    const leftAttention = resolveThreadAttention(left);
    const rightAttention = resolveThreadAttention(right);
    const byAttention = compareAttentionRank(leftAttention, rightAttention);
    if (byAttention !== 0) {
      return byAttention;
    }
    if (leftAttention === "running") {
      return compareStamp(attentionStable(right), attentionStable(left));
    }
  }
  return byRecentActivity(left, right);
}

const ATTENTION_RANK: Record<AttentionClass, number> = {
  waiting_you: 0,
  needs_ack: 1,
  running: 2,
  unread: 3,
  quiet: 4,
};

function compareAttentionRank(left: AttentionClass, right: AttentionClass): number {
  return ATTENTION_RANK[left] - ATTENTION_RANK[right];
}

function attentionStable(thread: InboxThread): string {
  return thread.work?.updated_at ?? thread.work?.id ?? activityStamp(thread);
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
  hidden: boolean;
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
    hidden: source?.hidden === true,
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
  key:
    | "conversation_label"
    | "conversation_kind"
    | "unit_kind"
    | "unit_kind_label",
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const value = messages[index]?.[key]?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function keepConversationValue(
  next: string | null,
  previous: string | null | undefined,
  rawId: string,
): string | null {
  return usableConversationName(next, rawId) ?? usableConversationName(previous, rawId);
}

function threadConversationKind(
  messages: InboxViewItem[],
  previous?: string | null,
): string | null {
  const inbound = conversationField(
    messages.filter((item) => item.direction === "inbound"),
    "conversation_kind",
  );
  if (inbound) {
    return inbound;
  }
  if (previous?.trim()) {
    return previous.trim();
  }
  return conversationField(messages, "conversation_kind");
}

function threadUnitKind(
  messages: InboxViewItem[],
  previous?: string | null,
): string | null {
  return threadStampedField(messages, "unit_kind", previous);
}

function threadUnitKindLabel(
  messages: InboxViewItem[],
  previous?: string | null,
): string | null {
  return threadStampedField(messages, "unit_kind_label", previous);
}

function threadStampedField(
  messages: InboxViewItem[],
  key: "unit_kind" | "unit_kind_label",
  previous?: string | null,
): string | null {
  const inbound = conversationField(
    messages.filter((item) => item.direction === "inbound"),
    key,
  );
  if (inbound) {
    return inbound;
  }
  if (previous?.trim()) {
    return previous.trim();
  }
  return conversationField(messages, key);
}

function usableConversationName(
  name: string | null | undefined,
  rawId: string,
): string | null {
  const value = name?.replace(/\s+/g, " ").trim() || null;
  if (!value || value === rawId) {
    return null;
  }
  return value;
}

function threadWork(
  messages: InboxViewItem[],
  fallback?: Pick<InboxThread, "record_class" | "thread_facet" | "attention" | "work">,
): Pick<InboxThread, "record_class" | "thread_facet" | "attention" | "work"> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (item.work || item.attention || item.record_class || item.thread_facet) {
      return {
        record_class: item.record_class,
        thread_facet: item.thread_facet,
        attention: item.attention,
        work: item.work,
      };
    }
  }
  return {
    record_class: fallback?.record_class,
    thread_facet: fallback?.thread_facet,
    attention: fallback?.attention,
    work: fallback?.work,
  };
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
