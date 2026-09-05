import { createHash } from "node:crypto";
import {
  INGEST_SCHEMA_VERSION,
  channelRecord,
  type ConnectorCursor,
  type IngestBatch,
  type IngestRecord,
  type PollResult,
} from "@regenic/domain";
import type {
  CursorAgentSummary,
  CursorConversationMessage,
} from "./cursor-api-client";
import { cursorExternalId } from "./cursor-ids";

export const CURSOR_SOURCE = "cursor";
export const CURSOR_ACTOR_LABEL = "Cursor";

const JOURNAL_MARKER = "poll";

export interface CursorAgentHistoryClient {
  getAgent(agentId: string): Promise<CursorAgentSummary>;
  getConversation(agentId: string): Promise<{
    id: string;
    messages: CursorConversationMessage[];
  }>;
  flushPending?(agentId: string): Promise<void>;
}

export interface CursorAgentPollConnectorOptions {
  connector_id: string;
  org_id: string;
  agent_id: string;
  agent_name?: string;
  now?: () => string;
}

export class CursorAgentPollConnector {
  readonly source = CURSOR_SOURCE;
  private readonly now: () => string;

  constructor(
    private readonly client: CursorAgentHistoryClient,
    private readonly options: CursorAgentPollConnectorOptions,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async poll(cursor: ConnectorCursor | null): Promise<PollResult> {
    const agent = await this.client.getAgent(this.options.agent_id);
    const conversation = await this.client.getConversation(this.options.agent_id);
    const afterId = cursor?.value;
    const journal = cursorConversationJournal(conversation.messages, agent.status);
    const fresh = messagesAfterKeep(journal.classified, journal.keep, afterId);
    const freshIds = new Set(fresh.map((message) => message.id));
    const repairIds = new Set(
      journal.keep
        .filter((message) => journal.repaired.has(message.id))
        .map((message) => message.id),
    );
    const now = this.now();
    const keepIndex = new Map(journal.keep.map((message, index) => [message.id, index]));
    const lastAssistant = lastAssistantMessage(journal.keep);
    const records = [
      ...fresh.flatMap((message) =>
        this.toMessageRecord(message, agent, keepIndex.get(message.id) ?? 0, now, {
          journal: repairIds.has(message.id),
        }),
      ),
      ...journal.keep
        .filter((message) => repairIds.has(message.id) && !freshIds.has(message.id))
        .flatMap((message) =>
          this.toMessageRecord(message, agent, keepIndex.get(message.id) ?? 0, now, {
            journal: true,
            operation: "revise",
          }),
        ),
      ...(lastAssistant
        && !freshIds.has(lastAssistant.id)
        && !repairIds.has(lastAssistant.id)
        ? this.toMessageRecord(
            lastAssistant,
            agent,
            keepIndex.get(lastAssistant.id) ?? 0,
            now,
            { operation: "revise" },
          )
        : []),
      ...journal.drop.map((message) => this.tombstoneRecord(message, agent, now)),
      ...this.statusRecords(agent),
    ];
    const nextCursor = lastMessageId(journal.keep) ?? afterId ?? undefined;
    const result = this.toPollResult(cursor?.value, nextCursor, records);
    if (!isWorkingStatus(agent.status)) {
      this.scheduleFlush();
    }
    return result;
  }

  private scheduleFlush(): void {
    const flush = this.client.flushPending;
    if (!flush) {
      return;
    }
    setImmediate(() => {
      void flush.call(this.client, this.options.agent_id).catch(() => undefined);
    });
  }

  private toMessageRecord(
    message: CursorConversationMessage,
    agent: CursorAgentSummary,
    index: number,
    now: string,
    options?: { journal?: boolean; operation?: "create" | "revise" },
  ): IngestRecord[] {
    const mapped = classifyCursorMessage(message);
    if (!mapped) {
      return [];
    }
    const record = channelRecord({
      channel: this.source,
      kind: mapped.kind,
      direction: mapped.direction,
      external_id: cursorExternalId(this.options.agent_id, message.id),
      occurred_at: messageTime(now, index),
      actor_id: mapped.actor_id,
      actor_label: mapped.actor_label,
      scope_id: this.options.agent_id,
      scope_name: agent.name ?? this.options.agent_name,
      type: "message",
      text: mapped.text,
    });
    const stamped = options?.journal ? withJournalMarker(record) : record;
    if (options?.operation === "revise") {
      return [{ ...stamped, operation: "revise" }];
    }
    return [stamped];
  }

  private tombstoneRecord(
    message: CursorConversationMessage,
    agent: CursorAgentSummary,
    now: string,
  ): IngestRecord {
    return {
      operation: "tombstone",
      source: this.source,
      external_id: cursorExternalId(this.options.agent_id, message.id),
      occurred_at: now,
      actor: {
        id: "assistant",
        display_name: CURSOR_ACTOR_LABEL,
      },
      scope: {
        id: this.options.agent_id,
        name: agent.name ?? this.options.agent_name,
      },
      type: "message",
    };
  }

  private statusRecords(agent: CursorAgentSummary): IngestRecord[] {
    const runId = agent.latestRunId ?? agent.status ?? "unknown";
    const occurredAt = agent.updatedAt ?? this.now();
    if (agent.status === "ACTIVE" || agent.status === "CREATING") {
      return [
        channelRecord({
          channel: this.source,
          kind: "system",
          direction: "inbound",
          external_id: cursorExternalId(this.options.agent_id, "working", runId),
          occurred_at: occurredAt,
          actor_id: "assistant",
          actor_label: CURSOR_ACTOR_LABEL,
          activity: "working",
          turn: { state: "open" },
          scope_id: this.options.agent_id,
          scope_name: agent.name ?? this.options.agent_name,
          type: "thread_status",
          text: "Still working.",
        }),
      ];
    }
    if (!agent.latestRunId || agent.status === "ARCHIVED") {
      return [];
    }
    return [
      channelRecord({
        channel: this.source,
        kind: "system",
        direction: "inbound",
        external_id: cursorExternalId(this.options.agent_id, "ended", runId),
        occurred_at: occurredAt,
        actor_id: "assistant",
        actor_label: CURSOR_ACTOR_LABEL,
        turn: { state: "ended", ok: agent.status !== "ERROR" },
        scope_id: this.options.agent_id,
        scope_name: agent.name ?? this.options.agent_name,
        type: "thread_status",
        text: "",
      }),
    ];
  }

  private toPollResult(
    cursor: string | undefined,
    nextCursor: string | undefined,
    records: IngestRecord[],
  ): PollResult {
    const batch: IngestBatch = {
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: this.options.connector_id,
      org_id: this.options.org_id,
      delivery_id: this.deliveryId(cursor, nextCursor),
      received_at: this.now(),
      next_cursor: nextCursor,
      records,
    };
    return {
      batch,
      next_cursor: nextCursor,
      // Journal poll is always a seeded live tail; no history lane.
      poll_hint: { live_seeded: true, history_pending: false },
    };
  }

  private deliveryId(cursor: string | undefined, nextCursor: string | undefined): string {
    const pageIdentity = [
      this.options.agent_id,
      cursor ?? "initial",
      nextCursor ?? "complete",
    ].join("\u0000");
    const hash = createHash("sha256").update(pageIdentity).digest("hex");
    return `cursor-history:${this.options.agent_id}:${hash}`;
  }
}

export function classifyCursorMessage(message: CursorConversationMessage): {
  kind: "user" | "assistant";
  direction: "outbound" | "inbound";
  actor_id: string;
  actor_label?: string;
  text: string;
} | undefined {
  const text = cursorMessageBody(message.text);
  if (!text) {
    return undefined;
  }
  if (message.type === "user_message") {
    return {
      kind: "user",
      direction: "outbound",
      actor_id: "user",
      text,
    };
  }
  if (message.type === "assistant_message") {
    return {
      kind: "assistant",
      direction: "inbound",
      actor_id: "assistant",
      actor_label: CURSOR_ACTOR_LABEL,
      text,
    };
  }
  return undefined;
}

function cursorMessageBody(raw: string | undefined): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const text = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
    .replace(/\n{3,}/g, "\n\n");
  return text.trim() ? text : undefined;
}

