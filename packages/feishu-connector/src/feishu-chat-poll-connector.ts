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
export const FEISHU_DOWNLOAD_ATTEMPTS = 3;
export const FEISHU_DOWNLOAD_RETRY_MS = 200;
export const FEISHU_MEDIA_RETRY_MAX_MS = 15 * 60 * 1000;

export interface FeishuCursorState {
  page_token?: string;
  start_time?: string;
  sort?: "asc" | "desc";
  head_time?: string;
  recent_seeded?: boolean;
  history_token?: string;
  media_synced?: boolean;
  media_bytes?: boolean;
  media_ok?: boolean;
  media_retry?: boolean;
  media_attempts?: number;
  media_retry_after?: string;
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
  sleep?: (ms: number) => Promise<void>;
}

export class FeishuChatPollConnector {
  readonly source = FEISHU_SOURCE;
  private readonly pageSize: number;
  private readonly now: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
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
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
    const wantMedia = options?.media !== false;
    const nowMs = parsedNowMs(this.now());
    const reseeding = needsRecentSeed(state) || needsMediaReseed(state, nowMs);
    const request = planFeishuHistoryRequest(
      this.options.chat_id,
      this.pageSize,
      state,
      { older: options?.older === true, now: nowMs },
    );
    if (!request) {
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
      };
    }
    const page = await this.client.listMessages(request);
    const names = await this.resolveNames(page.items);
    const selfId = await this.selfUserId();
    const records: IngestBatch["records"] = [];
    let retryableMedia = false;
    for (const item of page.items) {
      const mapped = await this.toRecord(item, names, selfId, wantMedia);
      records.push(...mapped.records);
      if (mapped.retryable) {
        retryableMedia = true;
      }
    }
    for (const item of page.items) {
      if (item.deleted || !item.message_id || isFeishuSelfSender(item.sender?.id, selfId)) {
        continue;
      }
      rememberFeishuInbound(this.options.chat_id, item.message_id, item.create_time);
    }
    const nextState = nextFeishuCursor(state, page, request.sort_type, {
      media: wantMedia,
      mediaComplete: !retryableMedia,
      reseed: reseeding,
      now: this.now(),
      attempts: state.media_attempts ?? 0,
    });
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
      has_more: feishuHistoryHasMore(state, page, request.sort_type, nextState),
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

  private async toRecord(
    item: FeishuHistoryItem,
    names: ReadonlyMap<string, string>,
    selfId?: string,
    wantMedia = true,
  ): Promise<{ records: IngestBatch["records"]; retryable: boolean }> {
    if (item.deleted) {
      return { records: [], retryable: false };
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
      return { records: [], retryable: false };
    }
    const resolved = wantMedia
      ? await this.resolveAttachments(item.message_id, media)
      : {
          parts: media.map((ref) =>
            placeholderAttachment(
              ref.filename ?? (ref.kind === "image" ? "image.png" : "attachment"),
              ref.media_type ??
                (ref.kind === "image" ? "image/png" : "application/octet-stream"),
            ),
          ),
          retryable: false,
        };
    const attachments = resolved.parts;
    const chatId = this.options.chat_id;
    const rootId = emptyToUndefined(item.root_id);
    const parentId = emptyToUndefined(item.parent_id);
    const isThreadReply = Boolean(
      (rootId && rootId !== item.message_id) ||
        (parentId && parentId !== item.message_id),
    );
    const threadRoot = rootId && rootId !== item.message_id ? rootId : parentId;
    const record = channelRecord({
      channel: this.source,
      kind,
      direction: isFeishuSelfSender(actorId, selfId) ? "outbound" : "inbound",
      external_id: `${chatId}:${item.message_id}`,
      occurred_at: feishuCreateTimeToIso(item.create_time, this.now()),
      actor_id: actorId,
      actor_label: this.actorLabel(item, kind, names),
      scope_id: chatId,
      scope_name: this.chatName,
      conversation_kind: feishuConversationKind(this.chatMode),
      type: isThreadReply ? "thread_reply" : "message",
      thread_id: isThreadReply && threadRoot ? `${chatId}:${threadRoot}` : undefined,
      parent_external_id:
        isThreadReply && (parentId || rootId)
          ? `${chatId}:${parentId ?? rootId}`
          : undefined,
      text,
      content: attachments,
    });
    if (attachments.some((part) => part.bytes !== undefined && part.bytes.byteLength > 0)) {
      return {
        records: [record, { ...record, operation: "revise" }],
        retryable: resolved.retryable,
      };
    }
    return { records: [record], retryable: resolved.retryable };
  }

  private async resolveAttachments(
    messageId: string,
    refs: FeishuMediaRef[],
  ): Promise<{ parts: ContentPart[]; retryable: boolean }> {
    const parts: ContentPart[] = [];
    let retryable = false;
    for (const ref of refs) {
      const resolved = await this.resolveAttachment(messageId, ref);
      parts.push(resolved.part);
      if (resolved.retryable) {
        retryable = true;
      }
    }
    return { parts, retryable };
  }

  private async resolveAttachment(
    messageId: string,
    ref: FeishuMediaRef,
  ): Promise<{ part: ContentPart; retryable: boolean }> {
    const filename = ref.filename ?? (ref.kind === "image" ? "image.png" : "attachment");
    const fallbackType =
      ref.media_type ?? (ref.kind === "image" ? "image/png" : "application/octet-stream");
    if (typeof this.client.downloadResource !== "function") {
      return {
        part: placeholderAttachment(filename, fallbackType),
        retryable: true,
      };
    }
    let lastFilename = filename;
    let lastType = fallbackType;
    for (let attempt = 1; attempt <= FEISHU_DOWNLOAD_ATTEMPTS; attempt += 1) {
      try {
        const file = await this.client.downloadResource({
          message_id: messageId,
          file_key: ref.key,
          type: ref.kind,
        });
        lastFilename = file.filename ?? filename;
        lastType = file.media_type || fallbackType;
        if (file.bytes.byteLength > MAX_FEISHU_ATTACHMENT_BYTES) {
          return {
            part: placeholderAttachment(lastFilename, lastType),
            retryable: false,
          };
        }
        if (file.bytes.byteLength > 0) {
          return {
            part: {
              role: "attachment",
              media_type: sniffMediaType(file.bytes, lastType),
              source_filename: lastFilename,
              bytes: file.bytes,
            },
            retryable: false,
          };
        }
      } catch {
        // Timeouts and JSON-instead-of-bytes are retried below.
      }
      if (attempt < FEISHU_DOWNLOAD_ATTEMPTS) {
        await this.sleep(FEISHU_DOWNLOAD_RETRY_MS * attempt);
      }
    }
    return {
      part: placeholderAttachment(lastFilename, lastType),
      retryable: true,
    };
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
        media_synced: parsed.media_synced === true,
        media_bytes: parsed.media_bytes === true,
        media_ok: parsed.media_ok === true,
        media_retry: parsed.media_retry === true,
        media_attempts: integerValue(parsed.media_attempts),
        media_retry_after: stringValue(parsed.media_retry_after),
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
    !state.media_synced &&
    !state.media_bytes &&
    !state.media_ok &&
    !state.media_retry &&
    !state.media_retry_after &&
    !state.media_attempts
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
    ...(state.media_synced ? { media_synced: true } : {}),
    ...(state.media_bytes ? { media_bytes: true } : {}),
    ...(state.media_ok ? { media_ok: true } : {}),
    ...(state.media_retry ? { media_retry: true } : {}),
    ...(state.media_attempts && state.media_attempts > 0
      ? { media_attempts: state.media_attempts }
      : {}),
    ...(state.media_retry_after ? { media_retry_after: state.media_retry_after } : {}),
  });
}

