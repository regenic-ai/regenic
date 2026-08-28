import { Inject, Injectable, forwardRef } from "@nestjs/common";
import {
  ChannelDriverError,
  ChannelDriverRegistry,
  attentionOf,
  collectLatestInbound,
  computeThreadUnread,
  conversationId,
  inboxDigest,
  isExecutorSysoutBody,
  headsByThread,
  isLocalOutboundId,
  isThreadStatusItem,
  parseConversationThread,
  projectThreadFacet,
  recordClassFromType,
  takeRecentInboxItems,
  normalizeInboxLimit,
  resolveMessageSurface,
  threadIdOf,
  withSurfaceGeneration,
  type ArrangementDecision,
  type AttentionClass,
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
  type PromptAnswer,
  type MessageReceipt,
  type RecordClass,
  type ThreadActivity,
  type ThreadAttention,
  type ThreadAttentionQuery,
  type ThreadFacet,
  type ThreadInboundCursor,
  type ThreadInboundScan,
  type ThreadPrompt,
  type ThreadReceiptQuery,
  type WorkFace,
} from "@regenic/domain";
import {
  resolveInboxBodies,
  resolveInboxBody,
  type InboxAttachment,
  type InboxBody,
} from "./inbox-body";
import { PersonalConnectorError } from "./personal-errors";
import {
  connectorCatalog,
  catalogFromDrivers,
  toInstallationView,
  type ConnectorCatalogItem,
  type EngineInstallationView,
} from "./personal-connector-view";
import { preferThread, pullStatus, type PullStatusView } from "./personal-pull-status";
import { processMemoryView } from "./process-memory";
import {
  PersonalKernelStoppedError,
  PersonalRuntimeService,
} from "./personal-runtime.service";
import {
  PersonalExecutorService,
  type EngineExecutorView,
  type ExecutorKindCatalogItem,
} from "./personal-executor.service";
import { PersonalWorkService, type WorkInboxFace } from "./personal-work.service";

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
  prompts: ThreadPrompt[];
  unread: boolean;
  unread_count: number;
  can_receipt: boolean;
  receipt?: MessageReceipt;
  record_class: RecordClass;
  thread_facet: ThreadFacet;
  attention: AttentionClass;
  work?: WorkFace;
}

export interface ConversationPrefView {
  thread_id: string;
  title: string | null;
  pinned: boolean;
  last_read_at: string | null;
  last_read_external_id: string | null;
  updated_at: string;
}

export interface ConversationPrefInput {
  thread_id?: string;
  title?: string | null;
  pinned?: boolean;
}

export interface ConversationAttentionInput {
  thread_id?: string;
  last_read_at?: string | null;
  last_read_external_id?: string | null;
}

export interface ConversationPromptInput {
  thread_id?: string;
  prompt_id?: string;
  answers?: Array<{ id?: string; selected?: string[]; custom?: string }>;
}

const MAX_TITLE_LENGTH = 120;

export type { EngineInstallationView } from "./personal-connector-view";

export interface PersonalEngineView {
  kernel: "running" | "stopped";
  org_id: string;
  database_path: string | null;
  inbox_count: number;
  inbox_digest: string;
  memory: { rss_bytes: number; heap_used_bytes: number };
  pull: PullStatusView;
  installations: EngineInstallationView[];
  catalog: ConnectorCatalogItem[];
  executor_installations: EngineExecutorView[];
  executor_catalog: ExecutorKindCatalogItem[];
}

export interface InboxListQuery {
  since?: string;
  since_id?: string;
  before?: string;
  before_id?: string;
  heads?: boolean;
  live?: boolean;
  thread_id?: string;
  limit?: number;
}

export function shouldSkipLiveChannelOverlays(query: InboxListQuery): boolean {
  // Feishu read_users only on `live=1`. Heads still need read_status for list
  // dots. Open, since, and older pages stay on SQLite so switching chats does
  // not wait on lark-cli.
  if (query.live || query.heads) {
    return false;
  }
  return Boolean(query.thread_id);
}

export interface EngineQuery {
  detailed?: boolean;
}

