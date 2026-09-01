import { Inject, Injectable, forwardRef } from "@nestjs/common";
import {
  ChannelDriverError,
  ChannelDriverRegistry,
  DEFAULT_COPY_LOCALE,
  DEFAULT_CATALOG_OPTIONS_TIMEOUT_MS,
  resolveCopy,
  type CopyLocale,
  attentionOf,
  collectLatestInbound,
  computeThreadUnread,
  conversationId,
  inboxDigest,
  isExecutorSysoutBody,
  headsByThread,
  isBeforeEvent,
  isLocalOutboundId,
  isThreadStatusItem,
  parseConversationThread,
  projectThreadFacet,
  recordClassFromType,
  takeRecentInboxItems,
  latestForwardedTo,
  type ForwardedFrom,
  foldByHuman,
  normalizeInboxLimit,
  normalizeInboxListView,
  unfold,
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
  type IngestAttempt,
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
  loadSyncProgress,
  type SyncStore,
  withDeadline,
} from "@regenic/domain";
import {
  resolveInboxBodies,
  resolveInboxBody,
  type InboxAttachment,
  type InboxBody,
} from "./inbox-body";
import { catalogMembersFromStreams } from "./connector-sync-members";
import { CatalogProbeCache } from "./catalog-probe-cache";
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
import { PersonalEventsService } from "./personal-events.service";
import {
  PersonalExecutorService,
  type EngineExecutorView,
  type ExecutorKindCatalogItem,
} from "./personal-executor.service";
import { PersonalWorkService, type WorkInboxFace } from "./personal-work.service";
import {
  listPluginInventory,
  resolvePluginDirectory,
  type PluginInventoryItem,
} from "./channel-plugins";

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

export interface ConversationPrefView {
  thread_id: string;
  title: string | null;
  pinned: boolean;
  hidden: boolean;
  last_read_at: string | null;
  last_read_external_id: string | null;
  updated_at: string;
}

export interface ConversationPrefInput {
  thread_id?: string;
  title?: string | null;
  pinned?: boolean;
  hidden?: boolean;
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
  plugins: PluginInventoryItem[];
  plugin_dir: string | null;
}

export interface InboxListQuery {
  since?: string;
  since_id?: string;
  before?: string;
  before_id?: string;
  heads?: boolean;
  live?: boolean;
  split?: boolean;
  changed?: boolean;
  since_digest?: string;
  thread_id?: string;
  thread_ids?: string[];
  limit?: number;
  list?: string;
  locale?: CopyLocale;
}

export type InboxHeadsCursor = { before: string; before_id: string };

export interface InboxHeadsPage {
  pinned: InboxViewItem[];
  live: InboxViewItem[];
  active_work?: InboxViewItem[];
  next_before: InboxHeadsCursor | null;
  has_older: boolean;
  patch?: boolean;
  gone?: string[];
}

export const CHANGED_INBOX_EVENT_CAP = 200;
export const CHANGED_INBOX_THREAD_CAP = 80;

export function shouldSplitInboxHeads(query: InboxListQuery): boolean {
  return query.heads === true && query.split === true && !query.thread_id;
}

export function shouldLoadChangedInboxHeads(query: InboxListQuery): boolean {
  return (
    query.heads === true &&
    query.split === true &&
    query.changed === true &&
    Boolean(query.since_digest?.trim()) &&
    !query.thread_id &&
    !query.before
  );
}

export function parseSinceInboxDigest(value: string): {
  count: number;
  latest_at: string;
  latest_id: string;
  pref_updated_at: string;
} | null {
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return null;
  }
  const pref = peelInboxDigestTail(trimmed.split("&")[0] ?? "");
  const prefCountSep = pref.head.lastIndexOf(":");
  if (prefCountSep < 0) {
    return null;
  }
  const prefCount = Number(pref.head.slice(prefCountSep + 1));
  const left = pref.head.slice(0, prefCountSep);
  const countSep = left.indexOf(":");
  if (countSep < 0) {
    return null;
  }
  const count = Number(left.slice(0, countSep));
  const middle = left.slice(countSep + 1);
  const idSep = middle.lastIndexOf(":");
  if (idSep < 0) {
    return null;
  }
  const latestAt = middle.slice(0, idSep);
  if (!latestAt) {
    return null;
  }
  if (!Number.isInteger(count) || count < 0) {
    return null;
  }
  if (!Number.isInteger(prefCount) || prefCount < 0) {
    return null;
  }
  return {
    count,
    latest_at: latestAt,
    latest_id: middle.slice(idSep + 1),
    pref_updated_at: pref.tail,
  };
}

