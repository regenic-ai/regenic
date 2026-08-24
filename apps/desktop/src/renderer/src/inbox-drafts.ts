import type { InboxThread } from "./inbox.ts";
import {
  normalizeListTitle,
  type CreatedConversation,
  type PersonalEngineView,
} from "./types.ts";

export interface CreateTarget {
  id: string;
  channel: string;
  channel_label: string;
  label: string;
}

export function createConversationTargets(
  engine: PersonalEngineView | null,
): CreateTarget[] {
  if (!engine) {
    return [];
  }
  const seen = new Set<string>();
  const targets: CreateTarget[] = [];
  for (const item of engine.installations) {
    if (!item.can_create || seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    targets.push({
      id: item.id,
      channel: item.channel ?? item.connector_type,
      channel_label: item.channel_label ?? item.connector_type,
      label: item.label,
    });
  }
  return targets;
}

export function applyOpenedAt(
  threads: InboxThread[],
  openedAt: Record<string, string>,
): InboxThread[] {
  let changed = false;
  const next = threads.map((thread) => {
    const opened = openedAt[thread.id];
    if (!opened || thread.opened_at === opened) {
      return thread;
    }
    changed = true;
    return { ...thread, opened_at: opened };
  });
  return changed ? next : threads;
}

export function mergeDraftThreads(
  threads: InboxThread[],
  drafts: CreatedConversation[],
): InboxThread[] {
  const seen = new Set(threads.map((thread) => thread.id));
  const extras = drafts
    .filter((draft) => !seen.has(draft.thread_id))
    .map((draft): InboxThread => ({
      id: draft.thread_id,
      source: draft.channel,
      channel: draft.channel,
      channel_label: draft.channel_label,
      label: "New conversation",
      can_send: draft.can_send,
      await_reply: draft.await_reply === true,
      list_title: normalizeListTitle(draft.list_title),
      title: draft.title ?? null,
      conversation_label: null,
      conversation_kind: null,
      pinned: draft.pinned === true,
      opened_at: draft.opened_at,
      messages: [],
      prompts: [],
      unread: false,
      unread_count: 0,
    }));
  return extras.length === 0 ? threads : [...extras, ...threads];
}