export function needsRecentSeed(state: FeishuCursorState): boolean {
  return !state.recent_seeded && state.sort !== "desc";
}

export function needsMediaReseed(state: FeishuCursorState, nowMs = Date.now()): boolean {
  if (state.recent_seeded !== true || state.sort === "desc") {
    return false;
  }
  if (state.media_retry !== true) {
    return true;
  }
  if (state.media_ok === true) {
    return false;
  }
  return mediaRetryDue(state, nowMs);
}

export function mediaRetryBackoffMs(attempt: number): number {
  const exp = Math.max(0, attempt - 1);
  return Math.min(FEISHU_MEDIA_RETRY_MAX_MS, 1000 * 2 ** Math.min(exp, 20));
}

export function mediaRetryDue(state: FeishuCursorState, nowMs = Date.now()): boolean {
  if (!state.media_retry_after) {
    return true;
  }
  const at = Date.parse(state.media_retry_after);
  return !Number.isFinite(at) || nowMs >= at;
}

export function planFeishuHistoryRequest(
  chatId: string,
  pageSize: number,
  state: FeishuCursorState,
  options: { older?: boolean; now?: number } = {},
): FeishuListInput | null {
  if (needsRecentSeed(state) || needsMediaReseed(state, options.now)) {
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
    (needsRecentSeed(current) || needsMediaReseed(current)) &&
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
  options: {
    media?: boolean;
    mediaComplete?: boolean;
    reseed?: boolean;
    now?: string;
    attempts?: number;
  } = {},
): FeishuCursorState {
  const newest = newestStartTime(page.items);
  const head = laterTime(current.head_time, newest);
  const now = options.now ?? new Date().toISOString();
  const nowMs = parsedNowMs(now);
  const stamp = (state: FeishuCursorState) =>
    applyMediaStamp(state, {
      media: options.media !== false,
      complete: options.mediaComplete !== false,
      reseed: options.reseed !== false,
      now,
      attempts: options.attempts ?? current.media_attempts ?? 0,
      previous: current,
    });
  if (needsRecentSeed(current) && sort === "ByCreateTimeDesc") {
    if (current.page_token) {
      return stamp({
        page_token: current.page_token,
        start_time: current.start_time,
        recent_seeded: true,
        ...(head ? { head_time: head } : {}),
      });
    }
    if (page.has_more && page.page_token) {
      return stamp({
        ...(head ? { start_time: head, head_time: head } : {}),
        history_token: page.page_token,
        recent_seeded: true,
      });
    }
    return stamp(
      head ? { start_time: head, recent_seeded: true } : { recent_seeded: true },
    );
  }
  if (needsMediaReseed(current, nowMs) && sort === "ByCreateTimeDesc") {
    const live = laterTime(current.start_time, head);
    return stamp({
      ...(current.page_token ? { page_token: current.page_token } : {}),
      ...(live ? { start_time: live } : {}),
      recent_seeded: true,
      ...(head && head !== live ? { head_time: head } : {}),
    });
  }
  if (sort === "ByCreateTimeDesc") {
    const live = current.start_time ?? current.head_time ?? head;
    if (page.has_more && page.page_token) {
      return stamp({
        ...(live ? { start_time: live } : {}),
        ...(current.head_time || head
          ? { head_time: laterTime(current.head_time, head) }
          : {}),
        history_token: page.page_token,
        recent_seeded: true,
      });
    }
    return stamp(
      live ? { start_time: live, recent_seeded: true } : { recent_seeded: true },
    );
  }
  const lastStart = lastStartTime(page.items) ?? current.start_time;
  const history = deferredHistoryToken(current);
  if (page.has_more && page.page_token) {
    return stamp({
      page_token: page.page_token,
      ...(lastStart ? { start_time: lastStart } : {}),
      recent_seeded: true,
      ...(head && head !== lastStart ? { head_time: head } : {}),
      ...(history ? { history_token: history } : {}),
    });
  }
  const liveStart = laterTime(lastStart, current.head_time);
  return stamp({
    ...(liveStart ? { start_time: liveStart } : {}),
    recent_seeded: true,
    ...(history ? { history_token: history } : {}),
  });
}

function applyMediaStamp(
  state: FeishuCursorState,
  input: {
    media: boolean;
    complete: boolean;
    reseed: boolean;
    now: string;
    attempts: number;
    previous: FeishuCursorState;
  },
): FeishuCursorState {
  if (!input.media) {
    return copyMediaFlags(input.previous, state);
  }
  if (!input.complete) {
    return stampMediaRetry(state, input.now, input.attempts);
  }
  if (input.reseed) {
    return stampMediaSynced(state);
  }
  return copyMediaFlags(input.previous, state);
}

function stampMediaSynced(state: FeishuCursorState): FeishuCursorState {
  return {
    ...state,
    media_synced: true,
    media_bytes: true,
    media_ok: true,
    media_retry: true,
  };
}

function stampMediaRetry(
  state: FeishuCursorState,
  now: string,
  attempts: number,
): FeishuCursorState {
  const nextAttempts = attempts + 1;
  const after = new Date(
    parsedNowMs(now) + mediaRetryBackoffMs(nextAttempts),
  ).toISOString();
  return {
    ...state,
    media_synced: true,
    media_bytes: true,
    media_retry: true,
    media_attempts: nextAttempts,
    media_retry_after: after,
  };
}

function copyMediaFlags(
  from: FeishuCursorState,
  state: FeishuCursorState,
): FeishuCursorState {
  return {
    ...state,
    ...(from.media_synced ? { media_synced: true } : {}),
    ...(from.media_bytes ? { media_bytes: true } : {}),
    ...(from.media_ok ? { media_ok: true } : {}),
    ...(from.media_retry ? { media_retry: true } : {}),
    ...(from.media_attempts && from.media_attempts > 0
      ? { media_attempts: from.media_attempts }
      : {}),
    ...(from.media_retry_after ? { media_retry_after: from.media_retry_after } : {}),
  };
}

function placeholderAttachment(filename: string, mediaType: string): ContentPart {
  return {
    role: "attachment",
    media_type: mediaType,
    source_filename: filename,
    bytes: new Uint8Array(),
  };
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

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function parsedNowMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