function peelInboxDigestTail(base: string): { head: string; tail: string } {
  if (base.endsWith(":")) {
    return { head: base.slice(0, -1), tail: "" };
  }
  const iso = base.match(
    /^(.*):(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/,
  );
  if (iso) {
    return { head: iso[1] ?? "", tail: iso[2] ?? "" };
  }
  const last = base.lastIndexOf(":");
  if (last < 0) {
    return { head: "", tail: base };
  }
  return { head: base.slice(0, last), tail: base.slice(last + 1) };
}

export function shouldFallbackChangedInboxHeads(collected: {
  ids: readonly string[];
  tooMany: boolean;
  countChanged?: boolean;
}): boolean {
  return (
    collected.tooMany ||
    (collected.ids.length === 0 && collected.countChanged === true)
  );
}

export function collectChangedInboxThreadIds(input: {
  events: Array<{ source: string; external_id: string; id: string }>;
  prefs: Array<{ thread_id: string; updated_at: string }>;
  prefSince: string;
}): { ids: string[]; tooMany: boolean } {
  if (input.events.length >= CHANGED_INBOX_EVENT_CAP) {
    return { ids: [], tooMany: true };
  }
  const ids = new Set<string>();
  for (const event of input.events) {
    ids.add(conversationId(event.source, event.external_id, event.id));
  }
  for (const pref of input.prefs) {
    if (!input.prefSince || pref.updated_at > input.prefSince) {
      ids.add(pref.thread_id);
    }
  }
  const list = [...ids];
  return { ids: list, tooMany: list.length > CHANGED_INBOX_THREAD_CAP };
}

export function splitChangedInboxHeads<
  T extends { thread_id?: string; pinned?: boolean; hidden?: boolean },
>(input: {
  views: T[];
  collectedIds: readonly string[];
  prefs: Array<{ thread_id: string; hidden?: boolean }>;
  workIds: readonly string[];
  list?: string;
}): {
  pinned: T[];
  live: T[];
  active_work: T[];
  gone: string[];
} {
  const hiddenList = normalizeInboxListView(input.list) === "hidden";
  const work = new Set(input.workIds);
  const loaded = new Set<string>();
  const kept: T[] = [];
  for (const item of input.views) {
    const id = item.thread_id?.trim();
    if (!id) {
      continue;
    }
    loaded.add(id);
    if (item.hidden === hiddenList) {
      kept.push(item);
    }
  }
  const returned = new Set(
    kept.flatMap((item) => (item.thread_id ? [item.thread_id] : [])),
  );
  const hiddenByPref = new Map(
    input.prefs.map((pref) => [pref.thread_id, pref.hidden] as const),
  );
  return {
    pinned: kept.filter((item) => item.pinned),
    live: kept.filter(
      (item) => !item.pinned && !work.has(item.thread_id ?? ""),
    ),
    active_work: hiddenList
      ? []
      : kept.filter(
          (item) => !item.pinned && work.has(item.thread_id ?? ""),
        ),
    gone: input.collectedIds.filter((id) => {
      if (returned.has(id)) {
        return false;
      }
      if (loaded.has(id)) {
        return true;
      }
      const prefHidden = hiddenByPref.get(id);
      if (prefHidden === true && !hiddenList) {
        return true;
      }
      if (prefHidden === false && hiddenList) {
        return true;
      }
      return false;
    }),
  };
}

export function headsNextBefore(
  live: Array<{ event: { occurred_at: string; id: string } }>,
): InboxHeadsCursor | null {
  let oldest: { occurred_at: string; id: string } | undefined;
  for (const item of live) {
    if (!oldest || isBeforeEvent(item.event, oldest.occurred_at, oldest.id)) {
      oldest = item.event;
    }
  }
  return oldest
    ? { before: oldest.occurred_at, before_id: oldest.id }
    : null;
}

export function splitHeadExcludeIds(input: {
  prefs: Array<{ thread_id: string; pinned?: boolean; hidden?: boolean }>;
  workIds: readonly string[];
  list?: string;
}): { pinnedIds: string[]; workIds: string[] } {
  const hiddenList = normalizeInboxListView(input.list) === "hidden";
  const pinnedIds = [
    ...new Set(
      input.prefs
        .filter(
          (pref) => pref.pinned && (hiddenList ? pref.hidden : !pref.hidden),
        )
        .map((pref) => pref.thread_id),
    ),
  ];
  const pinned = new Set(pinnedIds);
  const workIds = hiddenList
    ? []
    : [...new Set(input.workIds.filter((id) => id && !pinned.has(id)))];
  return { pinnedIds, workIds };
}

export function headsLiveFetchLimit(
  limit: number | undefined,
  excludeCount: number,
): number | undefined {
  if (typeof limit !== "number") {
    return undefined;
  }
  return normalizeInboxLimit(limit + Math.max(0, excludeCount)) ?? limit;
}

export function partitionLiveInboxHeads<
  T extends {
    thread_id?: string;
    event: {
      id: string;
      source?: string;
      external_id?: string;
      occurred_at: string;
    };
  },
>(input: {
  items: T[];
  pinnedIds: readonly string[];
  workIds: readonly string[];
  limit?: number;
  fetchedCount: number;
  fetchLimit?: number;
}): {
  live: T[];
  pinned: T[];
  work: T[];
  hasOlder: boolean;
} {
  const pinnedSet = new Set(input.pinnedIds);
  const workSet = new Set(input.workIds);
  const pinned: T[] = [];
  const work: T[] = [];
  const liveAll: T[] = [];
  for (const item of input.items) {
    const id = headThreadId(item);
    if (!id) {
      continue;
    }
    if (pinnedSet.has(id)) {
      pinned.push(item);
    } else if (workSet.has(id)) {
      work.push(item);
    } else {
      liveAll.push(item);
    }
  }
  const live = takeRecentHeads(liveAll, input.limit);
  const hasOlder =
    (typeof input.limit === "number" && liveAll.length > live.length) ||
    (typeof input.fetchLimit === "number" &&
      input.fetchedCount >= input.fetchLimit);
  return { live, pinned, work, hasOlder };
}

export function splitInboxHeadViews(
  views: InboxViewItem[],
  input: {
    liveIds: readonly string[];
    pinnedIds: readonly string[];
    workIds: readonly string[];
    liveCount: number;
    limit?: number;
    hasOlder?: boolean;
  },
): InboxHeadsPage {
  const byId = new Map<string, InboxViewItem>();
  for (const view of views) {
    if (view.thread_id) {
      byId.set(view.thread_id, view);
    }
  }
  const take = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const item = byId.get(id);
      return item ? [item] : [];
    });
  const workSet = new Set(input.workIds);
  const takenLive = take(input.liveIds);
  const live = takenLive.filter(
    (item) => !item.pinned && !workSet.has(item.thread_id ?? ""),
  );
  return {
    pinned: uniqueHeadViews([
      ...take(input.pinnedIds),
      ...takenLive.filter((item) => item.pinned),
    ]),
    live,
    active_work: uniqueHeadViews([
      ...take(input.workIds),
      ...takenLive.filter(
        (item) => !item.pinned && workSet.has(item.thread_id ?? ""),
      ),
    ]),
    next_before: headsNextBefore(live),
    has_older:
      input.hasOlder ??
      (typeof input.limit === "number" && input.liveCount >= input.limit),
  };
}

