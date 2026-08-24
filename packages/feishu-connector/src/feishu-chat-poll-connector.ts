import { createHash } from "node:crypto";
import {
  INGEST_SCHEMA_VERSION,
  channelRecord,
  type ConnectorCursor,
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
import {
  FEISHU_SOURCE,
  collectFeishuUserIds,
  extractFeishuText,
  feishuConversationKind,
  feishuCreateTimeToIso,
  feishuCreateTimeToStartSeconds,
  feishuMentionNames,
  senderKind,
} from "./feishu-message";

export interface FeishuCursorState {
  page_token?: string;
  start_time?: string;
  sort?: "asc" | "desc";
  head_time?: string;
  recent_seeded?: boolean;
}

export interface FeishuChatPollConnectorOptions {
  connector_id: string;
  org_id: string;
  chat_id: string;
  chat_name?: string;
  chat_mode?: FeishuChatMode;
  page_size?: number;
  now?: () => string;
}

export class FeishuChatPollConnector {
  readonly source = FEISHU_SOURCE;
  private readonly pageSize: number;
  private readonly now: () => string;

  constructor(
    private readonly client: FeishuImClient,
    private readonly options: FeishuChatPollConnectorOptions,
  ) {
    this.pageSize = options.page_size ?? 50;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 50) {
      throw new Error("Feishu page_size must be an integer from 1 through 50");
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async poll(cursor: ConnectorCursor | null): Promise<PollResult> {
    const state = decodeFeishuCursor(cursor);
    const request = planFeishuHistoryRequest(
      this.options.chat_id,
      this.pageSize,
      state,
    );
    const page = await this.client.listMessages(request);
    const names = await this.resolveNames(page.items);
    const records = page.items.flatMap((item) => this.toRecord(item, names));
    const nextState = nextFeishuCursor(state, page, request.sort_type);
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
      has_more: feishuHistoryHasMore(state, page, request.sort_type),
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
  ): IngestBatch["records"] {
    if (item.deleted) {
      return [];
    }
    const kind = senderKind(item.sender?.sender_type);
    const actorId = item.sender?.id;
    const text = extractFeishuText(
      item.msg_type,
      item.body?.content,
      names,
      item.mentions,
    );
    if (!kind || !actorId || !text) {
      return [];
    }
    const chatId = this.options.chat_id;
    const rootId = emptyToUndefined(item.root_id);
    const parentId = emptyToUndefined(item.parent_id);
    const isThreadReply = Boolean(
      (rootId && rootId !== item.message_id) ||
        (parentId && parentId !== item.message_id),
    );
    const threadRoot = rootId && rootId !== item.message_id ? rootId : parentId;
    return [
      channelRecord({
        channel: this.source,
        kind,
        direction: "inbound",
        external_id: `${chatId}:${item.message_id}`,
        occurred_at: feishuCreateTimeToIso(item.create_time, this.now()),
        actor_id: actorId,
        actor_label: this.actorLabel(item, kind, names),
        scope_id: chatId,
        scope_name: this.options.chat_name,
        conversation_kind: feishuConversationKind(this.options.chat_mode),
        type: isThreadReply ? "thread_reply" : "message",
        thread_id: isThreadReply && threadRoot ? `${chatId}:${threadRoot}` : undefined,
        parent_external_id:
          isThreadReply && (parentId || rootId)
            ? `${chatId}:${parentId ?? rootId}`
            : undefined,
        text,
      }),
    ];
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
    if (kind === "assistant" && this.options.chat_mode === "p2p") {
      return this.options.chat_name;
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
      return {
        page_token: stringValue(parsed.page_token),
        start_time: stringValue(parsed.start_time),
        sort,
        head_time: stringValue(parsed.head_time),
        recent_seeded: parsed.recent_seeded === true,
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
    !state.head_time
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
  });
}

export function needsRecentSeed(state: FeishuCursorState): boolean {
  return !state.recent_seeded && state.sort !== "desc";
}

export function planFeishuHistoryRequest(
  chatId: string,
  pageSize: number,
  state: FeishuCursorState,
): FeishuListInput {
  if (needsRecentSeed(state)) {
    return {
      chat_id: chatId,
      page_size: pageSize,
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

export function feishuHistoryHasMore(
  current: FeishuCursorState,
  page: { has_more: boolean },
  sort: FeishuSortType = "ByCreateTimeAsc",
): boolean {
  if (needsRecentSeed(current) && sort === "ByCreateTimeDesc" && current.page_token) {
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
        page_token: page.page_token,
        sort: "desc",
        recent_seeded: true,
        ...(head ? { head_time: head } : {}),
      };
    }
    return head ? { start_time: head, recent_seeded: true } : { recent_seeded: true };
  }
  if (sort === "ByCreateTimeDesc") {
    if (page.has_more && page.page_token) {
      return {
        page_token: page.page_token,
        sort: "desc",
        recent_seeded: true,
        ...(head ? { head_time: head } : current.head_time ? { head_time: current.head_time } : {}),
      };
    }
    const live = current.head_time ?? head;
    return live ? { start_time: live, recent_seeded: true } : { recent_seeded: true };
  }
  const lastStart = lastStartTime(page.items) ?? current.start_time;
  if (page.has_more && page.page_token) {
    return {
      page_token: page.page_token,
      ...(lastStart ? { start_time: lastStart } : {}),
      recent_seeded: true,
      ...(head && head !== lastStart ? { head_time: head } : {}),
    };
  }
  const liveStart = laterTime(lastStart, current.head_time);
  return liveStart ? { start_time: liveStart, recent_seeded: true } : { recent_seeded: true };
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