export interface StoreView {
  events: number;
  conversations: number;
  work_items: number;
  blobs: number;
  recipes: number;
  connectors: number;
  executors: number;
}

export interface StoreClearView {
  cleared: {
    events: number;
    conversations: number;
    work_items: number;
    blobs: number;
  };
  kept: {
    recipes: number;
    connectors: number;
    executors: number;
  };
}

@Injectable()
export class PersonalInboxService {
  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
    @Inject(ChannelDriverRegistry)
    private readonly drivers: ChannelDriverRegistry,
    @Inject(forwardRef(() => PersonalWorkService))
    private readonly work: PersonalWorkService,
    @Inject(forwardRef(() => PersonalExecutorService))
    private readonly executors: PersonalExecutorService,
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
    const thread = threadOf(event);
    const siblings = await authority.listInbox(orgId, {
      siblings: true,
      thread_ids: [threadId],
    });
    const inboundByThread = await latestInboundByThread(
      [item],
      siblings,
      new Map([[event.id, body]]),
      authority,
      blobs,
    );
    const [prompts, attention, receipts, bound] = await Promise.all([
      this.drivers.listPromptsForThreads(installations, [thread], host),
      this.drivers.readAttention(
        installations,
        withInboundHint([thread], inboundByThread),
        host,
      ),
      this.drivers.readReceipts(
        installations,
        receiptQueriesOf([{ item, threadId, body }]),
        host,
      ),
      this.work.boundPromptThreads(),
    ]);
    const agentId = bound.get(threadId);
    if (agentId) {
      try {
        const extra = await this.drivers.listPromptsForThreads(
          installations,
          [parseConversationThread(agentId)],
          host,
        );
        mergePromptMap(prompts, extra, threadId, agentId);
      } catch {
        // Bound executor prompts stay optional. The source row still renders.
      }
    }
    const faces = await this.work.inboxFaces([threadId], prompts);
    return decorateInboxItem(
      item,
      body,
      installations,
      this.drivers,
      pref,
      labels,
      prompts,
      attention,
      inboundByThread,
      new Set(),
      receipts,
      true,
      faces.get(threadId),
    );
  }

  async getEngine(query: EngineQuery = {}): Promise<PersonalEngineView> {
    const detailed = query.detailed !== false;
    const options = this.runtime.getOptions();
    const orgId = this.runtime.orgId();
    const catalogReady = async (
      installations: EngineInstallationView[],
    ) => {
      const extras = catalogFromDrivers(this.drivers, process.env);
      if (!detailed) {
        return connectorCatalog(installations, {
          env: process.env,
          extras,
        });
      }
      const probed = await this.drivers.probeCatalog(process.env);
      return connectorCatalog(installations, {
        env: process.env,
        services: probed.services,
        field_options: probed.field_options,
        extras,
      });
    };
    if (!this.runtime.isReady()) {
      const executorCatalog = this.executors.kindCatalog([], []);
      return {
        kernel: "stopped",
        org_id: orgId,
        database_path: options?.database ?? null,
        inbox_count: 0,
        inbox_digest: withSurfaceGeneration(inboxDigest([]), ""),
        memory: processMemoryView(),
        pull: { ...pullStatus },
        installations: [],
        catalog: await catalogReady([]),
        executor_installations: [],
        executor_catalog: executorCatalog,
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
        const attempt = detailed
          ? await authority.latestAttempt(installation.id)
          : null;
        return toInstallationView(
          installation,
          attempt,
          this.drivers,
        );
      }),
    );
    const [executorInstallations, connectorOptions] = await Promise.all([
      this.executors.listViews(),
      this.executors.creatableConnectorOptions(),
    ]);
    return {
      kernel: "running",
      org_id: orgId,
      database_path: options?.database ?? null,
      inbox_count: inbox.count,
      inbox_digest: withSurfaceGeneration(
        inbox.digest,
        this.drivers.surfaceGeneration(installations, host),
      ),
      memory: processMemoryView(),
      pull: { ...pullStatus },
      installations: views,
      catalog: await catalogReady(views),
      executor_installations: executorInstallations,
      executor_catalog: this.executors.kindCatalog(
        executorInstallations,
        connectorOptions,
      ),
    };
  }

  async getStore(): Promise<StoreView> {
    const host = this.runtime.requireHost();
    return host.get("authority").summarizeStore(this.runtime.orgId());
  }

  async clearStore(): Promise<StoreClearView> {
    const host = this.runtime.requireHost();
    const result = await host
      .get("authority")
      .clearOperationalData(this.runtime.orgId(), new Date().toISOString());
    try {
      await host.get("blobs").clear();
    } catch (error) {
      console.error("blob store clear leftover files", error);
    }
    return result;
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
    const [records, installations, prefs, jobSessions] = await Promise.all([
      authority.listInbox(orgId, storeQuery),
      authority.listInstallations(orgId),
      thread
        ? authority
            .getConversationPref(orgId, query.thread_id ?? "")
            .then((pref) => (pref ? [pref] : []))
        : authority.listConversationPrefs(orgId),
      query.heads === true && !query.thread_id
        ? this.work.activeSessionIds()
        : Promise.resolve(new Set<string>()),
    ]);
    const prefsByThread = new Map(
      prefs.map((pref) => [pref.thread_id, pref] as const),
    );
    let selected = selectInboxRecords(records, query);
    if (jobSessions.size > 0) {
      const have = new Set(
        selected.map((item) =>
          conversationId(item.event.source, item.event.external_id, item.event.id),
        ),
      );
      const missing = [...jobSessions].filter((id) => !have.has(id));
      if (missing.length > 0) {
        const extras = await authority.listInbox(orgId, {
          siblings: true,
          thread_ids: missing,
        });
        selected = [...selected, ...headsByThread(extras)];
      }
    }
    const attachments = query.heads ? "meta" : "preview";
    const bodies = await resolveInboxBodies(
      authority,
      blobs,
      selected.map((item) => item.event.content_hash),
      attachments,
    );
    const resolved = selected.map((item) => {
      const threadId = conversationId(
        item.event.source,
        item.event.external_id,
        item.event.id,
      );
      const raw = item.event.content_hash
        ? (bodies.get(item.event.content_hash) ?? {})
        : {};
      return {
        item,
        threadId,
        body: query.heads === true ? listFaceBody(raw) : raw,
      };
    });
    const labels = await conversationLabelsFor(
      resolved,
      installations,
      this.drivers,
    );
    const threads = [
      ...new Map(
        resolved.map(({ item }) => {
          const thread = threadOf(item.event);
          return [threadIdOf(thread), thread] as const;
        }),
      ).values(),
    ];
    const promptTitleIds = [
      ...new Set(
        resolved
          .filter(
            ({ item }) =>
              this.drivers.listTitle(installations, threadOf(item.event)) ===
              "prompt",
          )
          .map(({ threadId }) => threadId),
      ),
    ];
    const inboundFromPage = collectLatestInbound(inboundScansOf(resolved));
    const missingInbound = threads
      .map((thread) => threadIdOf(thread))
      .filter((id) => !inboundFromPage.has(id));
    const siblingIds =
      query.heads === true
        ? [...new Set([...promptTitleIds, ...missingInbound])]
        : [];
    const siblings =
      siblingIds.length > 0
        ? await authority.listInbox(orgId, {
            siblings: true,
            thread_ids: siblingIds,
          })
        : [];
    const inboundByThread =
      missingInbound.length > 0
        ? await latestInboundByThread(
            resolved.map((row) => row.item),
            siblings,
            new Map(
              resolved.map((row) => [row.item.event.id, row.body] as const),
            ),
            authority,
            blobs,
          )
        : inboundFromPage;
    const awaitingUser = awaitingUserThreads(resolved);
    const liveChannel = !shouldSkipLiveChannelOverlays(query);
    const [livePrompts, attention, receiptPage] = await Promise.all([
      this.drivers.listPromptsForThreads(installations, threads, host),
      liveChannel
        ? this.drivers.readAttention(
            installations,
            withInboundHint(threads, inboundByThread),
            host,
          )
        : Promise.resolve(new Map()),
      liveChannel
        ? loadInboxReceipts({
            heads: query.heads === true,
            thread,
            since: query.since,
            resolved,
            installations,
            drivers: this.drivers,
            host,
            authority,
            blobs,
            orgId,
          })
        : Promise.resolve({
            receipts: new Map(),
            extras: [] as InboxResolvedRow[],
          }),
    ]);
    const promptPage = await promptLabelsFor(
      orgId,
      resolved,
      installations,
      this.drivers,
      authority,
      blobs,
      query.heads === true,
      siblings,
    );
    const prompts = promptPage.labels;
    const includeReceipts = query.heads !== true;
    const [hiddenIds, bound] = await Promise.all([
      this.work.hiddenThreadIds(),
      this.work.boundPromptThreads(),
    ]);
    const hidden = new Set([...hiddenIds, ...promptPage.hide]);
    const agentThreads = [...new Set(bound.values())].flatMap((id) => {
      try {
        return [parseConversationThread(id)];
      } catch {
        return [];
      }
    });
    if (agentThreads.length > 0) {
      const extra = await this.drivers.listPromptsForThreads(
        installations,
        agentThreads,
        host,
      );
      for (const [sourceId, agentId] of bound) {
        mergePromptMap(livePrompts, extra, sourceId, agentId);
      }
    }
    const faces = await this.work.inboxFaces(
      [...resolved, ...receiptPage.extras].map((row) => row.threadId),
      livePrompts,
    );
    return [...resolved, ...receiptPage.extras].flatMap(({ item, threadId, body }) => {
      if (query.heads === true && hidden.has(threadId)) {
        return [];
      }
      const view = decorateInboxItem(
        item,
        body,
        installations,
        this.drivers,
        prefsByThread.get(threadId) ?? null,
        labels,
        livePrompts,
        attention,
        inboundByThread,
        awaitingUser,
        receiptPage.receipts,
        includeReceipts,
        faces.get(threadId),
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

  async ackConversationAttention(
    input: ConversationAttentionInput,
  ): Promise<ConversationPrefView> {
    const host = this.runtime.requireHost();
    const threadId = input.thread_id?.trim() ?? "";
    const thread = requireThreadId(threadId);
    const lastReadAt =
      input.last_read_at !== undefined
        ? normalizeStamp(input.last_read_at)
        : new Date().toISOString();
    const lastReadId =
      input.last_read_external_id !== undefined
        ? normalizeCursor(input.last_read_external_id)
        : null;
    const pref = await host.get("authority").putConversationPref({
      org_id: this.runtime.orgId(),
      thread_id: threadId,
      last_read_at: lastReadAt,
      last_read_external_id: lastReadId,
      updated_at: new Date().toISOString(),
    });
    const installations = await host
      .get("authority")
      .listInstallations(this.runtime.orgId());
    await this.drivers.ackAttention(
      installations,
      thread,
      {
        last_read_at: pref.last_read_at ?? undefined,
        last_read_external_id: pref.last_read_external_id ?? undefined,
      },
      host,
    );
    await this.work.ackDoneThread(threadId);
    return toPrefView(pref);
  }

  async answerConversationPrompt(
    input: ConversationPromptInput,
  ): Promise<{ accepted: true; thread_id: string; prompt_id: string }> {
    const host = this.runtime.requireHost();
    const threadId = input.thread_id?.trim() ?? "";
    const thread = requireThreadId(threadId);
    const promptId = input.prompt_id?.trim() ?? "";
    if (!promptId) {
      throw new PersonalConnectorError(
        "invalid_config",
        "prompt_id is required",
        400,
      );
    }
    const answer: PromptAnswer = {
      prompt_id: promptId,
      answers: (input.answers ?? []).flatMap((item) => {
        const id = item.id?.trim() ?? "";
        if (!id) {
          return [];
        }
        return [
          {
            id,
            selected: Array.isArray(item.selected)
              ? item.selected
                  .filter((label) => typeof label === "string" && label.trim())
                  .map((label) => label.trim())
              : [],
            ...(typeof item.custom === "string" && item.custom.trim()
              ? { custom: item.custom.trim() }
              : {}),
          },
        ];
      }),
    };
    const installations = await host
      .get("authority")
      .listInstallations(this.runtime.orgId());
    const sourcePrompts = await this.drivers.listPrompts(
      installations,
      thread,
      host,
    );
    const target = await this.work.promptTargetThread(
      threadId,
      promptId,
      sourcePrompts.some((item) => item.prompt_id === promptId),
    );
    try {
      const result = await this.drivers.answerPrompt(
        installations,
        target,
        answer,
        host,
      );
      if (result.accepted === false) {
        throw new PersonalConnectorError(
          "send_failed",
          "This conversation rejected the prompt answer",
          400,
        );
      }
      await this.work.afterPrompt(threadId, answer);
      return {
        accepted: true,
        thread_id: threadId,
        prompt_id: promptId,
      };
    } catch (error) {
      if (error instanceof ChannelDriverError) {
        throw new PersonalConnectorError(
          error.code,
          error.message,
          error.code === "unsupported_channel" ? 501 : 400,
        );
      }
      throw error;
    }
  }
}

const LIST_FACE_MAX = 120;

function listFaceBody(body: InboxBody): InboxBody {
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
  promptsByThread: ReadonlyMap<string, ThreadPrompt[]> = new Map(),
  attentionByThread: ReadonlyMap<string, ThreadAttention> = new Map(),
  inboundByThread: ReadonlyMap<string, ThreadInboundCursor> = new Map(),
  awaitingUser: ReadonlySet<string> = new Set(),
  receiptsByOutbound: ReadonlyMap<string, MessageReceipt> = new Map(),
  includeReceipts = true,
  workFace?: WorkInboxFace,
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
    channel_label: drivers.sourceLabel(surface.channel),
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
  };
}

function mergePromptMap(
  dest: Map<string, ThreadPrompt[]>,
  extra: ReadonlyMap<string, ThreadPrompt[]>,
  sourceId: string,
  agentId: string,
): void {
  const added = extra.get(agentId) ?? [];
  if (added.length === 0) {
    return;
  }
  const current = dest.get(sourceId) ?? [];
  const seen = new Set(current.map((item) => item.prompt_id));
  dest.set(sourceId, [
    ...current,
    ...added.filter((item) => !seen.has(item.prompt_id)),
  ]);
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
  preloadedSiblings: InboxItem[] = [],
): Promise<{ labels: Map<string, string>; hide: Set<string> }> {
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
    return { labels: new Map(), hide: new Set() };
  }
  if (!heads) {
    return { labels: firstUserLabelsFrom(resolved), hide: new Set() };
  }
  const have = new Set(
    preloadedSiblings.map((item) =>
      conversationId(item.event.source, item.event.external_id, item.event.id),
    ),
  );
  const missingIds = promptIds.filter((id) => !have.has(id));
  const extra =
    missingIds.length > 0
      ? await authority.listInbox(orgId, {
          siblings: true,
          thread_ids: missingIds,
        })
      : [];
  const siblings = [...preloadedSiblings, ...extra];
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
  const hide = new Set<string>();
  await Promise.all(
    promptIds.map(async (threadId) => {
      const face = await firstUserTextIn(
        (groups.get(threadId) ?? []).slice().sort(byEventTime),
        resolved,
        authority,
        blobs,
      );
      if (face.hide) {
        hide.add(threadId);
      }
      if (face.text) {
        labels.set(threadId, face.text);
      }
    }),
  );
  return { labels, hide };
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
): Promise<{ text?: string; hide: boolean }> {
  const cached = new Map(
    resolved.map((row) => [row.item.event.id, row.body] as const),
  );
  const scanned: InboxItem[] = [];
  const missing: Array<string | undefined> = [];
  for (const item of items) {
    if (isThreadStatusItem(item) || item.event.operation === "tombstone") {
      continue;
    }
    if (scanned.length >= PROMPT_READ_LIMIT) {
      break;
    }
    scanned.push(item);
    if (!cached.has(item.event.id)) {
      missing.push(item.event.content_hash);
    }
  }
  const extras =
    missing.length > 0
      ? await resolveInboxBodies(authority, blobs, missing, "meta")
      : new Map<string, InboxBody>();
  let users = 0;
  for (const item of scanned) {
    const body =
      cached.get(item.event.id) ??
      (item.event.content_hash
        ? (extras.get(item.event.content_hash) ?? {})
        : {});
    const surface = messageSurfaceOf(item.event, body);
    if (surface.kind !== "user") {
      continue;
    }
    users += 1;
    if (users > PROMPT_USER_SCAN_LIMIT) {
      break;
    }
    const raw = body.body_text ?? "";
    const hide = isExecutorSysoutBody(raw);
    const text = listFaceText(raw);
    if (text || hide) {
      return { text, hide };
    }
  }
  return { hide: false };
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

export function inboxStoreQuery(
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
  if (query.thread_id && thread) {
    return {
      thread_ids: [query.thread_id],
      since: query.since,
      since_id: query.since_id,
      before: query.before,
      before_id: query.before_id,
      limit: query.limit,
      siblings: true,
    };
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
    last_read_at: pref.last_read_at,
    last_read_external_id: pref.last_read_external_id,
    updated_at: pref.updated_at,
  };
}

function requireThreadId(threadId: string): ConversationThread {
  try {
    return parseConversationThread(threadId);
  } catch (error) {
    const message =
      error instanceof ChannelDriverError
        ? error.message
        : "thread_id must look like source:target";
    throw new PersonalConnectorError("invalid_config", message, 400);
  }
}

function normalizeStamp(value: string | null): string | null {
  const stamp = (value ?? "").trim();
  if (!stamp) {
    return null;
  }
  const at = Date.parse(stamp);
  return Number.isFinite(at) ? new Date(at).toISOString() : stamp;
}

function normalizeCursor(value: string | null): string | null {
  const cursor = (value ?? "").replace(/\s+/g, " ").trim();
  return cursor.length > 0 ? cursor : null;
}

const INBOUND_SCAN_LIMIT = 32;

function awaitingUserThreads(
  resolved: Array<{
    item: { event: EventRecord };
    threadId: string;
    body: InboxBody;
  }>,
): Set<string> {
  const ids = new Set<string>();
  for (const row of resolved) {
    if (messageSurfaceOf(row.item.event, row.body).activity === "awaiting_user") {
      ids.add(row.threadId);
    }
  }
  return ids;
}

function inboundScansOf(
  resolved: Array<{
    item: { event: EventRecord };
    threadId: string;
    body: InboxBody;
  }>,
): ThreadInboundScan[] {
  return resolved.map(({ item, threadId, body }) => {
    const surface = messageSurfaceOf(item.event, body);
    return {
      thread_id: threadId,
      external_id: item.event.external_id,
      occurred_at: item.event.occurred_at,
      operation: item.event.operation,
      direction: surface.direction,
      activity: surface.activity,
    };
  });
}

const RECEIPT_SCAN_LIMIT = 8;

type InboxResolvedRow = {
  item: { decision: ArrangementDecision; event: EventRecord };
  threadId: string;
  body: InboxBody;
};

async function loadInboxReceipts(input: {
  heads: boolean;
  thread?: ConversationThread;
  since?: string;
  resolved: InboxResolvedRow[];
  installations: ConnectorInstallation[];
  drivers: ChannelDriverRegistry;
  host: Parameters<ChannelDriverRegistry["readReceipts"]>[2];
  authority: AuthorityStore;
  blobs: BlobStore;
  orgId: string;
}): Promise<{
  receipts: ReadonlyMap<string, MessageReceipt>;
  extras: InboxResolvedRow[];
}> {
  if (input.heads) {
    return { receipts: new Map(), extras: [] };
  }
  const siblings =
    input.thread && input.drivers.canReceipt(input.installations, input.thread)
      ? await input.authority.listInbox(input.orgId, {
          siblings: true,
          thread_ids: [threadIdOf(input.thread)],
        })
      : [];
  const siblingOutbound =
    siblings.length > 0
      ? await outboundSiblingEvents(siblings, input.authority, input.blobs)
      : [];
  const queries = mergeReceiptQueries(
    receiptQueriesOf(input.resolved),
    siblingOutbound.length > 0
      ? receiptQueriesFromOutboundEvents(siblingOutbound)
      : [],
  );
  const receipts = await input.drivers.readReceipts(
    input.installations,
    queries,
    input.host,
  );
  if (!input.since || siblingOutbound.length === 0) {
    return { receipts, extras: [] };
  }
  const seen = new Set(input.resolved.map((row) => row.item.event.id));
  const extras = siblingOutbound.filter(
    (item) =>
      !seen.has(item.event.id) &&
      receipts.get(item.event.external_id)?.state === "read",
  );
  if (extras.length === 0) {
    return { receipts, extras: [] };
  }
  const bodies = await resolveInboxBodies(
    input.authority,
    input.blobs,
    extras.map((item) => item.event.content_hash),
    "preview",
  );
  return {
    receipts,
    extras: extras.map((item) => ({
      item,
      threadId: conversationId(
        item.event.source,
        item.event.external_id,
        item.event.id,
      ),
      body: item.event.content_hash
        ? (bodies.get(item.event.content_hash) ?? {})
        : {},
    })),
  };
}

function receiptQueriesOf(resolved: InboxResolvedRow[]): ThreadReceiptQuery[] {
  const groups = new Map<string, ThreadReceiptQuery>();
  for (const row of resolved) {
    const surface = messageSurfaceOf(row.item.event, row.body);
    if (surface.direction !== "outbound") {
      continue;
    }
    const thread = threadOf(row.item.event);
    const current = groups.get(row.threadId) ?? { ...thread, outbound: [] };
    current.outbound.push({
      external_id: row.item.event.external_id,
      occurred_at: row.item.event.occurred_at,
    });
    groups.set(row.threadId, current);
  }
  return [...groups.values()].map((query) => ({
    ...query,
    outbound: newestOutbound(query.outbound),
  }));
}

function mergeReceiptQueries(
  ...groups: ThreadReceiptQuery[][]
): ThreadReceiptQuery[] {
  const merged = new Map<string, ThreadReceiptQuery>();
  for (const group of groups) {
    for (const query of group) {
      const threadId = threadIdOf(query);
      const current = merged.get(threadId);
      if (!current) {
        merged.set(threadId, {
          ...query,
          outbound: [...query.outbound],
        });
        continue;
      }
      current.outbound.push(...query.outbound);
    }
  }
  return [...merged.values()].map((query) => ({
    ...query,
    outbound: newestOutbound(uniqueOutbound(query.outbound)),
  }));
}

function uniqueOutbound<T extends { external_id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.external_id)) {
      return false;
    }
    seen.add(item.external_id);
    return true;
  });
}

