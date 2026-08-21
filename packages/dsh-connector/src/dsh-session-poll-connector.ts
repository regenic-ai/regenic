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
export const DSH_MAX_HISTORY_PAGES = 100;

export interface DshSurfaceEvent {
  type: "user/message" | "assistant/message";
  seq: number;
  time: number;
  actor_id: string;
  data: { content: Array<{ type: "text"; text: string }> };
}

export interface DshHistoryQuery {
  maxMessages?: number;
  beforeSeq?: number;
}

export interface DshSessionPollConnectorOptions {
  connector_id: string;
  org_id: string;
  session_id: string;
  page_size?: number;
  max_history_pages?: number;
  now?: () => string;
}

export interface DshSessionHistoryClient {
  sessionHistory(input: {
    sessionId: string;
    maxMessages?: number;
    beforeSeq?: number;
  }): Promise<DshHistoryPage>;
}

export class DshSessionPollConnector {
  readonly source = DSH_SOURCE;
  lastSurfacePage: { events: DshSurfaceEvent[]; hasMore: boolean } = {
    events: [],
    hasMore: false,
  };
  private readonly pageSize: number;
  private readonly maxHistoryPages: number;
  private readonly now: () => string;

  constructor(
    private readonly client: DshSessionHistoryClient,
    private readonly options: DshSessionPollConnectorOptions,
  ) {
    this.pageSize = options.page_size ?? 20;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1 || this.pageSize > 100) {
      throw new Error("DSH page_size must be an integer from 1 through 100");
    }
    this.maxHistoryPages = options.max_history_pages ?? DSH_MAX_HISTORY_PAGES;
    if (!Number.isInteger(this.maxHistoryPages) || this.maxHistoryPages < 1) {
      throw new Error("DSH max_history_pages must be a positive integer");
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async historyPage(query: DshHistoryQuery = {}): Promise<{
    events: DshSurfaceEvent[];
    hasMore: boolean;
  }> {
    const maxMessages = query.maxMessages ?? this.pageSize;
    assertPageLimit("maxMessages", maxMessages);
    if (query.beforeSeq !== undefined) {
      assertSeq("beforeSeq", query.beforeSeq);
    }
    const page = await this.client.sessionHistory({
      sessionId: this.options.session_id,
      maxMessages,
      beforeSeq: query.beforeSeq,
    });
    return {
      events: toSurfaceEvents(page.events),
      hasMore: page.hasMore,
    };
  }

  async poll(cursor: ConnectorCursor | null): Promise<PollResult> {
    const { afterSeq, resumeBefore } = parseCursor(cursor);
    const collected = await this.collectHistoryAfter(afterSeq, resumeBefore);
    if (!collected.reached) {
      const nextCursor = formatResumeCursor(afterSeq, collected.resumeBefore);
      this.lastSurfacePage = { events: [], hasMore: true };
      return this.toPollResult(cursor?.value, nextCursor, []);
    }
    const surface = toSurfaceEvents(collected.events).filter((event) => event.seq > afterSeq);
    const window = surface.slice(0, this.pageSize);
    const nextCursor = window.length > 0
      ? String(window[window.length - 1].seq)
      : afterSeq >= 0 ? String(afterSeq) : undefined;
    this.lastSurfacePage = {
      events: window,
      hasMore: surface.length > window.length,
    };
    return this.toPollResult(cursor?.value, nextCursor, window);
  }

  private async collectHistoryAfter(
    afterSeq: number,
    resumeBefore: number | undefined,
  ): Promise<
    | { reached: true; events: DshHistoryEvent[] }
    | { reached: false; resumeBefore: number }
  > {
    const collected: DshHistoryEvent[] = [];
    let beforeSeq = resumeBefore;
    for (let hop = 0; hop < this.maxHistoryPages; hop += 1) {
      const page = await this.client.sessionHistory({
        sessionId: this.options.session_id,
        maxMessages: this.pageSize,
        beforeSeq,
      });
      collected.push(...page.events);
      const seqs = page.events
        .map((event) => event.seq)
        .filter((seq) => Number.isInteger(seq));
      const minSeq = seqs.length > 0 ? Math.min(...seqs) : undefined;
      if (page.events.length === 0 || page.hasMore !== true) {
        return { reached: true, events: dedupeHistoryEvents(collected) };
      }
      if (minSeq !== undefined && minSeq <= afterSeq + 1) {
        return { reached: true, events: dedupeHistoryEvents(collected) };
      }
      if (minSeq === undefined) {
        throw new DshApiError("DSH history page has no valid seq", "internal");
      }
      if (beforeSeq !== undefined && minSeq >= beforeSeq) {
        throw new DshApiError("DSH history page did not move beforeSeq", "internal");
      }
      beforeSeq = minSeq;
    }
    if (beforeSeq === undefined) {
      throw new DshApiError("DSH history page has no valid seq", "internal");
    }
    return { reached: false, resumeBefore: beforeSeq };
  }

  private toPollResult(
    cursor: string | undefined,
    nextCursor: string | undefined,
    window: DshSurfaceEvent[],
  ): PollResult {
    const batch: IngestBatch = {
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: this.options.connector_id,
      org_id: this.options.org_id,
      delivery_id: this.deliveryId(cursor, nextCursor),
      received_at: this.now(),
      next_cursor: nextCursor,
      records: window.map((event) => this.toRecord(event)),
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

function toSurfaceEvents(events: DshHistoryEvent[]): DshSurfaceEvent[] {
  return events
    .flatMap((event) => toSurfaceEvent(event))
    .sort((left, right) => left.seq - right.seq);
}

function dedupeHistoryEvents(events: DshHistoryEvent[]): DshHistoryEvent[] {
  const seen = new Set<number>();
  const unique: DshHistoryEvent[] = [];
  for (const event of events) {
    if (!Number.isInteger(event.seq) || seen.has(event.seq)) {
      continue;
    }
    seen.add(event.seq);
    unique.push(event);
  }
  return unique;
}

function assertPageLimit(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new DshApiError(`${name} must be an integer from 1 through 100`, "bad-request");
  }
}

function assertSeq(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new DshApiError(`${name} must be a non-negative integer`, "bad-request");
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

function parseCursor(cursor: ConnectorCursor | null): {
  afterSeq: number;
  resumeBefore?: number;
} {
  if (!cursor?.value) {
    return { afterSeq: -1 };
  }
  const exact = /^(-1|\d+)$/.exec(cursor.value);
  if (exact) {
    return { afterSeq: Number(exact[1]) };
  }
  const resume = /^(-1|\d+):(\d+)$/.exec(cursor.value);
  if (resume) {
    return { afterSeq: Number(resume[1]), resumeBefore: Number(resume[2]) };
  }
  throw new DshApiError(`DSH cursor is invalid: ${cursor.value}`);
}

function formatResumeCursor(afterSeq: number, resumeBefore: number): string {
  return `${afterSeq}:${resumeBefore}`;
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
