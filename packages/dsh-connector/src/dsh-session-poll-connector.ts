import { createHash } from "node:crypto";
import {
  INGEST_SCHEMA_VERSION,
  type ConnectorCursor,
  type IngestBatch,
  type IngestRecord,
  type PollResult,
} from "@regenic/domain";
import { DshApiError, type DshHistoryEvent, type DshHistoryPage } from "./dsh-cli-client";

export const DSH_SOURCE = "dsh";

export interface DshSurfaceEvent {
  type: "user/message" | "assistant/message";
  seq: number;
  time: number;
  actor_id: string;
  data: { content: Array<{ type: "text"; text: string }> };
}

export interface DshSessionPollConnectorOptions {
  connector_id: string;
  org_id: string;
  session_id: string;
  page_size?: number;
  now?: () => string;
}

export interface DshSessionHistoryClient {
  sessionHistory(input: {
    sessionId: string;
    maxMessages?: number;
  }): Promise<DshHistoryPage>;
}

export class DshSessionPollConnector {
  readonly source = DSH_SOURCE;
  lastSurfacePage: { events: DshSurfaceEvent[]; hasMore: boolean } = {
    events: [],
    hasMore: false,
  };
  private readonly pageSize: number;
  private readonly now: () => string;

  constructor(
    private readonly client: DshSessionHistoryClient,
    private readonly options: DshSessionPollConnectorOptions,
  ) {
    this.pageSize = options.page_size ?? 20;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 100) {
      throw new Error("DSH page_size must be an integer from 1 through 100");
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async poll(cursor: ConnectorCursor | null): Promise<PollResult> {
    const afterSeq = parseCursor(cursor);
    const page = await this.client.sessionHistory({
      sessionId: this.options.session_id,
      maxMessages: this.pageSize,
    });
    const surface = page.events
      .flatMap((event) => toSurfaceEvent(event))
      .filter((event) => event.seq > afterSeq)
      .sort((left, right) => left.seq - right.seq);
    this.lastSurfacePage = { events: surface, hasMore: page.hasMore };
    const pageMaxSeq = page.events.reduce(
      (max, event) => (Number.isInteger(event.seq) ? Math.max(max, event.seq) : max),
      afterSeq,
    );
    const nextCursor = pageMaxSeq >= 0 ? String(pageMaxSeq) : undefined;
    const batch: IngestBatch = {
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: this.options.connector_id,
      org_id: this.options.org_id,
      delivery_id: this.deliveryId(cursor?.value, nextCursor),
      received_at: this.now(),
      next_cursor: nextCursor,
      records: surface.map((event) => this.toRecord(event)),
    };
    return { batch, next_cursor: nextCursor };
  }

  private toRecord(event: DshSurfaceEvent): IngestRecord {
    return {
      operation: "create",
      source: this.source,
      external_id: `${this.options.session_id}:${event.seq}`,
      occurred_at: new Date(event.time).toISOString(),
      actor: { id: event.actor_id },
      scope: { id: this.options.session_id },
      type: "message",
      content: [
        {
          role: "body",
          media_type: "text/plain",
          text: event.data.content.map((part) => part.text).join(""),
        },
      ],
      direction_tags: [event.type === "user/message" ? "outbound" : "inbound"],
    };
  }

  private deliveryId(
    cursor: string | undefined,
    nextCursor: string | undefined,
  ): string {
    const pageIdentity = [
      this.options.session_id,
      cursor ?? "initial",
      nextCursor ?? "complete",
    ].join("\u0000");
    const hash = createHash("sha256").update(pageIdentity).digest("hex");
    return `dsh-history:${this.options.session_id}:${hash}`;
  }
}

export function toSurfaceEvent(event: DshHistoryEvent): DshSurfaceEvent[] {
  if (event.type !== "user/message" && event.type !== "assistant/message") {
    return [];
  }
  const text = extractText(event.data, event.type);
  if (!text) {
    return [];
  }
  if (!Number.isInteger(event.seq) || event.seq < 0 || !Number.isFinite(event.time)) {
    throw new DshApiError(`DSH event seq or time is invalid: ${event.seq}`);
  }
  return [
    {
      type: event.type,
      seq: event.seq,
      time: event.time,
      actor_id:
        event.type === "user/message" ? userActorFromData(event.data) : "assistant",
      data: { content: [{ type: "text", text }] },
    },
  ];
}

function parseCursor(cursor: ConnectorCursor | null): number {
  if (!cursor?.value) {
    return -1;
  }
  const seq = Number(cursor.value);
  if (!Number.isInteger(seq) || seq < 0) {
    throw new DshApiError(`DSH cursor is invalid: ${cursor.value}`);
  }
  return seq;
}

function extractText(
  data: unknown,
  type: "user/message" | "assistant/message",
): string | undefined {
  const message = type === "assistant/message" && isObject(data) ? data.message : data;
  if (!isObject(message) || !Array.isArray(message.content)) {
    return undefined;
  }
  const text = message.content
    .flatMap((block) =>
      isObject(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("");
  return text.length > 0 ? text : undefined;
}

function userActorFromData(data: unknown): string {
  if (
    isObject(data) &&
    isObject(data.source) &&
    typeof data.source.kind === "string" &&
    data.source.kind.trim().length > 0
  ) {
    return data.source.kind;
  }
  return "user";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