async function outboundSiblingEvents(
  items: InboxItem[],
  authority: AuthorityStore,
  blobs: BlobStore,
): Promise<InboxItem[]> {
  const newest = items.slice().sort(byEventTime).reverse().slice(0, 48);
  const hashes = newest
    .map((item) => item.event.content_hash)
    .filter((hash): hash is string => Boolean(hash));
  const bodies =
    hashes.length > 0
      ? await resolveInboxBodies(authority, blobs, hashes, "meta")
      : new Map<string, InboxBody>();
  return newest
    .filter((item) => {
      const body = item.event.content_hash
        ? (bodies.get(item.event.content_hash) ?? {})
        : {};
      return messageSurfaceOf(item.event, body).direction === "outbound";
    })
    .slice(0, RECEIPT_SCAN_LIMIT);
}

function receiptQueriesFromOutboundEvents(
  items: Array<{ event: EventRecord }>,
): ThreadReceiptQuery[] {
  const groups = new Map<string, ThreadReceiptQuery>();
  for (const { event } of items) {
    const thread = threadOf(event);
    const threadId = threadIdOf(thread);
    const current = groups.get(threadId) ?? { ...thread, outbound: [] };
    current.outbound.push({
      external_id: event.external_id,
      occurred_at: event.occurred_at,
    });
    groups.set(threadId, current);
  }
  return [...groups.values()].map((query) => ({
    ...query,
    outbound: newestOutbound(query.outbound),
  }));
}