function takeRecentHeads<T extends { event: { occurred_at: string; id: string } }>(
  items: T[],
  limit?: number,
): T[] {
  const cap = normalizeInboxLimit(limit);
  if (cap === undefined || items.length <= cap) {
    return items;
  }
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      if (left.item.event.occurred_at !== right.item.event.occurred_at) {
        return left.item.event.occurred_at < right.item.event.occurred_at
          ? -1
          : 1;
      }
      if (left.item.event.id !== right.item.event.id) {
        return left.item.event.id < right.item.event.id ? -1 : 1;
      }
      return left.index - right.index;
    })
    .slice(items.length - cap)
    .map((row) => row.item);
}

function uniqueHeadViews<T extends { thread_id?: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const next: T[] = [];
  for (const item of items) {
    const id = item.thread_id?.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    next.push(item);
  }
  return next;
}

function headThreadId(item: {
  thread_id?: string;
  event: { id: string; source?: string; external_id?: string };
}): string | undefined {
  const id = item.thread_id?.trim();
  if (id) {
    return id;
  }
  if (item.event.source && item.event.external_id) {
    return conversationId(
      item.event.source,
      item.event.external_id,
      item.event.id,
    );
  }
  return undefined;
}

export function shouldSkipLiveChannelOverlays(query: InboxListQuery): boolean {
  // live=1 is the slow path (CLI read_status / receipts). Everything else
  // stays on SQLite so list refresh and chat switching do not wait on lark-cli.
  if (query.live) {
    return false;
  }
  if (query.heads) {
    return true;
  }
  return Boolean(query.thread_id);
}

