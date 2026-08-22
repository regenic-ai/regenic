import type { InboxViewItem } from "./types";

export interface InboxThread {
  id: string;
  source: string;
  channel: string;
  channel_label: string;
  label: string;
  can_send: boolean;
  messages: InboxViewItem[];
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

export function groupInboxThreads(items: InboxViewItem[]): InboxThread[] {
  const groups = new Map<string, InboxViewItem[]>();
  for (const item of items) {
    const id = workThreadId(item.event.source, item.event.external_id, item.event.id);
    const bucket = groups.get(id);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(id, [item]);
    }
  }
  return [...groups.entries()]
    .map(([id, messages]) => {
      const ordered = [...messages].sort(byOccurredAt);
      const latest = ordered[ordered.length - 1];
      return {
        id,
        source: latest.event.source,
        channel: latest.channel ?? latest.event.source,
        channel_label: latest.channel_label ?? latest.event.source.toUpperCase(),
        label: threadLabel(id, latest),
        can_send: ordered.some((item) => item.can_send),
        messages: ordered,
      };
    })
    .sort((left, right) => {
      const leftAt = left.messages[left.messages.length - 1]?.event.occurred_at ?? "";
      const rightAt = right.messages[right.messages.length - 1]?.event.occurred_at ?? "";
      return rightAt.localeCompare(leftAt);
    });
}

export function latestMessage(thread: InboxThread): InboxViewItem | undefined {
  return thread.messages[thread.messages.length - 1];
}

function byOccurredAt(left: InboxViewItem, right: InboxViewItem): number {
  const byTime = left.event.occurred_at.localeCompare(right.event.occurred_at);
  if (byTime !== 0) {
    return byTime;
  }
  return left.event.external_id.localeCompare(right.event.external_id);
}

function threadLabel(id: string, latest: InboxViewItem): string {
  const prefix = id.slice(latest.event.source.length + 1);
  if (prefix.startsWith("session-") && prefix.length > 16) {
    return `${prefix.slice(0, 8)}…${prefix.slice(-4)}`;
  }
  return prefix || latest.event.external_id;
}
