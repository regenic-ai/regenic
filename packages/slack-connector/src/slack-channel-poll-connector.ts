import { createHash } from "node:crypto";
import {
  INGEST_SCHEMA_VERSION,
  channelRecord,
  type ConnectorCursor,
  type IngestBatch,
  type PollResult,
  type SyncPollHint,
} from "@regenic/domain";

export interface SlackHistoryMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
  thread_ts?: string;
  subtype?: string;
}

export interface SlackHistoryPage {
  ok: boolean;
  error?: string;
  messages?: SlackHistoryMessage[];
  response_metadata?: { next_cursor?: string };
}

export interface SlackHistoryClient {
  conversationsHistory(input: {
    channel: string;
    cursor?: string;
    limit: number;
  }): Promise<SlackHistoryPage>;
}

export interface SlackFetchResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

export type SlackFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<SlackFetchResponse>;

export interface SlackWebApiHistoryClientOptions {
  access_token: string;
  endpoint?: string;
  fetch?: SlackFetch;
}

export class SlackWebApiHistoryClient implements SlackHistoryClient {
  private readonly endpoint: string;
  private readonly fetch: SlackFetch;

  constructor(private readonly options: SlackWebApiHistoryClientOptions) {
    this.endpoint = options.endpoint ?? "https://slack.com/api/conversations.history";
    this.fetch = options.fetch ?? fetch;
  }

  async conversationsHistory(input: {
    channel: string;
    cursor?: string;
    limit: number;
  }): Promise<SlackHistoryPage> {
    const query = new URLSearchParams({
      channel: input.channel,
      limit: String(input.limit),
    });
    if (input.cursor) {
      query.set("cursor", input.cursor);
    }
    const response = await this.fetch(`${this.endpoint}?${query.toString()}`, {
      headers: { authorization: `Bearer ${this.options.access_token}` },
    });
    if (!response.ok) {
      throw new SlackApiError("Slack conversations.history HTTP request failed");
    }
    return parseSlackHistoryPage(await response.json());
  }
}

export interface SlackChannelPollConnectorOptions {
  connector_id: string;
  org_id: string;
  channel_id: string;
  channel_name?: string;
  page_size?: number;
  now?: () => string;
}

export class SlackApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackApiError";
  }
}

export class SlackChannelPollConnector {
  readonly source = "slack";
  private readonly pageSize: number;
  private readonly now: () => string;

  constructor(
    private readonly client: SlackHistoryClient,
    private readonly options: SlackChannelPollConnectorOptions,
  ) {
    this.pageSize = options.page_size ?? 100;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 200) {
      throw new Error("Slack page_size must be an integer from 1 through 200");
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async poll(cursor: ConnectorCursor | null): Promise<PollResult> {
    const page = await this.client.conversationsHistory({
      channel: this.options.channel_id,
      cursor: cursor?.value,
      limit: this.pageSize,
    });
    if (!page.ok) {
      throw new SlackApiError(page.error ?? "Slack conversations.history failed");
    }
    const nextCursor = page.response_metadata?.next_cursor || undefined;
    const batch: IngestBatch = {
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: this.options.connector_id,
      org_id: this.options.org_id,
      delivery_id: this.deliveryId(cursor?.value, nextCursor),
      received_at: this.now(),
      next_cursor: nextCursor,
      records: (page.messages ?? []).flatMap((message) =>
        this.toRecord(message),
      ),
    };
    return {
      batch,
      next_cursor: nextCursor,
      has_more: Boolean(nextCursor),
      poll_hint: slackPollHint(cursor?.value, Boolean(nextCursor)),
    };
  }

  private toRecord(message: SlackHistoryMessage): IngestBatch["records"] {
    if (!message.ts || !message.text || (!message.user && !message.bot_id)) {
      return [];
    }
    const actorId = message.user ?? `bot:${message.bot_id}`;
    const isThreadReply = Boolean(message.thread_ts && message.thread_ts !== message.ts);
    const record = channelRecord({
      channel: this.source,
      kind: message.bot_id ? "assistant" : "user",
      direction: "inbound",
      external_id: `${this.options.channel_id}:${message.ts}`,
      occurred_at: slackTimestampToIso(message.ts),
      actor_id: actorId,
      scope_id: this.options.channel_id,
      scope_name: this.options.channel_name,
      type: isThreadReply ? "thread_reply" : "message",
      parent_external_id: isThreadReply
        ? `${this.options.channel_id}:${message.thread_ts}`
        : undefined,
      text: message.text,
    });
    if (message.subtype) {
      record.attrs = { slack_subtype: message.subtype };
    }
    return [record];
  }

  private deliveryId(cursor: string | undefined, nextCursor: string | undefined): string {
    const pageIdentity = [
      this.options.channel_id,
      cursor ?? "initial",
      nextCursor ?? "complete",
    ].join("\u0000");
    const hash = createHash("sha256").update(pageIdentity).digest("hex");
    return `slack-history:${this.options.channel_id}:${hash}`;
  }
}

export function slackPollHint(
  previousCursor: string | undefined,
  hasMore: boolean,
): SyncPollHint {
  return {
    live_seeded: previousCursor !== undefined || !hasMore,
    history_pending: hasMore,
  };
}

function slackTimestampToIso(timestamp: string): string {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) {
    throw new SlackApiError(`Slack message timestamp is invalid: ${timestamp}`);
  }
  return new Date(seconds * 1_000).toISOString();
}

function parseSlackHistoryPage(value: unknown): SlackHistoryPage {
  if (!isObject(value) || typeof value.ok !== "boolean") {
    throw new SlackApiError("Slack conversations.history response is invalid");
  }
  return {
    ok: value.ok,
    error: stringValue(value.error),
    messages: Array.isArray(value.messages)
      ? value.messages.flatMap((message) => {
          if (!isObject(message) || typeof message.ts !== "string") {
            return [];
          }
          return [{
            ts: message.ts,
            user: stringValue(message.user),
            bot_id: stringValue(message.bot_id),
            text: stringValue(message.text),
            thread_ts: stringValue(message.thread_ts),
            subtype: stringValue(message.subtype),
          }];
        })
      : undefined,
    response_metadata: isObject(value.response_metadata)
      ? { next_cursor: stringValue(value.response_metadata.next_cursor) }
      : undefined,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}