export interface EngineQuery {
  /** When false, skip last_attempt on installations. Catalog probes are cached either way. */
  detailed?: boolean;
  locale?: CopyLocale;
}

export interface StoreView {
  events: number;
  conversations: number;
  work_items: number;
  blobs: number;
  context_artifacts: number;
  context_snapshots: number;
  context_bundles: number;
  context_checkpoints: number;
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
    context_artifacts: number;
    context_snapshots: number;
    context_bundles: number;
    context_checkpoints: number;
  };
  kept: {
    recipes: number;
    connectors: number;
    executors: number;
  };
}

@Injectable()
export class PersonalInboxService {
  private readonly catalogProbes = new CatalogProbeCache();

  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
    @Inject(ChannelDriverRegistry)
    private readonly drivers: ChannelDriverRegistry,
    @Inject(forwardRef(() => PersonalWorkService))
    private readonly work: PersonalWorkService,
    @Inject(forwardRef(() => PersonalExecutorService))
    private readonly executors: PersonalExecutorService,
    @Inject(PersonalEventsService)
    private readonly events: PersonalEventsService,
  ) {}

  startAfterListen(): void {
    this.catalogProbes.schedule(this.drivers);
  }

  async listCatalogFieldOptions(
    connectorType: string,
    locale: CopyLocale = DEFAULT_COPY_LOCALE,
  ): Promise<Record<string, { value: string; label: string }[]>> {
    const type = connectorType.trim();
    if (!type) {
      return {};
    }
    const driver = this.drivers.get(type);
    if (!driver?.listCatalogFieldOptions) {
      return {};
    }
    const tables = driver.locales?.() ?? [];
    try {
      const raw = await withDeadline(
        driver.listCatalogFieldOptions({ env: process.env }),
        DEFAULT_CATALOG_OPTIONS_TIMEOUT_MS,
        `catalog options ${type}`,
      );
      const resolved: Record<string, { value: string; label: string }[]> = {};
      for (const [key, options] of Object.entries(raw ?? {})) {
        resolved[key] = (options ?? []).map((option) => ({
          value: option.value,
          label:
            resolveCopy(tables, locale, option.label) ?? String(option.label),
        }));
      }
      return resolved;
    } catch {
      return {};
    }
  }

  async publishInboxDigest(): Promise<void> {
    if (!this.runtime.isReady()) {
      return;
    }
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const authority = host.get("authority");
    const [inbox, installations] = await Promise.all([
      authority.summarizeInbox(orgId),
      authority.listInstallations(orgId),
    ]);
    this.events.inboxDigest(
      withSurfaceGeneration(
        inbox.digest,
        this.drivers.surfaceGeneration(installations, host),
      ),
    );
  }

  publishThreadUpdated(threadId: string): void {
    this.events.threadUpdated(threadId);
  }

  async listInbox(
    query: InboxListQuery & { split: true },
  ): Promise<InboxHeadsPage>;
  async listInbox(query?: InboxListQuery): Promise<InboxViewItem[]>;
  async listInbox(
    query: InboxListQuery = {},
  ): Promise<InboxViewItem[] | InboxHeadsPage> {
    const normalized = {
      ...query,
      limit: normalizeInboxLimit(query.limit),
    };
    if (shouldLoadChangedInboxHeads(normalized)) {
      return this.loadChangedInboxHeads(normalized);
    }
    return this.loadThreadInbox(normalized);
  }

  async getInboxItem(
    eventId: string,
    locale: CopyLocale = DEFAULT_COPY_LOCALE,
  ): Promise<InboxViewItem | null> {
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
      authority,
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
    const view = decorateInboxItem(
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
      locale,
    );
    const traces = await loadForwardedToTraces(
      siblings,
      event.content_hash ? new Map([[event.content_hash, body]]) : new Map(),
      authority,
      blobs,
      this.drivers,
      locale,
    );
    const forwardedTo = traces.get(view.event.id);
    return forwardedTo ? { ...view, forwarded_to: forwardedTo } : view;
  }

  async getEngine(query: EngineQuery = {}): Promise<PersonalEngineView> {
    const detailed = query.detailed !== false;
    const options = this.runtime.getOptions();
    const orgId = this.runtime.orgId();
    const catalogReady = (
      installations: EngineInstallationView[],
    ) => {
      const extras = catalogFromDrivers(this.drivers, process.env, query.locale);
      this.catalogProbes.schedule(this.drivers);
      const probed = this.catalogProbes.peek();
      return connectorCatalog(installations, {
        env: process.env,
        locale: query.locale,
        drivers: this.drivers,
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
        catalog: catalogReady([]),
        executor_installations: [],
        executor_catalog: executorCatalog,
        plugins: listPluginInventory(),
        plugin_dir: resolvePluginDirectory(),
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
        const store = authority as SyncStore & {
          latestAttempt(id: string): Promise<IngestAttempt | null>;
        };
        const streams = host.get("connectors").listStreams(installation.id);
        const fallbackMembers = catalogMembersFromStreams(installation.id, streams);
        const [attempt, sync] = await Promise.all([
          detailed ? store.latestAttempt(installation.id) : Promise.resolve(null),
          loadSyncProgress(store, installation.id, {
            mountedStreamKeys: new Set(streams.map((stream) => stream.stream_key)),
            fallbackMembers,
          }),
        ]);
        return toInstallationView(
          installation,
          attempt,
          this.drivers,
          query.locale,
          { sync },
        );
      }),
    );
    const [executorInstallations, connectorOptions] = await Promise.all([
      this.executors.listViews(query.locale),
      this.executors.creatableConnectorOptions(query.locale),
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
      catalog: catalogReady(views),
      executor_installations: executorInstallations,
      executor_catalog: this.executors.kindCatalog(
        executorInstallations,
        connectorOptions,
      ),
      plugins: listPluginInventory(),
      plugin_dir: resolvePluginDirectory(),
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

  private async loadChangedInboxHeads(
    query: InboxListQuery,
  ): Promise<InboxHeadsPage> {
    const previous = parseSinceInboxDigest(query.since_digest ?? "");
    if (!previous?.latest_at) {
      return this.loadThreadInbox({
        ...query,
        changed: false,
        since_digest: undefined,
      }) as Promise<InboxHeadsPage>;
    }
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    const orgId = this.runtime.orgId();
    const events = await authority.listEvents(orgId, {
      since: previous.latest_at,
      since_id: previous.latest_id,
      limit: CHANGED_INBOX_EVENT_CAP,
    });
    const prefs = await authority.listConversationPrefs(orgId);
    const collected = collectChangedInboxThreadIds({
      events,
      prefs,
      prefSince: previous.pref_updated_at,
    });
    const countChanged =
      collected.ids.length === 0 && !collected.tooMany
        ? (await authority.summarizeInbox(orgId)).count !== previous.count
        : false;
    if (shouldFallbackChangedInboxHeads({ ...collected, countChanged })) {
      return this.loadThreadInbox({
        ...query,
        changed: false,
        since_digest: undefined,
      }) as Promise<InboxHeadsPage>;
    }
    if (collected.ids.length === 0) {
      return {
        pinned: [],
        live: [],
        next_before: null,
        has_older: false,
        patch: true,
        gone: [],
      };
    }
    const workIds =
      normalizeInboxListView(query.list) === "hidden"
        ? []
        : [...(await this.work.activeSessionIds())];
    const loadIds = [...new Set([...collected.ids, ...workIds])];
    const views = (await this.loadThreadInbox({
      ...query,
      split: false,
      changed: false,
      since_digest: undefined,
      thread_id: undefined,
      thread_ids: loadIds,
      before: undefined,
      before_id: undefined,
      limit: undefined,
    })) as InboxViewItem[];
    const split = splitChangedInboxHeads({
      views,
      collectedIds: collected.ids,
      prefs,
      workIds,
      list: query.list,
    });
    return {
      ...split,
      next_before: headsNextBefore(split.live),
      has_older: false,
      patch: true,
    };
  }

  private async loadThreadInbox(
    query: InboxListQuery = {},
  ): Promise<InboxViewItem[] | InboxHeadsPage> {
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    const blobs = host.get("blobs");
    const orgId = this.runtime.orgId();
    if (query.thread_id) {
      preferThread(query.thread_id);
    }
    const thread = parseThreadQuery(query.thread_id);
    const wantSplitLive =
      shouldSplitInboxHeads(query) && !query.thread_ids?.length;
    const loadWorkIds =
      query.heads === true &&
      !query.thread_id &&
      !query.thread_ids?.length &&
      normalizeInboxListView(query.list) !== "hidden";
    const installationsP = authority.listInstallations(orgId);
    const prefsP = thread
      ? authority
          .getConversationPref(orgId, query.thread_id ?? "")
          .then((pref) => (pref ? [pref] : []))
      : authority.listConversationPrefs(orgId);
    const jobSessionsP = loadWorkIds
      ? this.work.activeSessionIds()
      : Promise.resolve(new Set<string>());
    let records: InboxItem[];
    let installations: ConnectorInstallation[];
    let prefs: ConversationPref[];
    let jobSessions: Set<string>;
    let liveFetchLimit = query.limit;
    let liveHasOlder: boolean | undefined;
    if (wantSplitLive) {
      [installations, prefs, jobSessions] = await Promise.all([
        installationsP,
        prefsP,
        jobSessionsP,
      ]);
      const exclude = splitHeadExcludeIds({
        prefs,
        workIds: [...jobSessions],
        list: query.list,
      });
      liveFetchLimit = headsLiveFetchLimit(
        query.limit,
        exclude.pinnedIds.length + exclude.workIds.length,
      );
      records = await authority.listInbox(
        orgId,
        inboxStoreQuery({ ...query, limit: liveFetchLimit ?? query.limit }, thread),
      );
    } else {
      [records, installations, prefs, jobSessions] = await Promise.all([
        authority.listInbox(orgId, inboxStoreQuery(query, thread)),
        installationsP,
        prefsP,
        jobSessionsP,
      ]);
    }
    const prefsByThread = new Map(
      prefs.map((pref) => [pref.thread_id, pref] as const),
    );
    const scanned = selectInboxRecords(records, {
      ...query,
      limit: liveFetchLimit ?? query.limit,
    });
    let liveSelected = scanned;
    let pinnedSelected: InboxItem[] = [];
    let workSelected: InboxItem[] = [];
    if (wantSplitLive) {
      const exclude = splitHeadExcludeIds({
        prefs,
        workIds: [...jobSessions],
        list: query.list,
      });
      const part = partitionLiveInboxHeads({
        items: scanned,
        pinnedIds: exclude.pinnedIds,
        workIds: exclude.workIds,
        limit: query.limit,
        fetchedCount: scanned.length,
        fetchLimit: liveFetchLimit,
      });
      liveSelected = part.live;
      pinnedSelected = part.pinned;
      workSelected = part.work;
      liveHasOlder = part.hasOlder;
      if (!query.before) {
        pinnedSelected = [
          ...pinnedSelected,
          ...(await pinnedInboxHeadExtras(
            pinnedSelected,
            prefs,
            query,
            orgId,
            authority,
          )),
        ];
        const have = new Set([
          ...pinnedSelected.map(inboxItemThreadId),
          ...workSelected.map(inboxItemThreadId),
        ]);
        const hiddenPrefIds = new Set(
          prefs.filter((pref) => pref.hidden).map((pref) => pref.thread_id),
        );
        const missing = [...jobSessions].filter(
          (id) => !have.has(id) && !hiddenPrefIds.has(id),
        );
        if (missing.length > 0) {
          const extras = await authority.listInbox(orgId, {
            siblings: true,
            thread_ids: missing,
          });
          workSelected = [...workSelected, ...headsByThread(extras)];
        }
      }
    } else {
      if (
        query.heads === true &&
        !query.thread_id &&
        !query.before &&
        query.limit
      ) {
        pinnedSelected = await pinnedInboxHeadExtras(
          liveSelected,
          prefs,
          query,
          orgId,
          authority,
        );
      }
      if (jobSessions.size > 0) {
        const have = new Set([
          ...liveSelected.map(inboxItemThreadId),
          ...pinnedSelected.map(inboxItemThreadId),
        ]);
        const hiddenPrefIds = new Set(
          prefs.filter((pref) => pref.hidden).map((pref) => pref.thread_id),
        );
        const missing = [...jobSessions].filter(
          (id) => !have.has(id) && !hiddenPrefIds.has(id),
        );
        if (missing.length > 0) {
          const extras = await authority.listInbox(orgId, {
            siblings: true,
            thread_ids: missing,
          });
          workSelected = headsByThread(extras);
        }
      }
    }
    const selected = [...pinnedSelected, ...liveSelected, ...workSelected];
    const liveIds = liveSelected.map(inboxItemThreadId);
    const pinnedIds = pinnedSelected.map(inboxItemThreadId);
    const workIds = workSelected.map(inboxItemThreadId);
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
      authority,
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
    const views = [...resolved, ...receiptPage.extras].flatMap(
      ({ item, threadId, body }) => {
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
          query.locale,
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
      },
    );
    const projected =
      query.heads === true
        ? views
        : projectForwardedTo(views, this.drivers, query.locale);
    if (shouldSplitInboxHeads(query)) {
      return splitInboxHeadViews(projected, {
        liveIds,
        pinnedIds,
        workIds,
        liveCount: liveSelected.length,
        limit: query.limit,
        hasOlder: liveHasOlder,
      });
    }
    return projected;
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
    if (
      input.title === undefined &&
      input.pinned === undefined &&
      input.hidden === undefined
    ) {
      throw new PersonalConnectorError(
        "invalid_config",
        "title, pinned, or hidden is required",
        400,
      );
    }
    const fold =
      input.hidden === undefined
        ? undefined
        : input.hidden
          ? foldByHuman()
          : unfold();
    const pref = await host.get("authority").putConversationPref({
      org_id: this.runtime.orgId(),
      thread_id: threadId,
      title: input.title !== undefined ? normalizeTitle(input.title) : undefined,
      pinned: input.pinned,
      ...(fold
        ? { hidden: fold.hidden, hidden_reason: fold.reason }
        : {}),
      updated_at: new Date().toISOString(),
    });
    void this.publishInboxDigest();
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
    void this.publishInboxDigest();
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

function projectForwardedTo(
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

async function loadForwardedToTraces(
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

async function pinnedInboxHeadExtras(
  selected: InboxItem[],
  prefs: ConversationPref[],
  query: InboxListQuery,
  orgId: string,
  authority: AuthorityStore,
): Promise<InboxItem[]> {
  const hidden = normalizeInboxListView(query.list) === "hidden";
  const have = new Set(selected.map(inboxItemThreadId));
  const missing = prefs
    .filter(
      (pref) =>
        pref.pinned &&
        (hidden ? pref.hidden : !pref.hidden) &&
        !have.has(pref.thread_id),
    )
    .map((pref) => pref.thread_id);
  if (missing.length === 0) {
    return [];
  }
  const extras = await authority.listInbox(orgId, {
    heads: true,
    list: normalizeInboxListView(query.list),
    thread_ids: missing,
  });
  return extras.length === 0 ? [] : headsByThread(extras);
}

function inboxItemThreadId(item: InboxItem): string {
  return conversationId(item.event.source, item.event.external_id, item.event.id);
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
    const threadIds = query.thread_ids?.length
      ? query.thread_ids
      : thread
        ? [`${thread.source}:${thread.target}`]
        : undefined;
    return {
      heads: true,
      list: normalizeInboxListView(query.list),
      before: threadIds ? undefined : query.before,
      before_id: threadIds ? undefined : query.before_id,
      limit: threadIds ? undefined : query.limit,
      ...(threadIds ? { thread_ids: threadIds } : {}),
    };
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
    list: normalizeInboxListView(query.list),
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
    hidden: pref.hidden === true,
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
