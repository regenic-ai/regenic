import {
  DEFAULT_COPY_LOCALE,
  attentionOf,
  computeThreadUnread,
  isThreadStatusItem,
  latestForwardedTo,
  projectThreadFacet,
  recordClassFromType,
  threadIdOf,
  type ArrangementDecision,
  type AttentionClass,
  type AuthorityStore,
  type BlobStore,
  type ChannelDriverRegistry,
  type ConnectorInstallation,
  type ConversationPref,
  type CopyLocale,
  type EventRecord,
  type ForwardedFrom,
  type ListTitleMode,
  type MessageDirection,
  type MessageKind,
  type MessageReceipt,
  type RecordClass,
  type SyncStore,
  type ThreadActivity,
  type ThreadAttention,
  type ThreadFacet,
  type ThreadInboundCursor,
  type ThreadPrompt,
  type WorkFace,
} from "@regenic/domain";
import {
  resolveInboxBodies,
  resolveInboxBody,
  type InboxAttachment,
  type InboxBody,
} from "./inbox-body";
import type { WorkInboxFace } from "./personal-work-faces";
import { messageSurfaceOf, threadOf } from "./personal-inbox-surface";

export interface InboxViewItem {
  decision: ArrangementDecision;
  event: EventRecord;
  body_text?: string;
  media_type?: string;
  attachments?: InboxAttachment[];
  channel: string;
  channel_label: string;
  kind: MessageKind;
  direction: MessageDirection;
  can_send: boolean;
  await_reply: boolean;
  hold_while_working: boolean;
  list_title: ListTitleMode;
  thread_id: string;
  title: string | null;
  pinned: boolean;
  hidden: boolean;
  pref_updated_at: string | null;
  conversation_label: string | null;
  conversation_kind: string | null;
  unit_kind: string | null;
  unit_kind_label: string | null;
  actor_label: string | null;
  activity?: ThreadActivity;
  prompts: ThreadPrompt[];
  unread: boolean;
  unread_count: number;
  can_receipt: boolean;
  receipt?: MessageReceipt;
  record_class: RecordClass;
  thread_facet: ThreadFacet;
  attention: AttentionClass;
  work?: WorkFace;
  forwarded_from?: ForwardedFrom;
  forwarded_to?: ForwardedFrom;
}

export function decorateInboxItem(
  item: { decision: ArrangementDecision; event: EventRecord },
  body: Awaited<ReturnType<typeof resolveInboxBody>>,
  installations: ConnectorInstallation[],
  drivers: ChannelDriverRegistry,
  pref: ConversationPref | null,
  labels: ReadonlyMap<string, string> = new Map(),
  promptsByThread: ReadonlyMap<string, ThreadPrompt[]> = new Map(),
  attentionByThread: ReadonlyMap<string, ThreadAttention> = new Map(),
  inboundByThread: ReadonlyMap<string, ThreadInboundCursor> = new Map(),
  awaitingUser: ReadonlySet<string> = new Set(),
  receiptsByOutbound: ReadonlyMap<string, MessageReceipt> = new Map(),
  includeReceipts = true,
  workFace?: WorkInboxFace,
  locale: CopyLocale = DEFAULT_COPY_LOCALE,
): InboxViewItem {
  const surface = messageSurfaceOf(item.event, body);
  const thread = threadOf(item.event);
  const threadId = threadIdOf(thread);
  const prompts = promptsByThread.get(threadId) ?? [];
  const canReceipt = drivers.canReceipt(installations, thread);
  const attention = computeThreadUnread({
    source: attentionByThread.get(threadId),
    pref,
    latestInbound: inboundByThread.get(threadId),
    activity: awaitingUser.has(threadId) ? "awaiting_user" : surface.activity,
    prompts,
  });
  return {
    ...item,
    ...body,
    channel: surface.channel,
    channel_label: drivers.sourceLabel(surface.channel, process.env, locale),
    kind: surface.kind,
    direction: surface.direction,
    can_send: drivers.canSend(installations, thread),
    await_reply: drivers.awaitReply(installations, thread),
    hold_while_working: drivers.holdWhileWorking(installations, thread),
    list_title: drivers.listTitle(installations, thread),
    thread_id: threadId,
    title: pref?.title ?? null,
    pinned: pref?.pinned === true,
    hidden: pref?.hidden === true,
    pref_updated_at: pref?.updated_at ?? null,
    conversation_label:
      surface.conversation_label ?? labels.get(threadId) ?? null,
    conversation_kind: surface.conversation_kind ?? null,
    unit_kind: surface.unit_kind ?? null,
    unit_kind_label:
      drivers.unitKindLabel(surface.channel, surface.unit_kind, locale) ?? null,
    actor_label: surface.actor_label ?? null,
    activity: surface.activity,
    prompts,
    unread: attention.unread,
    unread_count: attention.unread_count ?? (attention.unread ? 1 : 0),
    can_receipt: canReceipt,
    receipt: includeReceipts
      ? outboundReceipt(
          surface.direction,
          item.event.external_id,
          canReceipt,
          receiptsByOutbound,
        )
      : undefined,
    record_class:
      workFace?.record_class ?? recordClassFromType(surface.type) ?? "utterance",
    thread_facet:
      workFace?.thread_facet ??
      projectThreadFacet({
        type: surface.type,
        prompts: prompts.length > 0,
        hint: surface.thread_facet,
      }),
    attention: attentionOf({
      prompts: prompts.length,
      awaiting_user:
        awaitingUser.has(threadId) || surface.activity === "awaiting_user",
      unread: attention.unread,
      work_status: workFace?.work?.status,
      can_write_back: workFace?.work?.can_write_back,
      has_result: workFace?.work?.has_result,
      activity: surface.activity,
    }),
    work: workFace?.work,
    ...(surface.forwarded_from
      ? { forwarded_from: labeledForwardTrace(surface.forwarded_from, drivers, locale) }
      : {}),
    ...(surface.forwarded_to
      ? { forwarded_to: labeledForwardTrace(surface.forwarded_to, drivers, locale) }
      : {}),
  };
}