export function cursorConversationJournal(
  messages: CursorConversationMessage[],
  status?: string,
): {
  classified: CursorConversationMessage[];
  keep: CursorConversationMessage[];
  drop: CursorConversationMessage[];
  repaired: Set<string>;
} {
  const classified = messages.filter((message) => classifyCursorMessage(message));
  const keep: CursorConversationMessage[] = [];
  const drop: CursorConversationMessage[] = [];
  const repaired = new Set<string>();
  for (const message of classified) {
    const kind = classifyCursorMessage(message)?.kind;
    const previous = keep.at(-1);
    if (
      kind === "assistant" &&
      previous &&
      classifyCursorMessage(previous)?.kind === "assistant"
    ) {
      drop.push(previous);
      keep.pop();
      repaired.add(message.id);
    }
    keep.push(message);
  }
  const last = keep.at(-1);
  if (isWorkingStatus(status) && last && classifyCursorMessage(last)?.kind === "assistant") {
    keep.pop();
  }
  return { classified, keep, drop, repaired };
}

function messagesAfterKeep(
  classified: CursorConversationMessage[],
  keep: CursorConversationMessage[],
  afterId: string | undefined,
): CursorConversationMessage[] {
  if (!afterId) {
    return keep;
  }
  const index = classified.findIndex((message) => message.id === afterId);
  if (index < 0) {
    return keep;
  }
  const later = new Set(classified.slice(index + 1).map((message) => message.id));
  return keep.filter((message) => later.has(message.id));
}

function lastAssistantMessage(
  messages: CursorConversationMessage[],
): CursorConversationMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (classifyCursorMessage(messages[index])?.kind === "assistant") {
      return messages[index];
    }
  }
  return undefined;
}

function lastMessageId(messages: CursorConversationMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (classifyCursorMessage(messages[index])) {
      return messages[index].id;
    }
  }
  return undefined;
}

function messageTime(now: string, index: number): string {
  const stamp = Date.parse(now);
  if (!Number.isFinite(stamp)) {
    return now;
  }
  return new Date(stamp + index).toISOString();
}

function withJournalMarker(record: IngestRecord): IngestRecord {
  const content = (record.content ?? []).map((part) => {
    if (part.role !== "metadata" || typeof part.text !== "string") {
      return part;
    }
    try {
      return {
        ...part,
        text: JSON.stringify({ ...JSON.parse(part.text), journal: JOURNAL_MARKER }),
      };
    } catch {
      return part;
    }
  });
  return { ...record, content };
}

function isWorkingStatus(status: string | undefined): boolean {
  return status === "ACTIVE" || status === "CREATING";
}
