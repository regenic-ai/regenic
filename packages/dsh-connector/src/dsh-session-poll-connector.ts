import { createHash } from "node:crypto";
import {
  INGEST_SCHEMA_VERSION,
  channelRecord,
  type ConnectorCursor,
  type IngestBatch,
  type IngestRecord,
  type MessageDirection,
  type MessageKind,
  type MessageTurn,
  type PollResult,
  type ThreadActivity,
} from "@regenic/domain";
import { DshApiError, type DshHistoryEvent, type DshHistoryPage } from "./dsh-cli-client";

export const DSH_SOURCE = "dsh";
export const DSH_MAX_HISTORY_PAGES = 100;

export interface DshSurfaceEvent {
  type: "user/message" | "assistant/message";
  kind: MessageKind;
  direction: MessageDirection;
  seq: number;
  time: number;
  actor_id: string;
  activity?: ThreadActivity;
  turn?: MessageTurn;
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
      return {
        ...this.toPollResult(cursor?.value, nextCursor, []),
        has_more: true,
      };
    }
    const surface = toSurfaceEvents(collected.events).filter((event) => event.seq > afterSeq);
    const window = surface.slice(0, this.pageSize);
    // An empty tip still needs a concrete cursor so SyncEngine can leave
    // "unseeded" and free the seed slots for other sessions.
    const nextCursor = window.length > 0
      ? String(window[window.length - 1].seq)
      : afterSeq >= 0
        ? String(afterSeq)
        : "-1";
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
    return channelRecord({
      channel: this.source,
      kind: event.kind,
      direction: event.direction,
      external_id: `${this.options.session_id}:${event.seq}`,
      occurred_at: new Date(event.time).toISOString(),
      actor_id: event.actor_id,
      activity: event.activity,
      turn: event.turn,
      scope_id: this.options.session_id,
      type:
        event.activity === "working" || event.turn
          ? "thread_status"
          : "message",
      text: event.data.content.map((part) => part.text).join(""),
    });
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
  const surface = events
    .flatMap((event) => toSurfaceEvent(event))
    .sort((left, right) => left.seq - right.seq);
  return appendWorkingMarker(events, surface);
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
  const classified = classifyDshHistoryEvent(event);
  if (!classified) {
    return [];
  }
  if (!Number.isInteger(event.seq) || event.seq < 0 || !Number.isFinite(event.time)) {
    throw new DshApiError(`DSH event seq or time is invalid: ${event.seq}`);
  }
  return [
    {
      type: classified.type,
      kind: classified.kind,
      direction: classified.direction,
      seq: event.seq,
      time: event.time,
      actor_id: classified.actor_id,
      activity: classified.activity,
      turn: classified.turn,
      data: { content: [{ type: "text", text: classified.text }] },
    },
  ];
}

/**
 * Mirror DeepSeek Harness conversation nodes:
 * `user/message` + source.kind=user → You;
 * other `user/message` sources (plugin inject) → Runtime;
 * `assistant/message` with a text block → DSH Agent.
 * `tool/call` `ask_user_question` → DSH Agent (the confirmation prompt).
 * Reasoning / other tool-call-only assistant steps are not a visible reply.
 */
export function classifyDshHistoryEvent(event: DshHistoryEvent): {
  type: "user/message" | "assistant/message";
  kind: MessageKind;
  direction: MessageDirection;
  actor_id: string;
  text: string;
  activity?: ThreadActivity;
  turn?: MessageTurn;
} | undefined {
  if (event.type === "user/message") {
    const text = extractTextBlocks(userMessageFromData(event.data));
    if (!text) {
      return undefined;
    }
    const sourceKind = sourceKindFrom(event.data);
    if (sourceKind && sourceKind !== "user") {
      return {
        type: "user/message",
        kind: "system",
        direction: "inbound",
        actor_id: sourceKind,
        text,
      };
    }
    return {
      type: "user/message",
      kind: "user",
      direction: "outbound",
      actor_id: sourceKind || "user",
      text,
    };
  }
  if (event.type === "assistant/message") {
    const text = extractTextBlocks(assistantMessageFromData(event.data));
    if (!text) {
      return undefined;
    }
    return {
      type: "assistant/message",
      kind: "assistant",
      direction: "inbound",
      actor_id: "assistant",
      text,
    };
  }
  if (event.type === "turn/start") {
    return {
      type: "assistant/message",
      kind: "system",
      direction: "inbound",
      actor_id: "assistant",
      text: "Still working.",
      activity: "working",
      turn: { state: "open" },
    };
  }
  if (event.type === "turn/end") {
    const reason = turnEndReasonKind(event.data);
    return {
      type: "assistant/message",
      kind: "system",
      direction: "inbound",
      actor_id: "assistant",
      text: "",
      turn: {
        state: "ended",
        ok: reason === "completed" || reason === "max-tokens",
        ...(reason ? { reason } : {}),
      },
    };
  }
  if (event.type === "tool/call") {
    const text = askUserQuestionText(event.data);
    if (!text) {
      return undefined;
    }
    return {
      type: "assistant/message",
      kind: "assistant",
      direction: "inbound",
      actor_id: "assistant",
      activity: "awaiting_user",
      text,
    };
  }
  return undefined;
}