function labeledForwardTrace(
  trace: ForwardedFrom,
  drivers: ChannelDriverRegistry,
  locale: CopyLocale = DEFAULT_COPY_LOCALE,
): ForwardedFrom {
  return {
    ...trace,
    channel_label: drivers.sourceLabel(trace.source, process.env, locale),
  };
}

export function projectForwardedTo(
  views: InboxViewItem[],
  drivers: ChannelDriverRegistry,
  locale: CopyLocale = DEFAULT_COPY_LOCALE,
): InboxViewItem[] {
  const traces = latestForwardedTo(
    views.flatMap((view) => {
      const trace = view.forwarded_to;
      if (!trace || trace.event_ids.includes(view.event.id)) {
        return [];
      }
      return [
        {
          id: view.event.id,
          occurred_at: view.event.occurred_at,
          forwarded_to: labeledForwardTrace(trace, drivers, locale),
        },
      ];
    }),
  );
  if (traces.size === 0) {
    return views;
  }
  return views.map((view) => {
    const joined = traces.get(view.event.id);
    if (!joined) {
      return view;
    }
    return { ...view, forwarded_to: joined };
  });
}

export async function loadForwardedToTraces(
  items: Array<{ decision: ArrangementDecision; event: EventRecord }>,
  knownBodies: ReadonlyMap<string, InboxBody>,
  authority: AuthorityStore,
  blobs: BlobStore,
  drivers: ChannelDriverRegistry,
  locale: CopyLocale = DEFAULT_COPY_LOCALE,
): Promise<Map<string, ForwardedFrom>> {
  const status = items.filter((item) => isThreadStatusItem(item));
  if (status.length === 0) {
    return new Map();
  }
  const missing = status
    .map((item) => item.event.content_hash)
    .filter((hash): hash is string => {
      if (!hash) {
        return false;
      }
      return !knownBodies.has(hash);
    });
  const extra =
    missing.length > 0
      ? await resolveInboxBodies(authority, blobs, missing, "meta")
      : new Map<string, InboxBody>();
  return latestForwardedTo(
    status.map((item) => {
      const hash = item.event.content_hash;
      const body = hash
        ? (knownBodies.get(hash) ?? extra.get(hash) ?? {})
        : {};
      const surface = messageSurfaceOf(item.event, body);
      return {
        id: item.event.id,
        occurred_at: item.event.occurred_at,
        forwarded_to: surface.forwarded_to
          ? labeledForwardTrace(surface.forwarded_to, drivers, locale)
          : undefined,
      };
    }),
  );
}

export async function conversationLabelsFor(
  items: Array<{
    item: { event: EventRecord };
    body: Awaited<ReturnType<typeof resolveInboxBody>>;
  }>,
  installations: ConnectorInstallation[],
  drivers: ChannelDriverRegistry,
  store?: Pick<SyncStore, "getSyncCatalog">,
): Promise<Map<string, string>> {
  const missing = items.flatMap(({ item, body }) => {
    const surface = messageSurfaceOf(item.event, body);
    return surface.conversation_label ? [] : [threadOf(item.event)];
  });
  if (missing.length === 0) {
    return new Map();
  }
  const labels = await catalogConversationLabels(installations, store);
  const stillMissing = missing.filter(
    (thread) => !labels.has(`${thread.source}:${thread.target}`),
  );
  if (stillMissing.length === 0) {
    return labels;
  }
  const live = await drivers.resolveConversationLabels(
    installations,
    stillMissing,
  );
  for (const [threadId, label] of live) {
    labels.set(threadId, label);
  }
  return labels;
}

async function catalogConversationLabels(
  installations: ConnectorInstallation[],
  store?: Pick<SyncStore, "getSyncCatalog">,
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  if (!store?.getSyncCatalog) {
    return labels;
  }
  await Promise.all(
    installations.map(async (installation) => {
      try {
        const catalog = await store.getSyncCatalog(installation.id);
        for (const member of catalog.members) {
          const label = member.label?.replace(/\s+/g, " ").trim();
          const threadId = member.thread_id?.trim();
          if (!label || !threadId) {
            continue;
          }
          labels.set(threadId, label);
        }
      } catch {
        // Catalog is optional. Drivers may still fill titles.
      }
    }),
  );
  return labels;
}

function outboundReceipt(
  direction: MessageDirection,
  externalId: string,
  canReceipt: boolean,
  receipts: ReadonlyMap<string, MessageReceipt>,
): MessageReceipt | undefined {
  if (direction !== "outbound") {
    return undefined;
  }
  return receipts.get(externalId) ?? (canReceipt ? { state: "sent" } : undefined);
}
