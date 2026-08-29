import type { InboxThread } from "./inbox.ts";
import {
  normalizeListTitle,
  type CreatedConversation,
  type ForwardView,
  type InboxViewItem,
  type PersonalEngineView,
} from "./types.ts";

export interface CreateTarget {
  id: string;
  channel: string;
  channel_label: string;
  label: string;
  create_with_task: boolean;
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
      create_with_task: item.create_with_task === true,
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

export function draftFromForward(result: ForwardView): CreatedConversation {
  return {
    thread_id: result.target_thread_id,
    channel: result.item.channel,
    channel_label: result.item.channel_label,
    can_send: result.item.can_send,
    await_reply: result.item.await_reply === true,
    hold_while_working: result.item.hold_while_working === true,
    list_title: normalizeListTitle(result.item.list_title),
    opened_at: new Date().toISOString(),
  };
}

export function localDraftConversation(target: CreateTarget): CreatedConversation {
  const id =
    globalThis.crypto && "randomUUID" in globalThis.crypto
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    thread_id: `draft:${target.id}:${id}`,
    channel: target.channel,
    channel_label: target.channel_label,
    can_send: true,
    await_reply: true,
    list_title: "prompt",
    hold_while_working: true,
    draft_installation_id: target.id,
    opened_at: new Date().toISOString(),
  };
}

export function localDraftOutbound(
  created: CreatedConversation,
  text: string,
): InboxViewItem {
  const now = new Date().toISOString();
  const colon = created.thread_id.indexOf(":");
  const target = colon >= 0 ? created.thread_id.slice(colon + 1) : created.thread_id;
  return {
    decision: {
      event_id: `local:${now}`,
      org_id: "local-owner",
      disposition: "current_work",
      layer: "L1_event",
      reason_codes: ["local"],
      score: 1,
      decided_at: now,
    },
    event: {
      id: `local:${now}`,
      org_id: "local-owner",
      source: created.channel,
      external_id: `${target}:out:local`,
      operation: "create",
      occurred_at: now,
      ingested_at: now,
    },
    body_text: text,
    attachments: [],
    channel: created.channel,
    channel_label: created.channel_label,
    kind: "user",
    direction: "outbound",
    can_send: created.can_send,
    await_reply: created.await_reply === true,
    hold_while_working: created.hold_while_working === true,
    list_title: normalizeListTitle(created.list_title),
  };
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
      hold_while_working: draft.hold_while_working === true,
      list_title: normalizeListTitle(draft.list_title),
      title: draft.title ?? null,
      conversation_label: null,
      conversation_kind: null,
      pinned: draft.pinned === true,
      hidden: false,
      opened_at: draft.opened_at,
      draft_installation_id: draft.draft_installation_id,
      messages: [],
      prompts: [],
      unread: false,
      unread_count: 0,
    }));
  return extras.length === 0 ? threads : [...extras, ...threads];
}
