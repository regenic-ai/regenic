import { createHash } from "node:crypto";
import {
  INGEST_SCHEMA_VERSION,
  channelRecord,
  type ConnectorCursor,
  type ContentPart,
  type IngestBatch,
  type PollResult,
} from "@regenic/domain";
import type {
  FeishuChatMode,
  FeishuHistoryItem,
  FeishuImClient,
  FeishuListInput,
  FeishuSortType,
} from "./feishu-cli-client";
import { rememberFeishuInbound } from "./feishu-attention";
import {
  FEISHU_SOURCE,
  collectFeishuUserIds,
  extractFeishuMedia,
  extractFeishuText,
  feishuConversationKind,
  feishuCreateTimeToIso,
  feishuCreateTimeToStartSeconds,
  feishuMentionNames,
  isFeishuSelfSender,
  senderKind,
  sniffMediaType,
  type FeishuMediaRef,
} from "./feishu-message";

export const MAX_FEISHU_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_FEISHU_MEDIA_JOBS = 40;
export const MAX_FEISHU_MEDIA_ATTEMPTS = 5;
export const MAX_FEISHU_MEDIA_JOBS_PER_POLL = 8;

export interface FeishuMediaJob {
  message_id: string;
  key: string;
  kind: "image" | "file";
  filename?: string;
  media_type?: string;
  attempts: number;
  retry_after?: number;
  occurred_at: string;
  actor_id: string;
  actor_label?: string;
  sender_kind: "user" | "assistant";
  direction: "inbound" | "outbound";
  text?: string;
  type?: string;
  thread_id?: string;
  parent_external_id?: string;
  refs: FeishuMediaRef[];
}

export interface FeishuCursorState {
  page_token?: string;
  start_time?: string;
  sort?: "asc" | "desc";
  head_time?: string;
  recent_seeded?: boolean;
  history_token?: string;
  media_jobs?: FeishuMediaJob[];
}

export interface FeishuChatPollConnectorOptions {
  connector_id: string;
  org_id: string;
  chat_id: string;
  chat_name?: string;
  chat_mode?: FeishuChatMode;
  page_size?: number;
  now?: () => string;
  self_user_id?: string;
}

export class FeishuChatPollConnector {
  readonly source = FEISHU_SOURCE;
  private readonly pageSize: number;
  private readonly now: () => string;
  private chatName: string | undefined;
  private chatMode: FeishuChatMode | undefined;

