import { Injectable } from "@nestjs/common";
import {
  ChannelDriverError,
  ChannelDriverRegistry,
  channelLabel,
  conversationId,
  inboxDigest,
  headsByThread,
  isThreadStatusItem,
  parseConversationThread,
  takeRecentInboxItems,
  normalizeInboxLimit,
  resolveMessageSurface,
  type ArrangementDecision,
  type AuthorityStore,
  type BlobStore,
  type ConnectorInstallation,
  type ConversationPref,
  type ConversationThread,
  type EventRecord,
  type InboxItem,
  type InboxQuery,
  type ListTitleMode,
  type MessageDirection,
  type MessageKind,
  type ThreadActivity,
} from "@regenic/domain";
import { resolveInboxBody, type InboxAttachment, type InboxBody } from "./inbox-body";
import { PersonalConnectorError } from "./personal-errors";
import {
  connectorCatalog,
  toInstallationView,
  type ConnectorCatalogItem,
  type EngineInstallationView,
} from "./personal-connector-view";
import { preferThread, pullStatus, type PullStatusView } from "./personal-pull-status";
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
  list_title: ListTitleMode;
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
  before?: string;
  before_id?: string;
  heads?: boolean;
  thread_id?: string;
  limit?: number;
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
    return this.loadThreadInbox({
      ...query,
      limit: normalizeInboxLimit(query.limit),
    });
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
    const body = await resolveInboxBody(authority, blobs, event.content_hash);
    const item = { decision, event };
    const labels = await conversationLabelsFor(
      [{ item, body }],
      installations,
      this.drivers,
    );
    return decorateInboxItem(item, body, installations, this.drivers, pref, labels);
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
    if (query.thread_id) {
      preferThread(query.thread_id);
    }
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
    const resolved = await Promise.all(
      selected.map(async (item) => {
        const threadId = conversationId(
          item.event.source,
          item.event.external_id,
          item.event.id,
        );
        return {
          item,
          threadId,
          body: await resolveListBody(
            authority,
            blobs,
            item.event.content_hash,
            attachments,
            query.heads === true,
          ),
        };
      }),
    );
    const labels = await conversationLabelsFor(
      resolved,
      installations,
      this.drivers,
    );
    const prompts = await promptLabelsFor(
      orgId,
      resolved,
      installations,
      this.drivers,
      authority,
      blobs,
      query.heads === true,
    );
    return resolved.map(({ item, threadId, body }) => {
      const view = decorateInboxItem(
        item,
        body,
        installations,
        this.drivers,
        prefsByThread.get(threadId) ?? null,
        labels,
      );
      const prompt = prompts.get(threadId);
      const titled =
        view.list_title === "prompt" && prompt
          ? { ...view, conversation_label: prompt }
          : view;
      if (query.heads === true) {
        return trimInboxHead(titled);
      }
      return titled;
    });
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

const LIST_FACE_MAX = 120;

async function resolveListBody(
  authority: Parameters<typeof resolveInboxBody>[0],
  blobs: Parameters<typeof resolveInboxBody>[1],
  contentHash: string | undefined,
  attachments: Parameters<typeof resolveInboxBody>[3],
  heads: boolean,
): Promise<InboxBody> {
  const body = await resolveInboxBody(
    authority,
    blobs,
    contentHash,
    attachments,
  );
  if (!heads) {
    return body;
  }
  return {
    media_type: body.media_type,
    surface: body.surface,
    body_text: listFaceText(body.body_text),
  };
}

function listFaceText(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) {
    return undefined;
  }
  return line.length > LIST_FACE_MAX
    ? `${line.slice(0, LIST_FACE_MAX - 1)}…`
    : line;
}

function decorateInboxItem(
  item: { decision: ArrangementDecision; event: EventRecord },
  body: Awaited<ReturnType<typeof resolveInboxBody>>,
  installations: ConnectorInstallation[],
  drivers: ChannelDriverRegistry,
  pref: ConversationPref | null,
  labels: ReadonlyMap<string, string> = new Map(),
): InboxViewItem {
  const surface = messageSurfaceOf(item.event, body);
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
    list_title: drivers.listTitle(installations, thread),
    thread_id: threadId,
    title: pref?.title ?? null,
    pinned: pref?.pinned === true,
    pref_updated_at: pref?.updated_at ?? null,
    conversation_label:
      surface.conversation_label ?? labels.get(threadId) ?? null,
    conversation_kind: surface.conversation_kind ?? null,
    actor_label: surface.actor_label ?? null,
    activity: surface.activity,
  };
}

async function conversationLabelsFor(
  items: Array<{
    item: { event: EventRecord };
    body: Awaited<ReturnType<typeof resolveInboxBody>>;
  }>,
  installations: ConnectorInstallation[],
  drivers: ChannelDriverRegistry,
): Promise<Map<string, string>> {
  const missing = items.flatMap(({ item, body }) => {
    const surface = messageSurfaceOf(item.event, body);
    return surface.conversation_label ? [] : [threadOf(item.event)];
  });
  if (missing.length === 0) {
    return new Map();
  }
  return drivers.resolveConversationLabels(installations, missing);
}

