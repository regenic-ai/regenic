import { Injectable } from "@nestjs/common";
import {
  ChannelDriverError,
  ChannelDriverRegistry,
  channelLabel,
  conversationId,
  inboxDigest,
  latestByThread,
  parseConversationThread,
  resolveMessageSurface,
  type ArrangementDecision,
  type ConnectorInstallation,
  type ConversationPref,
  type ConversationThread,
  type EventRecord,
  type InboxQuery,
  type MessageDirection,
  type MessageKind,
  type ThreadActivity,
} from "@regenic/domain";
import { resolveInboxBody, type InboxAttachment } from "./inbox-body";
import { PersonalConnectorError } from "./personal-errors";
import {
  connectorCatalog,
  toInstallationView,
  type ConnectorCatalogItem,
  type EngineInstallationView,
} from "./personal-connector-view";
import { pullStatus, type PullStatusView } from "./personal-pull-status";
import {
  PersonalKernelStoppedError,
  PersonalRuntimeService,
} from "./personal-runtime.service";

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
  thread_id: string;
  title: string | null;
  pinned: boolean;
  pref_updated_at: string | null;
  conversation_label: string | null;
  conversation_kind: string | null;
  actor_label: string | null;
  activity?: ThreadActivity;
}

export interface ConversationPrefView {
  thread_id: string;
  title: string | null;
  pinned: boolean;
  updated_at: string;
}

export interface ConversationPrefInput {
  thread_id?: string;
  title?: string | null;
  pinned?: boolean;
}

const MAX_TITLE_LENGTH = 120;

export type { EngineInstallationView } from "./personal-connector-view";

export interface PersonalEngineView {
  kernel: "running" | "stopped";
  org_id: string;
  database_path: string | null;
  inbox_count: number;
  inbox_digest: string;
  pull: PullStatusView;
  installations: EngineInstallationView[];
  catalog: ConnectorCatalogItem[];
}

export interface InboxListQuery {
  since?: string;
  since_id?: string;
  heads?: boolean;
  thread_id?: string;
}

export interface EngineQuery {
  detailed?: boolean;
}

@Injectable()
export class PersonalInboxService {
  constructor(
    private readonly runtime: PersonalRuntimeService,
    private readonly drivers: ChannelDriverRegistry,
  ) {}

  async listInbox(query: InboxListQuery = {}): Promise<InboxViewItem[]> {
    return this.loadThreadInbox(query);
  }

  async getInboxItem(eventId: string): Promise<InboxViewItem | null> {
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    const blobs = host.get("blobs");
    const orgId = this.runtime.orgId();
    const event = await authority.getEvent(orgId, eventId);
    if (!event) {
      return null;
    }
    const decision = await authority.getDisposition(eventId);
    if (!decision) {
      return null;
    }
    const threadId = conversationId(event.source, event.external_id, event.id);
    const [installations, pref] = await Promise.all([
      authority.listInstallations(orgId),
      authority.getConversationPref(orgId, threadId),
    ]);
    return decorateInboxItem(
      { decision, event },
      await resolveInboxBody(authority, blobs, event.content_hash),
      installations,
      this.drivers,
      pref,
    );
  }

  async getEngine(query: EngineQuery = {}): Promise<PersonalEngineView> {
    const detailed = query.detailed !== false;
    const options = this.runtime.getOptions();
    const orgId = this.runtime.orgId();
    const catalogReady = async (
      installations: EngineInstallationView[],
    ) => {
      if (!detailed) {
        return [];
      }
      const probed = await this.drivers.probeCatalog(process.env);
      return connectorCatalog(installations, {
        env: process.env,
        services: probed.services,
        field_options: probed.field_options,
      });
    };
    if (!this.runtime.isReady()) {
      return {
        kernel: "stopped",
        org_id: orgId,
        database_path: options?.database ?? null,
        inbox_count: 0,
        inbox_digest: inboxDigest([]),
        pull: { ...pullStatus },
        installations: [],
        catalog: await catalogReady([]),
      };
    }
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    const [inbox, installations] = await Promise.all([
      authority.summarizeInbox(orgId),
      authority.listInstallations(orgId),
    ]);
    const views = await Promise.all(
      installations.map(async (installation) => {
        const attempts = detailed
          ? await authority.listAttempts(installation.id)
          : [];
        return toInstallationView(
          installation,
          attempts[0] ?? null,
          this.drivers,
        );
      }),
    );
    return {
      kernel: "running",
      org_id: orgId,
      database_path: options?.database ?? null,
      inbox_count: inbox.count,
      inbox_digest: inbox.digest,
      pull: { ...pullStatus },
      installations: views,
      catalog: await catalogReady(views),
    };
  }