  constructor(
    private readonly client: FeishuImClient,
    private readonly options: FeishuChatPollConnectorOptions,
  ) {
    this.pageSize = options.page_size ?? 50;
    this.chatName = options.chat_name;
    this.chatMode = options.chat_mode;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 50) {
      throw new Error("Feishu page_size must be an integer from 1 through 50");
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  describeChat(): {
    chat_id: string;
    name?: string;
    chat_mode?: FeishuChatMode;
  } {
    return {
      chat_id: this.options.chat_id,
      ...(this.chatName ? { name: this.chatName } : {}),
      ...(this.chatMode ? { chat_mode: this.chatMode } : {}),
    };
  }

  rememberChat(input: { name?: string; chat_mode?: FeishuChatMode }): void {
    if (input.name?.trim()) {
      this.chatName = input.name.trim();
    }
    if (input.chat_mode) {
      this.chatMode = input.chat_mode;
    }
  }

  private async selfUserId(): Promise<string | undefined> {
    const configured = this.options.self_user_id?.trim();
    if (configured) {
      return configured;
    }
    try {
      const id = await this.client.selfUserId?.();
      return id?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async poll(
    cursor: ConnectorCursor | null,
    options?: { older?: boolean; media?: boolean },
  ): Promise<PollResult> {
    const state = decodeFeishuCursor(cursor);
    const mediaOnly = options?.media === true;
    const wantMedia = options?.media !== false;
    const nowMs = this.clockMs();
    if (mediaOnly) {
      return this.pollMediaOnly(state, cursor, nowMs);
    }
    const request = planFeishuHistoryRequest(
      this.options.chat_id,
      this.pageSize,
      state,
      { older: options?.older === true },
    );
    if (!request && !(wantMedia && hasDueMediaJobs(state.media_jobs, nowMs))) {
      const nextCursor = encodeFeishuCursor(state);
      return {
        batch: {
          schema_version: INGEST_SCHEMA_VERSION,
          connector_id: this.options.connector_id,
          org_id: this.options.org_id,
          delivery_id: this.deliveryId(cursor?.value, nextCursor),
          received_at: this.now(),
          next_cursor: nextCursor,
          records: [],
        },
        next_cursor: nextCursor,
        has_more: false,
        media_pending: (state.media_jobs?.length ?? 0) > 0,
      };
    }
    const page = request
      ? await this.client.listMessages(request)
      : { items: [], has_more: false };
    const names = await this.resolveNames(page.items);
    const selfId = await this.selfUserId();
    const records: IngestBatch["records"] = [];
    for (const item of page.items) {
      records.push(...this.toRecord(item, names, selfId));
    }
    for (const item of page.items) {
      if (item.deleted || !item.message_id || isFeishuSelfSender(item.sender?.id, selfId)) {
        continue;
      }
      rememberFeishuInbound(this.options.chat_id, item.message_id, item.create_time);
    }
    const jobs = this.enqueueFromItems(state.media_jobs, page.items, names, selfId);
    const drained = wantMedia
      ? await this.drainMediaJobs(jobs, nowMs)
      : { records: [], jobs };
    records.push(...drained.records);
    const nextState = nextFeishuCursor(
      state,
      page,
      request?.sort_type ?? "ByCreateTimeAsc",
    );
    if (drained.jobs.length > 0) {
      nextState.media_jobs = drained.jobs;
    }
    const nextCursor = encodeFeishuCursor(nextState);
    const batch: IngestBatch = {
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: this.options.connector_id,
      org_id: this.options.org_id,
      delivery_id: this.deliveryId(cursor?.value, nextCursor),
      received_at: this.now(),
      next_cursor: nextCursor,
      records,
    };
    return {
      batch,
      next_cursor: nextCursor,
      has_more:
        Boolean(request) &&
        feishuHistoryHasMore(state, page, request?.sort_type, nextState),
      media_pending: drained.jobs.length > 0,
    };
  }

  /** Drain queued attachment downloads without touching the text watermark. */
  private async pollMediaOnly(
    state: FeishuCursorState,
    cursor: ConnectorCursor | null,
    nowMs: number,
  ): Promise<PollResult> {
    if (!hasDueMediaJobs(state.media_jobs, nowMs)) {
      const nextCursor = encodeFeishuCursor(state);
      return {
        batch: {
          schema_version: INGEST_SCHEMA_VERSION,
          connector_id: this.options.connector_id,
          org_id: this.options.org_id,
          delivery_id: this.deliveryId(cursor?.value, nextCursor),
          received_at: this.now(),
          next_cursor: nextCursor,
          records: [],
        },
        next_cursor: nextCursor,
        has_more: false,
        media_pending: (state.media_jobs?.length ?? 0) > 0,
      };
    }
    const drained = await this.drainMediaJobs(state.media_jobs ?? [], nowMs);
    const nextState: FeishuCursorState = { ...state };
    if (drained.jobs.length > 0) {
      nextState.media_jobs = drained.jobs;
    } else {
      delete nextState.media_jobs;
    }
    const nextCursor = encodeFeishuCursor(nextState);
    return {
      batch: {
        schema_version: INGEST_SCHEMA_VERSION,
        connector_id: this.options.connector_id,
        org_id: this.options.org_id,
        delivery_id: this.deliveryId(cursor?.value, nextCursor),
        received_at: this.now(),
        next_cursor: nextCursor,
        records: drained.records,
      },
      next_cursor: nextCursor,
      has_more: false,
      media_pending: drained.jobs.length > 0,
    };
  }

  private async resolveNames(
    items: FeishuHistoryItem[],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const item of items) {
      for (const [id, name] of feishuMentionNames(item.mentions)) {
        names.set(id, name);
      }
    }
    if (!this.client.resolveUserNames) {
      return names;
    }
    const ids = [
      ...new Set(
        items.flatMap((item) =>
          collectFeishuUserIds({
            sender_id: item.sender?.id,
            content: item.body?.content,
            mentions: item.mentions,
          }),
        ),
      ),
    ].filter((id) => !names.has(id));
    if (ids.length === 0) {
      return names;
    }
    const lookedUp = await this.client.resolveUserNames(ids);
    for (const [id, name] of lookedUp) {
      if (!names.has(id)) {
        names.set(id, name);
      }
    }
    return names;
  }

  private toRecord(
    item: FeishuHistoryItem,
    names: ReadonlyMap<string, string>,
    selfId?: string,
  ): IngestBatch["records"] {
    const snapshot = this.mediaSnapshot(item, names, selfId);
    if (!snapshot) {
      return [];
    }
    return [this.recordFromSnapshot(snapshot, pointerAttachments(snapshot.refs))];
  }

  private mediaSnapshot(
    item: FeishuHistoryItem,
    names: ReadonlyMap<string, string>,
    selfId?: string,
  ): Omit<FeishuMediaJob, "key" | "kind" | "filename" | "media_type" | "attempts" | "retry_after"> | undefined {
    if (item.deleted) {
      return undefined;
    }
    const kind = senderKind(item.sender?.sender_type);
    const actorId = item.sender?.id;
    const text = extractFeishuText(
      item.msg_type,
      item.body?.content,
      names,
      item.mentions,
    );
    const media = extractFeishuMedia(item.msg_type, item.body?.content);
    if (!kind || !actorId || (!text && media.length === 0)) {
      return undefined;
    }
    const chatId = this.options.chat_id;
    const rootId = emptyToUndefined(item.root_id);
    const parentId = emptyToUndefined(item.parent_id);
    const isThreadReply = Boolean(
      (rootId && rootId !== item.message_id) ||
        (parentId && parentId !== item.message_id),
    );
    return {
      message_id: item.message_id,
      occurred_at: feishuCreateTimeToIso(item.create_time, this.now()),
      actor_id: actorId,
      actor_label: this.actorLabel(item, kind, names),
      sender_kind: kind,
      direction: isFeishuSelfSender(actorId, selfId) ? "outbound" : "inbound",
      text,
      type: isThreadReply ? "thread_reply" : "message",
      parent_external_id:
        isThreadReply && (parentId || rootId)
          ? `${chatId}:${parentId ?? rootId}`
          : undefined,
      refs: media,
    };
  }

  private recordFromSnapshot(
    snapshot: Pick<
      FeishuMediaJob,
      | "message_id"
      | "occurred_at"
      | "actor_id"
      | "actor_label"
      | "sender_kind"
      | "direction"
      | "text"
      | "type"
      | "thread_id"
      | "parent_external_id"
    >,
    attachments: ContentPart[],
    operation: "create" | "revise" = "create",
  ): IngestBatch["records"][number] {
    return {
      ...channelRecord({
        channel: this.source,
        kind: snapshot.sender_kind,
        direction: snapshot.direction,
        external_id: `${this.options.chat_id}:${snapshot.message_id}`,
        occurred_at: snapshot.occurred_at,
        actor_id: snapshot.actor_id,
        actor_label: snapshot.actor_label,
        scope_id: this.options.chat_id,
        scope_name: this.chatName,
        conversation_kind: feishuConversationKind(this.chatMode),
        type: snapshot.type,
        parent_external_id: snapshot.parent_external_id,
        text: snapshot.text,
        content: attachments,
      }),
      operation,
    };
  }

  private async drainMediaJobs(
    jobs: FeishuMediaJob[],
    nowMs: number,
  ): Promise<{ records: IngestBatch["records"]; jobs: FeishuMediaJob[] }> {
    if (typeof this.client.downloadResource !== "function") {
      return { records: [], jobs };
    }
    const due = jobs.filter((job) => isDueMediaJob(job, nowMs)).slice(
      0,
      MAX_FEISHU_MEDIA_JOBS_PER_POLL,
    );
    if (due.length === 0) {
      return { records: [], jobs };
    }
    const downloaded = new Map<string, ContentPart>();
    const nextJobs: FeishuMediaJob[] = [];
    const dueKeys = new Set(due.map(mediaJobKey));
    for (const job of jobs) {
      if (!dueKeys.has(mediaJobKey(job))) {
        nextJobs.push(job);
        continue;
      }
      const part = await this.downloadMediaJob(job);
      if (part) {
        downloaded.set(mediaJobKey(job), part);
        continue;
      }
      const attempts = job.attempts + 1;
      if (attempts >= MAX_FEISHU_MEDIA_ATTEMPTS) {
        continue;
      }
      nextJobs.push({
        ...job,
        attempts,
        retry_after: nowMs + mediaRetryBackoffMs(attempts),
      });
    }
    const records = this.recordsFromDownloads(downloaded, [...due, ...nextJobs]);
    return { records, jobs: nextJobs };
  }

  private async downloadMediaJob(job: FeishuMediaJob): Promise<ContentPart | undefined> {
    if (typeof this.client.downloadResource !== "function") {
      return undefined;
    }
    try {
      const file = await this.client.downloadResource({
        message_id: job.message_id,
        file_key: job.key,
        type: job.kind,
      });
      if (
        file.bytes.byteLength === 0 ||
        file.bytes.byteLength > MAX_FEISHU_ATTACHMENT_BYTES ||
        looksLikeJsonFile(file.bytes)
      ) {
        return undefined;
      }
      const filename =
        file.filename ??
        job.filename ??
        (job.kind === "image" ? "image.png" : "attachment");
      const mediaType = sniffMediaType(
        file.bytes,
        file.media_type ||
          job.media_type ||
          (job.kind === "image" ? "image/png" : "application/octet-stream"),
      );
      return {
        role: "attachment",
        media_type: mediaType,
        source_filename: filename,
        external_locator: feishuMediaLocator(job.kind, job.key),
        bytes: file.bytes,
      };
    } catch {
      return undefined;
    }
  }

  private recordsFromDownloads(
    downloaded: Map<string, ContentPart>,
    jobs: FeishuMediaJob[],
  ): IngestBatch["records"] {
    if (downloaded.size === 0) {
      return [];
    }
    const byMessage = new Map<string, FeishuMediaJob>();
    for (const job of jobs) {
      if (!byMessage.has(job.message_id)) {
        byMessage.set(job.message_id, job);
      }
    }
    const records: IngestBatch["records"] = [];
    for (const job of byMessage.values()) {
      const attachments = job.refs.map((ref) => {
        const hit = downloaded.get(mediaJobKey({ message_id: job.message_id, key: ref.key }));
        return hit ?? pointerAttachment(ref);
      });
      if (!attachments.some((part) => part.bytes && part.bytes.byteLength > 0)) {
        continue;
      }
      records.push(this.recordFromSnapshot(job, attachments, "revise"));
    }
    return records;
  }

  private clockMs(): number {
    const parsed = Date.parse(this.now());
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  private enqueueFromItems(
    current: FeishuMediaJob[] | undefined,
    items: FeishuHistoryItem[],
    names: ReadonlyMap<string, string>,
    selfId?: string,
  ): FeishuMediaJob[] {
    const jobs = [...(current ?? [])];
    const seen = new Set(jobs.map(mediaJobKey));
    for (const item of items) {
      const snapshot = this.mediaSnapshot(item, names, selfId);
      if (!snapshot || snapshot.refs.length === 0) {
        continue;
      }
      for (const ref of snapshot.refs) {
        const key = mediaJobKey({ message_id: snapshot.message_id, key: ref.key });
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        jobs.push({
          ...snapshot,
          key: ref.key,
          kind: ref.kind,
          filename: ref.filename,
          media_type: ref.media_type,
          attempts: 0,
        });
      }
    }
    return jobs.slice(-MAX_FEISHU_MEDIA_JOBS);
  }

  private actorLabel(
    item: FeishuHistoryItem,
    kind: "user" | "assistant",
    names: ReadonlyMap<string, string>,
  ): string | undefined {
    const actorId = item.sender?.id;
    const named =
      emptyToUndefined(item.sender?.name) ??
      (actorId ? names.get(actorId) : undefined);
    if (named) {
      return named;
    }
    if (kind === "assistant" && this.chatMode === "p2p") {
      return this.chatName;
    }
    return undefined;
  }

  private deliveryId(cursor: string | undefined, nextCursor: string | undefined): string {
    const pageIdentity = [
      this.options.chat_id,
      cursor ?? "initial",
      nextCursor ?? "complete",
    ].join("\u0000");
    const hash = createHash("sha256").update(pageIdentity).digest("hex");
    return `feishu-history:${this.options.chat_id}:${hash}`;
  }
}

export function decodeFeishuCursor(cursor: ConnectorCursor | null): FeishuCursorState {
  if (!cursor?.value) {
    return {};
  }
  try {
    const parsed = JSON.parse(cursor.value) as unknown;
    if (isObject(parsed)) {
      const sort = parsed.sort === "desc" || parsed.sort === "asc" ? parsed.sort : undefined;
      const pageToken = stringValue(parsed.page_token);
      const historyToken =
        stringValue(parsed.history_token) ??
        (sort === "desc" ? pageToken : undefined);
      return {
        page_token: sort === "desc" ? undefined : pageToken,
        start_time:
          stringValue(parsed.start_time) ??
          (sort === "desc" && parsed.recent_seeded === true
            ? stringValue(parsed.head_time)
            : undefined),
        sort: sort === "desc" ? undefined : sort,
        head_time: stringValue(parsed.head_time),
        recent_seeded: parsed.recent_seeded === true,
        history_token: historyToken,
        media_jobs: decodeMediaJobs(parsed.media_jobs),
      };
    }
  } catch {
    return { page_token: cursor.value };
  }
  return {};
}

export function encodeFeishuCursor(state: FeishuCursorState): string | undefined {
  if (
    !state.page_token &&
    !state.start_time &&
    state.sort !== "desc" &&
    !state.recent_seeded &&
    !state.head_time &&
    !state.history_token &&
    (!state.media_jobs || state.media_jobs.length === 0)
  ) {
    return undefined;
  }
  return JSON.stringify({
    ...(state.page_token ? { page_token: state.page_token } : {}),
    ...(state.start_time ? { start_time: state.start_time } : {}),
    ...(state.sort === "desc" ? { sort: "desc" } : {}),
    ...(state.head_time &&
    (state.sort === "desc" || state.head_time !== state.start_time)
      ? { head_time: state.head_time }
      : {}),
    ...(state.recent_seeded ? { recent_seeded: true } : {}),
    ...(state.history_token ? { history_token: state.history_token } : {}),
    ...(state.media_jobs && state.media_jobs.length > 0
      ? { media_jobs: state.media_jobs }
      : {}),
  });
}

export function needsRecentSeed(state: FeishuCursorState): boolean {
  return !state.recent_seeded && state.sort !== "desc";
}

export function planFeishuHistoryRequest(
  chatId: string,
  pageSize: number,
  state: FeishuCursorState,
  options: { older?: boolean } = {},
): FeishuListInput | null {
  if (needsRecentSeed(state)) {
    return {
      chat_id: chatId,
      page_size: pageSize,
      sort_type: "ByCreateTimeDesc",
    };
  }
  const historyToken = deferredHistoryToken(state);
  if (options.older === true) {
    if (!historyToken) {
      return null;
    }
    return {
      chat_id: chatId,
      page_size: pageSize,
      page_token: historyToken,
      sort_type: "ByCreateTimeDesc",
    };
  }
  if (state.sort === "desc") {
    return {
      chat_id: chatId,
      page_size: pageSize,
      page_token: state.page_token,
      sort_type: "ByCreateTimeDesc",
    };
  }
  return {
    chat_id: chatId,
    page_size: pageSize,
    page_token: state.page_token,
    start_time: state.start_time,
    sort_type: "ByCreateTimeAsc",
  };
}

export function deferredHistoryToken(state: FeishuCursorState): string | undefined {
  return (
    state.history_token ??
    (state.sort === "desc" ? state.page_token : undefined)
  );
}

export function feishuHistoryHasMore(
  current: FeishuCursorState,
  page: { has_more: boolean },
  sort: FeishuSortType = "ByCreateTimeAsc",
  nextState?: FeishuCursorState,
): boolean {
  if (nextState && deferredHistoryToken(nextState)) {
    return true;
  }
  if (
    needsRecentSeed(current) &&
    sort === "ByCreateTimeDesc" &&
    current.page_token
  ) {
    return true;
  }
  return page.has_more;
}

export function nextFeishuCursor(
  current: FeishuCursorState,
  page: { items: FeishuHistoryItem[]; has_more: boolean; page_token?: string },
  sort: FeishuSortType = "ByCreateTimeAsc",
): FeishuCursorState {
  const newest = newestStartTime(page.items);
  const head = laterTime(current.head_time, newest);
  if (needsRecentSeed(current) && sort === "ByCreateTimeDesc") {
    if (current.page_token) {
      return {
        page_token: current.page_token,
        start_time: current.start_time,
        recent_seeded: true,
        ...(head ? { head_time: head } : {}),
      };
    }
    if (page.has_more && page.page_token) {
      return {
        ...(head ? { start_time: head, head_time: head } : {}),
        history_token: page.page_token,
        recent_seeded: true,
      };
    }
    return head ? { start_time: head, recent_seeded: true } : { recent_seeded: true };
  }
  if (sort === "ByCreateTimeDesc") {
    const live = current.start_time ?? current.head_time ?? head;
    if (page.has_more && page.page_token) {
      return {
        ...(live ? { start_time: live } : {}),
        ...(current.head_time || head
          ? { head_time: laterTime(current.head_time, head) }
          : {}),
        history_token: page.page_token,
        recent_seeded: true,
      };
    }
    return live ? { start_time: live, recent_seeded: true } : { recent_seeded: true };
  }
  const lastStart = lastStartTime(page.items) ?? current.start_time;
  const history = deferredHistoryToken(current);
  if (page.has_more && page.page_token) {
    return {
      page_token: page.page_token,
      ...(lastStart ? { start_time: lastStart } : {}),
      recent_seeded: true,
      ...(head && head !== lastStart ? { head_time: head } : {}),
      ...(history ? { history_token: history } : {}),
    };
  }
  const liveStart = laterTime(lastStart, current.head_time);
  return {
    ...(liveStart ? { start_time: liveStart } : {}),
    recent_seeded: true,
    ...(history ? { history_token: history } : {}),
  };
}

export function feishuMediaLocator(kind: "image" | "file", key: string): string {
  return `feishu:${kind}:${key}`;
}

export function mediaRetryBackoffMs(attempts: number): number {
  return Math.min(60_000, 1000 * 4 ** Math.max(0, attempts - 1));
}


function lastStartTime(items: FeishuHistoryItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const start = feishuCreateTimeToStartSeconds(items[index]?.create_time);
    if (start) {
      return start;
    }
  }
  return undefined;
}

function newestStartTime(items: FeishuHistoryItem[]): string | undefined {
  let newest: string | undefined;
  for (const item of items) {
    newest = laterTime(newest, feishuCreateTimeToStartSeconds(item.create_time));
  }
  return newest;
}

export function laterTime(left?: string, right?: string): string | undefined {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return Number(left) >= Number(right) ? left : right;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function pointerAttachments(refs: readonly FeishuMediaRef[]): ContentPart[] {
  return refs.map((ref) => pointerAttachment(ref));
}

export function pointerAttachment(ref: FeishuMediaRef): ContentPart {
  return {
    role: "attachment",
    media_type:
      ref.media_type ??
      (ref.kind === "image" ? "image/png" : "application/octet-stream"),
    source_filename: ref.filename ?? (ref.kind === "image" ? "image.png" : "attachment"),
    external_locator: feishuMediaLocator(ref.kind, ref.key),
  };
}

function decodeMediaJobs(value: unknown): FeishuMediaJob[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }
  const jobs = value.flatMap((item) => {
    if (!isObject(item)) {
      return [];
    }
    const messageId = stringValue(item.message_id);
    const key = stringValue(item.key);
    const kind = item.kind === "image" || item.kind === "file" ? item.kind : undefined;
    const actorId = stringValue(item.actor_id);
    const occurredAt = stringValue(item.occurred_at);
    const senderKind =
      item.sender_kind === "user" || item.sender_kind === "assistant"
        ? item.sender_kind
        : undefined;
    const direction =
      item.direction === "inbound" || item.direction === "outbound"
        ? item.direction
        : undefined;
    const refs = decodeMediaRefs(item.refs);
    if (!messageId || !key || !kind || !actorId || !occurredAt || !senderKind || !direction) {
      return [];
    }
    return [
      {
        message_id: messageId,
        key,
        kind,
        filename: stringValue(item.filename),
        media_type: stringValue(item.media_type),
        attempts: Number.isInteger(item.attempts) ? Number(item.attempts) : 0,
        retry_after:
          typeof item.retry_after === "number" && Number.isFinite(item.retry_after)
            ? item.retry_after
            : undefined,
        occurred_at: occurredAt,
        actor_id: actorId,
        actor_label: stringValue(item.actor_label),
        sender_kind: senderKind,
        direction,
        text: typeof item.text === "string" ? item.text : undefined,
        type: stringValue(item.type),
        thread_id: stringValue(item.thread_id),
        parent_external_id: stringValue(item.parent_external_id),
        refs: refs.length > 0 ? refs : [{ kind, key, filename: stringValue(item.filename) }],
      } satisfies FeishuMediaJob,
    ];
  });
  return jobs.length > 0 ? jobs : undefined;
}

function decodeMediaRefs(value: unknown): FeishuMediaRef[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isObject(item)) {
      return [];
    }
    const key = stringValue(item.key);
    const kind = item.kind === "image" || item.kind === "file" ? item.kind : undefined;
    if (!key || !kind) {
      return [];
    }
    return [
      {
        kind,
        key,
        filename: stringValue(item.filename),
        media_type: stringValue(item.media_type),
      },
    ];
  });
}

function hasDueMediaJobs(jobs: FeishuMediaJob[] | undefined, nowMs: number): boolean {
  return Boolean(jobs?.some((job) => isDueMediaJob(job, nowMs)));
}

function isDueMediaJob(job: FeishuMediaJob, nowMs: number): boolean {
  return job.attempts < MAX_FEISHU_MEDIA_ATTEMPTS && (job.retry_after ?? 0) <= nowMs;
}

function mediaJobKey(job: { message_id: string; key: string }): string {
  return `${job.message_id}:${job.key}`;
}

function looksLikeJsonFile(bytes: Uint8Array): boolean {
  let index = 0;
  while (
    index < bytes.length &&
    (bytes[index] === 0x09 ||
      bytes[index] === 0x0a ||
      bytes[index] === 0x0d ||
      bytes[index] === 0x20)
  ) {
    index += 1;
  }
  if (index >= bytes.length || (bytes[index] !== 0x7b && bytes[index] !== 0x5b)) {
    return false;
  }
  try {
    JSON.parse(Buffer.from(bytes).toString("utf8"));
    return true;
  } catch {
    return false;
  }
}
