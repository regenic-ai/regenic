import type { ArrangementDecision, InboxItem } from "./arrangement";
import type {
  ConversationPref,
  ConversationPrefPatch,
  EventRecord,
  InboxQuery,
} from "./ingestion";
import { conversationId } from "./message-contract";

export const INBOX_LIST_VIEWS = ["shown", "hidden"] as const;

export type InboxListView = (typeof INBOX_LIST_VIEWS)[number];

export const HIDDEN_REASONS = ["human", "policy"] as const;

export type HiddenReason = (typeof HIDDEN_REASONS)[number];

export const INBOX_LIST_PREF_KEY = "inbox_list";
/** @deprecated Read-only alias. Old `done` maps to `hidden`. */
export const INBOX_MEMBERSHIP_PREF_KEY = "inbox_membership";

export function normalizeInboxListView(value: unknown): InboxListView {
  if (value === "hidden" || value === "done") {
    return "hidden";
  }
  return "shown";
}

export function normalizeHiddenReason(value: unknown): HiddenReason | null {
  return value === "human" || value === "policy" ? value : null;
}

export function effectiveHiddenReason(input: {
  hidden: boolean;
  reason?: HiddenReason | null;
}): HiddenReason | null {
  if (!input.hidden) {
    return null;
  }
  return input.reason === "policy" ? "policy" : "human";
}

export function foldByHuman(): { hidden: true; reason: HiddenReason } {
  return { hidden: true, reason: "human" };
}

export function unfold(): { hidden: false; reason: null } {
  return { hidden: false, reason: null };
}

export function foldByPolicy(input: {
  hidden: boolean;
  reason?: HiddenReason | null;
}): { hidden: true; reason: HiddenReason } | undefined {
  if (effectiveHiddenReason(input) === "human") {
    return undefined;
  }
  if (input.hidden && input.reason === "policy") {
    return undefined;
  }
  return { hidden: true, reason: "policy" };
}

/**
 * Ingest-time fold. Connectors never call this.
 * Human folds stay put. Policy folds reopen when new desk work arrives.
 * A tombstone that leaves the thread off the desk folds it by policy.
 */
export function nextHiddenPref(input: {
  hidden: boolean;
  reason?: HiddenReason | null;
  onDesk: boolean;
  acceptedCurrentWork: boolean;
  acceptedTombstone: boolean;
}): { hidden: boolean; reason: HiddenReason | null } | undefined {
  const reason = effectiveHiddenReason(input);
  if (reason === "human") {
    return undefined;
  }
  if (input.acceptedCurrentWork && input.hidden && reason === "policy") {
    return unfold();
  }
  if (!input.hidden && !input.onDesk && input.acceptedTombstone) {
    return { hidden: true, reason: "policy" };
  }
  return undefined;
}

export interface ListSurfaceStore {
  getEvent(orgId: string, eventId: string): Promise<EventRecord | null>;
  getDisposition(eventId: string): Promise<ArrangementDecision | null>;
  getConversationPref(
    orgId: string,
    threadId: string,
  ): Promise<ConversationPref | null>;
  putConversationPref(input: ConversationPrefPatch): Promise<ConversationPref>;
  listInbox(orgId: string, query?: InboxQuery): Promise<InboxItem[]>;
}

export async function writeHiddenPref(
  store: Pick<ListSurfaceStore, "getConversationPref" | "putConversationPref">,
  orgId: string,
  threadId: string,
  next: { hidden: boolean; reason: HiddenReason | null },
  now: string,
): Promise<void> {
  const pref = await store.getConversationPref(orgId, threadId);
  const currentReason = effectiveHiddenReason({
    hidden: pref?.hidden === true,
    reason: pref?.hidden_reason,
  });
  const nextReason = next.hidden ? next.reason : null;
  if (pref?.hidden === next.hidden && currentReason === nextReason) {
    return;
  }
  await store.putConversationPref({
    org_id: orgId,
    thread_id: threadId,
    hidden: next.hidden,
    hidden_reason: nextReason,
    updated_at: now,
  });
}

export async function foldThreadByPolicy(
  store: Pick<ListSurfaceStore, "getConversationPref" | "putConversationPref">,
  orgId: string,
  threadId: string,
  now: string,
): Promise<void> {
  const pref = await store.getConversationPref(orgId, threadId);
  const next = foldByPolicy({
    hidden: pref?.hidden === true,
    reason: pref?.hidden_reason,
  });
  if (!next) {
    return;
  }
  await writeHiddenPref(store, orgId, threadId, next, now);
}