function newestOutbound<T extends { occurred_at: string; external_id: string }>(
  items: T[],
): T[] {
  return items
    .slice()
    .sort((left, right) =>
      left.occurred_at === right.occurred_at
        ? left.external_id < right.external_id
          ? 1
          : -1
        : left.occurred_at < right.occurred_at
          ? 1
          : -1,
    )
    .slice(0, RECEIPT_SCAN_LIMIT);
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

function withInboundHint(
  threads: ConversationThread[],
  inboundByThread: ReadonlyMap<string, ThreadInboundCursor>,
): ThreadAttentionQuery[] {
  return threads.map((thread) => {
    const latest_inbound = inboundByThread.get(threadIdOf(thread));
    return latest_inbound ? { ...thread, latest_inbound } : thread;
  });
}

async function latestInboundByThread(
  page: Array<{ event: EventRecord }>,
  siblings: InboxItem[],
  cachedBodies: ReadonlyMap<string, InboxBody>,
  authority: AuthorityStore,
  blobs: BlobStore,
): Promise<Map<string, ThreadInboundCursor>> {
  const cached = collectLatestInbound(
    page.flatMap((item) => {
      const body = cachedBodies.get(item.event.id);
      if (!body) {
        return [];
      }
      const surface = messageSurfaceOf(item.event, body);
      return [
        {
          thread_id: conversationId(
            item.event.source,
            item.event.external_id,
            item.event.id,
          ),
          external_id: item.event.external_id,
          occurred_at: item.event.occurred_at,
          operation: item.event.operation,
          direction: surface.direction,
          activity: surface.activity,
        } satisfies ThreadInboundScan,
      ];
    }),
  );
  const missing = new Set<string>();
  const byThread = new Map<string, InboxItem[]>();
  for (const item of siblings) {
    const threadId = conversationId(
      item.event.source,
      item.event.external_id,
      item.event.id,
    );
    if (cached.has(threadId)) {
      continue;
    }
    missing.add(threadId);
    const bucket = byThread.get(threadId);
    if (bucket) {
      bucket.push(item);
    } else {
      byThread.set(threadId, [item]);
    }
  }
  if (missing.size === 0) {
    return cached;
  }
  const candidates: InboxItem[] = [];
  for (const threadId of missing) {
    const bucket = (byThread.get(threadId) ?? [])
      .slice()
      .sort(byEventTime)
      .reverse();
    let taken = 0;
    for (const item of bucket) {
      if (item.event.operation === "tombstone") {
        continue;
      }
      if (
        isLocalOutboundId(item.event.external_id) &&
        !cachedBodies.has(item.event.id)
      ) {
        continue;
      }
      candidates.push(item);
      taken += 1;
      if (taken >= INBOUND_SCAN_LIMIT) {
        break;
      }
    }
  }
  const needed = candidates.filter(
    (item) => item.event.content_hash && !cachedBodies.has(item.event.id),
  );
  const extras =
    needed.length > 0
      ? await resolveInboxBodies(
          authority,
          blobs,
          needed.map((item) => item.event.content_hash),
          "meta",
        )
      : new Map<string, InboxBody>();
  const fromSiblings = collectLatestInbound(
    candidates.map((item) => {
      const body =
        cachedBodies.get(item.event.id) ??
        (item.event.content_hash
          ? (extras.get(item.event.content_hash) ?? {})
          : {});
      const surface = messageSurfaceOf(item.event, body);
      return {
        thread_id: conversationId(
          item.event.source,
          item.event.external_id,
          item.event.id,
        ),
        external_id: item.event.external_id,
        occurred_at: item.event.occurred_at,
        operation: item.event.operation,
        direction: surface.direction,
        activity: surface.activity,
      };
    }),
  );
  return new Map([...fromSiblings, ...cached]);
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
