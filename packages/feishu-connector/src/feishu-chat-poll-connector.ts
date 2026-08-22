import { createHash } from "node:crypto";
import {
  INGEST_SCHEMA_VERSION,
  channelRecord,
  type ConnectorCursor,
  type IngestBatch,
  type PollResult,
} from "@regenic/domain";
import type { FeishuHistoryItem, FeishuImClient } from "./feishu-cli-client";
import {
  FEISHU_SOURCE,
  extractFeishuText,
  feishuCreateTimeToIso,
  feishuCreateTimeToStartSeconds,
  senderKind,
} from "./feishu-message";

export interface FeishuCursorState {
  page_token?: string;
  start_time?: string;
}

export interface FeishuChatPollConnectorOptions {
  connector_id: string;
  org_id: string;
  chat_id: string;
  chat_name?: string;
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
    this.pageSize = options.page_size ?? 20;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 50) {
      throw new Error("Feishu page_size must be an integer from 1 through 50");
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async poll(cursor: ConnectorCursor | null): Promise<PollResult> {
    const state = decodeFeishuCursor(cursor);
    const page = await this.client.listMessages({
      chat_id: this.options.chat_id,
      page_size: this.pageSize,
      page_token: state.page_token,
      start_time: state.start_time,
    });
    const records = page.items.flatMap((item) => this.toRecord(item));
    const nextCursor = encodeFeishuCursor(nextFeishuCursor(state, page));
    const batch: IngestBatch = {
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: this.options.connector_id,
      org_id: this.options.org_id,
      delivery_id: this.deliveryId(cursor?.value, nextCursor),
      received_at: this.now(),
      next_cursor: nextCursor,
      records,
    };
    return { batch, next_cursor: nextCursor };
  }

  private toRecord(item: FeishuHistoryItem): IngestBatch["records"] {
    if (item.deleted) {
      return [];
    }
    const kind = senderKind(item.sender?.sender_type);
    const actorId = item.sender?.id;
    const text = extractFeishuText(item.msg_type, item.body?.content);
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
        scope_id: chatId,
        scope_name: this.options.chat_name,
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
      return {
        page_token: stringValue(parsed.page_token),
        start_time: stringValue(parsed.start_time),
      };
    }
  } catch {
    return { page_token: cursor.value };
  }
  return {};
}

export function encodeFeishuCursor(state: FeishuCursorState): string | undefined {
  if (!state.page_token && !state.start_time) {
    return undefined;
  }
  return JSON.stringify({
    ...(state.page_token ? { page_token: state.page_token } : {}),
    ...(state.start_time ? { start_time: state.start_time } : {}),
  });
}

export function nextFeishuCursor(
  current: FeishuCursorState,
  page: { items: FeishuHistoryItem[]; has_more: boolean; page_token?: string },
): FeishuCursorState {
  const lastStart = lastStartTime(page.items) ?? current.start_time;
  if (page.has_more && page.page_token) {
    return {
      page_token: page.page_token,
      ...(lastStart ? { start_time: lastStart } : {}),
    };
  }
  return lastStart ? { start_time: lastStart } : {};
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

function emptyToUndefined(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
