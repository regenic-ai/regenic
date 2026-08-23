import type { InboxViewItem } from "./types";

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
  messages: InboxViewItem[];
}

export type PinFilter = "all" | "pinned" | "unpinned";

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
): InboxThread[] {
  const groups = new Map<string, InboxViewItem[]>();
  for (const item of items) {
    const id =
      item.thread_id ??
      workThreadId(item.event.source, item.event.external_id, item.event.id);
    const bucket = groups.get(id);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(id, [item]);
    }
  }
  const prevById = new Map(previous.map((thread) => [thread.id, thread]));
  return [...groups.entries()]
    .map(([id, messages]) => {
      const old = prevById.get(id);
      if (old && sameMessageSet(old.messages, messages)) {
        return old;
      }
      const ordered = [...messages].sort(byOccurredAt);
      if (
        old &&
        old.messages.length === ordered.length &&
        old.messages.every((item, index) => item === ordered[index])
      ) {
        return old;
      }
      return buildThread(id, ordered);
    })
    .sort(byRecentActivity);
}

export function applyPrefOverlay(
  threads: InboxThread[],
  overlay: Record<string, ConversationPrefOverlay>,
): InboxThread[] {
  return threads.map((thread) => {
    const local = overlay[thread.id];
    if (!local) {
      return thread;
    }
    if (thread.pref_updated_at && thread.pref_updated_at > local.updated_at) {
      return thread;
    }
    return {
      ...thread,
      title: local.title,
      pinned: local.pinned,
      pref_updated_at: local.updated_at,
    };
  });
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
  return [...threads].sort((left, right) => {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    return byRecentActivity(left, right);
  });
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

export function latestMessage(thread: InboxThread): InboxViewItem | undefined {
  return thread.messages[thread.messages.length - 1];
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
    messages: ordered,
  };
}

function sameMessageSet(left: InboxViewItem[], right: InboxViewItem[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const refs = new Set(left);
  return right.every((item) => refs.has(item));
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
  const byTime = left.event.occurred_at.localeCompare(right.event.occurred_at);
  if (byTime !== 0) {
    return byTime;
  }
  return left.event.external_id.localeCompare(right.event.external_id);
}

function byRecentActivity(left: InboxThread, right: InboxThread): number {
  return activityStamp(right).localeCompare(activityStamp(left));
}

function activityStamp(thread: InboxThread): string {
  return latestMessage(thread)?.event.occurred_at ?? "~";
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

function threadLabel(id: string, latest: InboxViewItem): string {
  const prefix = id.slice(latest.event.source.length + 1);
  if (prefix.startsWith("session-") && prefix.length > 16) {
    return `${prefix.slice(0, 8)}…${prefix.slice(-4)}`;
  }
  return prefix || latest.event.external_id;
}