  private async loadThreadInbox(
    query: InboxListQuery = {},
  ): Promise<InboxViewItem[]> {
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    const blobs = host.get("blobs");
    const orgId = this.runtime.orgId();
    const thread = parseThreadQuery(query.thread_id);
    const storeQuery = inboxStoreQuery(query, thread);
    const [records, installations, prefs] = await Promise.all([
      authority.listInbox(orgId, storeQuery),
      authority.listInstallations(orgId),
      thread
        ? authority
            .getConversationPref(orgId, query.thread_id ?? "")
            .then((pref) => (pref ? [pref] : []))
        : authority.listConversationPrefs(orgId),
    ]);
    const prefsByThread = new Map(
      prefs.map((pref) => [pref.thread_id, pref] as const),
    );
    const selected = selectInboxRecords(records, query);
    const attachments = query.heads ? "meta" : "preview";
    return Promise.all(
      selected.map(async (item) => {
        const threadId = conversationId(
          item.event.source,
          item.event.external_id,
          item.event.id,
        );
        return decorateInboxItem(
          item,
          await resolveInboxBody(
            authority,
            blobs,
            item.event.content_hash,
            attachments,
          ),
          installations,
          this.drivers,
          prefsByThread.get(threadId) ?? null,
        );
      }),
    );
  }

  async updateConversationPrefs(
    input: ConversationPrefInput,
  ): Promise<ConversationPrefView> {
    const host = this.runtime.requireHost();
    const threadId = input.thread_id?.trim() ?? "";
    try {
      parseConversationThread(threadId);
    } catch (error) {
      const message =
        error instanceof ChannelDriverError
          ? error.message
          : "thread_id must look like source:target";
      throw new PersonalConnectorError("invalid_config", message, 400);
    }
    if (input.title === undefined && input.pinned === undefined) {
      throw new PersonalConnectorError(
        "invalid_config",
        "title or pinned is required",
        400,
      );
    }
    const pref = await host.get("authority").putConversationPref({
      org_id: this.runtime.orgId(),
      thread_id: threadId,
      title: input.title !== undefined ? normalizeTitle(input.title) : undefined,
      pinned: input.pinned,
      updated_at: new Date().toISOString(),
    });
    return toPrefView(pref);
  }
}

function decorateInboxItem(
  item: { decision: ArrangementDecision; event: EventRecord },
  body: Awaited<ReturnType<typeof resolveInboxBody>>,
  installations: ConnectorInstallation[],
  drivers: ChannelDriverRegistry,
  pref: ConversationPref | null,
): InboxViewItem {
  const surface = resolveMessageSurface({
    source: item.event.source,
    external_id: item.event.external_id,
    body_text: body.body_text,
    stored: body.surface,
  });
  const thread = threadOf(item.event);
  const threadId = `${thread.source}:${thread.target}`;
  return {
    ...item,
    ...body,
    channel: surface.channel,
    channel_label: channelLabel(surface.channel),
    kind: surface.kind,
    direction: surface.direction,
    can_send: drivers.canSend(installations, thread),
    await_reply: drivers.awaitReply(installations, thread),
    thread_id: threadId,
    title: pref?.title ?? null,
    pinned: pref?.pinned === true,
    pref_updated_at: pref?.updated_at ?? null,
    conversation_label: surface.conversation_label ?? null,
    conversation_kind: surface.conversation_kind ?? null,
    actor_label: surface.actor_label ?? null,
    activity: surface.activity,
  };
}

function parseThreadQuery(
  threadId: string | undefined,
): ConversationThread | undefined {
  if (!threadId?.trim()) {
    return undefined;
  }
  try {
    return parseConversationThread(threadId);
  } catch {
    return undefined;
  }
}

export function selectInboxRecords<T extends { event: EventRecord }>(
  items: T[],
  query: InboxListQuery,
): T[] {
  let selected = items;
  if (query.thread_id) {
    selected = selected.filter(
      (item) =>
        conversationId(item.event.source, item.event.external_id, item.event.id) ===
        query.thread_id,
    );
  }
  if (query.since) {
    selected = selected.filter((item) =>
      isAfterCursor(item.event, query.since ?? "", query.since_id ?? ""),
    );
  }
  if (query.heads) {
    selected = latestByThread(selected);
  }
  return selected;
}

export function isAfterCursor(
  event: { id: string; ingested_at: string },
  since: string,
  sinceId: string,
): boolean {
  if (event.ingested_at > since) {
    return true;
  }
  return event.ingested_at === since && event.id > sinceId;
}

function inboxStoreQuery(
  query: InboxListQuery,
  thread?: ConversationThread,
): InboxQuery {
  if (query.heads) {
    return thread
      ? {
          heads: true,
          thread_ids: [`${thread.source}:${thread.target}`],
        }
      : { heads: true };
  }
  return {
    source: thread?.source,
    target: thread?.target,
    since: query.since,
    since_id: query.since_id,
    siblings: true,
  };
}

export function inboxFingerprint(
  items: Array<{ event: { id: string; ingested_at: string } }>,
): string {
  return inboxDigest(items);
}

function normalizeTitle(value: string | null): string | null {
  const title = (value ?? "").replace(/\s+/g, " ").trim();
  if (title.length === 0) {
    return null;
  }
  return title.length > MAX_TITLE_LENGTH
    ? title.slice(0, MAX_TITLE_LENGTH)
    : title;
}

function toPrefView(pref: ConversationPref): ConversationPrefView {
  return {
    thread_id: pref.thread_id,
    title: pref.title,
    pinned: pref.pinned,
    updated_at: pref.updated_at,
  };
}

function threadOf(event: EventRecord): ConversationThread {
  const id = conversationId(event.source, event.external_id, event.id);
  try {
    return parseConversationThread(id);
  } catch {
    return { source: event.source, target: event.external_id };
  }
}

export { PersonalKernelStoppedError };