const PROMPT_USER_SCAN_LIMIT = 24;
const PROMPT_READ_LIMIT = 128;

async function promptLabelsFor(
  orgId: string,
  resolved: Array<{
    item: { event: EventRecord };
    threadId: string;
    body: InboxBody;
  }>,
  installations: ConnectorInstallation[],
  drivers: ChannelDriverRegistry,
  authority: AuthorityStore,
  blobs: BlobStore,
  heads: boolean,
): Promise<Map<string, string>> {
  const promptIds = [
    ...new Set(
      resolved
        .filter(
          ({ item }) =>
            drivers.listTitle(installations, threadOf(item.event)) === "prompt",
        )
        .map(({ threadId }) => threadId),
    ),
  ];
  if (promptIds.length === 0) {
    return new Map();
  }
  if (!heads) {
    return firstUserLabelsFrom(resolved);
  }
  const siblings = await authority.listInbox(orgId, {
    siblings: true,
    thread_ids: promptIds,
  });
  const groups = new Map<string, InboxItem[]>();
  for (const item of siblings) {
    const id = conversationId(
      item.event.source,
      item.event.external_id,
      item.event.id,
    );
    const bucket = groups.get(id);
    if (bucket) {
      bucket.push(item);
    } else {
      groups.set(id, [item]);
    }
  }
  const labels = new Map<string, string>();
  await Promise.all(
    promptIds.map(async (threadId) => {
      const text = await firstUserTextIn(
        (groups.get(threadId) ?? []).slice().sort(byEventTime),
        resolved,
        authority,
        blobs,
      );
      if (text) {
        labels.set(threadId, text);
      }
    }),
  );
  return labels;
}

function firstUserLabelsFrom(
  resolved: Array<{
    item: { event: EventRecord };
    threadId: string;
    body: InboxBody;
  }>,
): Map<string, string> {
  const best = new Map<string, { text: string; at: string; id: string }>();
  for (const row of resolved) {
    const surface = messageSurfaceOf(row.item.event, row.body);
    const text = listFaceText(row.body.body_text);
    if (surface.kind !== "user" || !text) {
      continue;
    }
    const current = best.get(row.threadId);
    if (
      !current ||
      row.item.event.occurred_at < current.at ||
      (row.item.event.occurred_at === current.at &&
        row.item.event.id < current.id)
    ) {
      best.set(row.threadId, {
        text,
        at: row.item.event.occurred_at,
        id: row.item.event.id,
      });
    }
  }
  return new Map([...best].map(([id, value]) => [id, value.text]));
}

async function firstUserTextIn(
  items: InboxItem[],
  resolved: Array<{
    item: { event: EventRecord };
    body: InboxBody;
  }>,
  authority: AuthorityStore,
  blobs: BlobStore,
): Promise<string | undefined> {
  let reads = 0;
  let users = 0;
  for (const item of items) {
    if (isThreadStatusItem(item) || item.event.operation === "tombstone") {
      continue;
    }
    reads += 1;
    if (reads > PROMPT_READ_LIMIT) {
      break;
    }
    const cached = resolved.find((row) => row.item.event.id === item.event.id);
    const body =
      cached?.body ??
      (await resolveInboxBody(
        authority,
        blobs,
        item.event.content_hash,
        "meta",
      ));
    const surface = messageSurfaceOf(item.event, body);
    if (surface.kind !== "user") {
      continue;
    }
    users += 1;
    if (users > PROMPT_USER_SCAN_LIMIT) {
      break;
    }
    const text = listFaceText(body.body_text);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function byEventTime(
  left: { event: EventRecord },
  right: { event: EventRecord },
): number {
  if (left.event.occurred_at !== right.event.occurred_at) {
    return left.event.occurred_at < right.event.occurred_at ? -1 : 1;
  }
  return left.event.id < right.event.id ? -1 : 1;
}

function messageSurfaceOf(
  event: EventRecord,
  body: Awaited<ReturnType<typeof resolveInboxBody>>,
) {
  return resolveMessageSurface({
    source: event.source,
    external_id: event.external_id,
    body_text: body.body_text,
    stored: body.surface,
  });
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
    selected = headsByThread(selected);
  }
  return takeRecentInboxItems(selected, query);
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
    before: query.before,
    before_id: query.before_id,
    limit: query.limit,
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

export function trimInboxHead<T extends {
  list_title?: string;
  conversation_label?: string | null;
  body_text?: string;
  attachments?: InboxAttachment[];
}>(item: T): T {
  if (item.list_title === "prompt" && item.conversation_label) {
    return { ...item, body_text: undefined, attachments: undefined };
  }
  return { ...item, attachments: undefined };
}

export { PersonalKernelStoppedError };