export function listSurfacePatches(input: {
  orgId: string;
  now: string;
  events: readonly EventRecord[];
  dispositions: ReadonlyMap<string, ArrangementDecision | null>;
  prefs: ReadonlyMap<string, ConversationPref | null>;
  onDesk: ReadonlyMap<string, boolean>;
}): ConversationPrefPatch[] {
  const byThread = new Map<string, EventRecord[]>();
  for (const event of input.events) {
    const threadId = conversationId(event.source, event.external_id, event.id);
    const bucket = byThread.get(threadId);
    if (bucket) {
      bucket.push(event);
    } else {
      byThread.set(threadId, [event]);
    }
  }
  const patches: ConversationPrefPatch[] = [];
  for (const [threadId, threadEvents] of byThread) {
    let acceptedCurrentWork = false;
    let acceptedTombstone = false;
    for (const event of threadEvents) {
      if (event.operation === "tombstone") {
        acceptedTombstone = true;
      }
      if (input.dispositions.get(event.id)?.disposition === "current_work") {
        acceptedCurrentWork = true;
      }
    }
    const pref = input.prefs.get(threadId) ?? null;
    const next = nextHiddenPref({
      hidden: pref?.hidden === true,
      reason: pref?.hidden_reason,
      onDesk: input.onDesk.get(threadId) === true,
      acceptedCurrentWork,
      acceptedTombstone,
    });
    if (!next) {
      continue;
    }
    const currentReason = effectiveHiddenReason({
      hidden: pref?.hidden === true,
      reason: pref?.hidden_reason,
    });
    const nextReason = next.hidden ? next.reason : null;
    if (pref?.hidden === next.hidden && currentReason === nextReason) {
      continue;
    }
    patches.push({
      org_id: input.orgId,
      thread_id: threadId,
      hidden: next.hidden,
      hidden_reason: nextReason,
      updated_at: input.now,
    });
  }
  return patches;
}

export async function collectListSurfacePatches(
  store: ListSurfaceStore,
  orgId: string,
  eventIds: readonly string[],
  known: {
    events?: readonly EventRecord[];
    dispositions?: readonly ArrangementDecision[];
    now?: string;
  } = {},
): Promise<ConversationPrefPatch[]> {
  if (eventIds.length === 0) {
    return [];
  }
  const now = known.now ?? new Date().toISOString();
  const knownEvents = new Map(
    (known.events ?? []).map((event) => [event.id, event]),
  );
  const knownDispositions = new Map(
    (known.dispositions ?? []).map((decision) => [decision.event_id, decision]),
  );
  const events: EventRecord[] = [];
  const dispositions = new Map<string, ArrangementDecision | null>();
  for (const id of eventIds) {
    const event = knownEvents.get(id) ?? (await store.getEvent(orgId, id));
    if (!event) {
      continue;
    }
    events.push(event);
    dispositions.set(
      id,
      knownDispositions.get(id) ?? (await store.getDisposition(id)),
    );
  }
  const byThread = new Map<string, EventRecord[]>();
  for (const event of events) {
    const threadId = conversationId(event.source, event.external_id, event.id);
    const bucket = byThread.get(threadId);
    if (bucket) {
      bucket.push(event);
    } else {
      byThread.set(threadId, [event]);
    }
  }
  const prefs = new Map<string, ConversationPref | null>();
  const onDesk = new Map<string, boolean>();
  const needsOnDesk = events.some((event) => event.operation === "tombstone");
  for (const threadId of byThread.keys()) {
    prefs.set(threadId, await store.getConversationPref(orgId, threadId));
    onDesk.set(
      threadId,
      needsOnDesk
        ? (await store.listInbox(orgId, { thread_ids: [threadId] })).length > 0
        : false,
    );
  }
  return listSurfacePatches({
    orgId,
    now,
    events,
    dispositions,
    prefs,
    onDesk,
  });
}

export async function applyListSurfaceAfterIngest(
  store: ListSurfaceStore,
  orgId: string,
  eventIds: readonly string[],
): Promise<void> {
  const patches = await collectListSurfacePatches(store, orgId, eventIds);
  for (const patch of patches) {
    await store.putConversationPref(patch);
  }
}