function appendWorkingMarker(
  raw: DshHistoryEvent[],
  surface: DshSurfaceEvent[],
): DshSurfaceEvent[] {
  if (raw.length === 0) {
    return surface;
  }
  const latest = raw.reduce((left, right) => (left.seq > right.seq ? left : right));
  const latestVisible = surface[surface.length - 1];
  const boundary = lastTurnBoundary(raw);
  if (boundary?.type === "turn/end") {
    return surface;
  }
  if (boundary?.type === "turn/start") {
    if (!latestVisible) {
      return surface;
    }
    if (
      (latestVisible.activity === "working" || latestVisible.turn?.state === "open") &&
      latestVisible.seq >= latest.seq
    ) {
      return surface;
    }
    return [...surface, workingMarker(latest)];
  }
  if (!latestVisible) {
    return surface;
  }
  if (latestVisible.seq >= latest.seq) {
    return surface;
  }
  if (latestVisible.kind === "assistant" || latestVisible.activity === "awaiting_user") {
    return surface;
  }
  return [...surface, workingMarker(latest)];
}

function lastTurnBoundary(raw: DshHistoryEvent[]): DshHistoryEvent | undefined {
  let found: DshHistoryEvent | undefined;
  for (const event of raw) {
    if (event.type !== "turn/start" && event.type !== "turn/end") {
      continue;
    }
    if (!found || event.seq > found.seq) {
      found = event;
    }
  }
  return found;
}

function workingMarker(latest: DshHistoryEvent): DshSurfaceEvent {
  return {
    type: "assistant/message",
    kind: "system",
    direction: "inbound",
    seq: latest.seq,
    time: latest.time,
    actor_id: "assistant",
    activity: "working",
    turn: { state: "open" },
    data: { content: [{ type: "text", text: "Still working." }] },
  };
}

function turnEndReasonKind(data: unknown): string | undefined {
  if (!isObject(data)) {
    return undefined;
  }
  if (isObject(data.reason) && typeof data.reason.kind === "string") {
    return data.reason.kind;
  }
  return typeof data.kind === "string" ? data.kind : undefined;
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

function userMessageFromData(data: unknown): unknown {
  return data;
}

function assistantMessageFromData(data: unknown): unknown {
  return isObject(data) ? data.message : undefined;
}

function askUserQuestionText(data: unknown): string | undefined {
  if (!isObject(data) || data.name !== "ask_user_question") {
    return undefined;
  }
  let parsed: unknown = data.arguments;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (!isObject(parsed) || !Array.isArray(parsed.questions)) {
    return undefined;
  }
  const blocks = parsed.questions.flatMap((question) => formatAskUserQuestion(question));
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

function formatAskUserQuestion(question: unknown): string[] {
  if (!isObject(question)) {
    return [];
  }
  const prompt =
    (typeof question.question === "string" ? question.question.trim() : "")
    || (typeof question.header === "string" ? question.header.trim() : "");
  if (!prompt) {
    return [];
  }
  const options = Array.isArray(question.options) ? question.options : [];
  const lines = options.flatMap((option) => {
    if (!isObject(option) || typeof option.label !== "string" || option.label.trim().length === 0) {
      return [];
    }
    const description =
      typeof option.description === "string" && option.description.trim().length > 0
        ? ` — ${option.description.trim()}`
        : "";
    return [`- ${option.label.trim()}${description}`];
  });
  return [lines.length > 0 ? `${prompt}\n${lines.join("\n")}` : prompt];
}

function extractTextBlocks(message: unknown): string | undefined {
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
  return text.trim().length > 0 ? text : undefined;
}

function sourceKindFrom(data: unknown): string | undefined {
  if (
    isObject(data) &&
    isObject(data.source) &&
    typeof data.source.kind === "string" &&
    data.source.kind.trim().length > 0
  ) {
    return data.source.kind.trim();
  }
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
