import { createHash, randomUUID } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  CONTENT_PARTS_MEDIA_TYPE,
  bodyTextFromStored,
  parseStoredContentParts,
  type ContextAuthorityRead,
  type ContextSelectionReason,
  type SearchAnswerIntent,
  type SearchAnswerScope,
} from "@regenic/domain";
import { PersonalContextError } from "./personal-context-error";
import type { SearchConversationLabels } from "./personal-conversation-labels.service";
import { PersonalRuntimeService } from "./personal-runtime.service";

const ANSWER_QUERY_MAX = 8_000;
const ANSWER_CONVERSATIONS_MAX = 20;
const ANSWER_MESSAGES_MAX = 200;
const ANSWER_MESSAGE_CHARS = 2_000;
const ANSWER_TRANSCRIPT_CHARS = 24_000;
const COMPLETE_SCOPE_DAYS_MAX = 90;
const COMPLETE_SCOPE_ITEMS_MAX = 10_000;
const COMPLETE_ANSWER_MESSAGES_MAX = 1_000;
const COMPLETE_ANSWER_MESSAGE_CHARS = 1_000;
const COMPLETE_ANSWER_TRANSCRIPT_CHARS = 160_000;

export interface ConversationMessage {
  event_id: string;
  external_id: string;
  content_hash: string;
  source: string;
  thread_id: string;
  actor_id?: string;
  parent_external_id?: string;
  reply_to_event_id?: string;
  occurred_at: string;
  text: string;
  attachments?: Array<{ media_type: string; filename?: string }>;
  selection_reason: ContextSelectionReason;
}

export interface ConversationWindow {
  thread_id: string;
  read_epoch: string;
  messages: ConversationMessage[];
  has_more: boolean;
}

export interface ConversationAnswerEvidence {
  query: string;
  executor_type?: string;
  evidence_text: string;
  refs: string[];
  scope?: SearchAnswerScope;
}

/**
 * Authorized current-message reading shared by search cards and executor
 * evidence. It owns lifecycle-head filtering, blob verification and attachment
 * decoding; callers only choose indexes or boundaries.
 */
@Injectable()
export class PersonalConversationContextService {
  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
  ) {}

  async readThread(threadId: string) {
    const read = await this.runtime.requireHost().get("context-authority")
      .openContextReadForThread(this.runtime.orgId(), threadId);
    const heads = new Set(read.lifecycle_heads.map((head) => head.head_event_id));
    const events = read.events
      .filter((event) =>
        event.thread_id === threadId
        && event.operation !== "tombstone"
        && heads.has(event.id)
        && event.content_hash
        && event.content_media_type)
      .sort(compareEvent);
    return { read_epoch: read.read_epoch, events };
  }

  async readMessages(
    threadId: string,
    events: ContextAuthorityRead["events"],
    indexes: readonly number[],
    reasons?: ReadonlyMap<number, ContextSelectionReason>,
  ) {
    const bodies = await this.runtime.requireHost().get("blobs")
      .getMany(indexes.map((index) => events[index].content_hash!));
    const messages: ConversationMessage[] = [];
    const kept: number[] = [];
    const unreadable = new Set<number>();
    for (const index of indexes) {
      const event = events[index];
      const contentHash = event.content_hash!;
      const bytes = bodies.get(contentHash);
      const content = bytes
        && createHash("sha256").update(bytes).digest("hex") === contentHash
        ? storedMessageContent(bytes, event.content_media_type!)
        : undefined;
      if (!content) {
        unreadable.add(index);
        continue;
      }
      kept.push(index);
      const parentExternalId = stringAttribute(
        event.attrs,
        "parent_external_id",
      );
      const replyTarget = parentExternalId
        ? events.find((candidate) =>
            candidate.source === event.source
            && candidate.external_id === parentExternalId)
        : undefined;
      messages.push({
        event_id: event.id,
        external_id: event.external_id,
        content_hash: contentHash,
        source: event.source,
        thread_id: threadId,
        ...(event.actor_id ? { actor_id: event.actor_id } : {}),
        ...(parentExternalId
          ? { parent_external_id: parentExternalId }
          : {}),
        ...(replyTarget ? { reply_to_event_id: replyTarget.id } : {}),
        occurred_at: event.occurred_at,
        text: content.text,
        ...(content.attachments.length
          ? { attachments: content.attachments }
          : {}),
        selection_reason: reasons?.get(index) ?? "neighbor",
      });
    }
    return { messages, kept, unreadable };
  }

  async window(input: unknown): Promise<ConversationWindow> {
    const body = strictObject(
      input,
      new Set([
        "thread_id",
        "read_epoch",
        "direction",
        "boundary",
        "until",
        "limit",
      ]),
      "body",
    );
    const threadId = requiredString(body.thread_id, "thread_id");
    const expectedEpoch = requiredString(body.read_epoch, "read_epoch");
    if (body.direction !== "before" && body.direction !== "after") {
      invalid("direction must be before or after");
    }
    const direction = body.direction as "before" | "after";
    const boundary = boundaryKey(body.boundary, "boundary");
    const until = body.until === undefined
      ? undefined
      : boundaryKey(body.until, "until");
    const limit = boundedInteger(body.limit ?? 10, "limit", 1, 50);
    const { read_epoch, events } = await this.readThread(threadId);
    if (read_epoch !== expectedEpoch) {
      throw new PersonalContextError(
        "context_changed",
        HttpStatus.CONFLICT,
        "Conversation context changed; search again",
      );
    }
    const candidates: number[] = [];
    events.forEach((event, index) => {
      const key = eventKey(event);
      const inRange = direction === "before"
        ? key < boundary && (until === undefined || key > until)
        : key > boundary && (until === undefined || key < until);
      if (inRange) candidates.push(index);
    });
    if (direction === "before") candidates.reverse();
    const messages: ConversationMessage[] = [];
    let examined = 0;
    while (messages.length < limit && examined < candidates.length) {
      const batch = candidates.slice(
        examined,
        examined + limit - messages.length,
      );
      examined += batch.length;
      messages.push(...(await this.readMessages(threadId, events, batch)).messages);
    }
    messages.sort((left, right) => compareEvent(
      { occurred_at: left.occurred_at, id: left.event_id },
      { occurred_at: right.occurred_at, id: right.event_id },
    ));
    return {
      thread_id: threadId,
      read_epoch,
      messages,
      has_more: examined < candidates.length,
    };
  }

  async answerEvidence(
    input: unknown,
    describe: (
      conversations: Array<{
        thread_id: string;
        messages: Array<{ event_id: string }>;
      }>,
    ) => Promise<SearchConversationLabels>,
  ): Promise<ConversationAnswerEvidence> {
    const body = strictObject(
      input,
      new Set(["query", "conversations", "executor_type", "filters", "intent"]),
      "body",
    );
    const query = requiredString(body.query, "query");
    if (query.length > ANSWER_QUERY_MAX) invalid("query is too long");
    const executorType = body.executor_type === undefined
      ? undefined
      : requiredString(body.executor_type, "executor_type");
    const filters = body.filters === undefined
      ? undefined
      : answerFilters(body.filters);
    const intent = answerIntent(body.intent);
    const requested = answerConversations(body.conversations);
    let conversations: Array<{
      thread_id: string;
      messages: ConversationMessage[];
    }>;
    let scope: SearchAnswerScope | undefined;
    const completeRange = intent !== "lookup" && filters
      ? completeScopeRange(filters)
      : undefined;
    if (intent !== "lookup" && completeRange?.allowed) {
      const complete = await this.completeAnswerConversations(filters!);
      conversations = complete.conversations;
      scope = {
        intent,
        complete: complete.truncated === 0 && complete.unreadable === 0,
        total_count: complete.total,
        included_count: 0,
        omitted_count: complete.total,
        occurred_after: filters!.occurred_after,
        occurred_before: filters!.occurred_before,
        ...(complete.truncated > 0
          ? { incomplete_reason: "scope_limit" as const }
          : complete.unreadable > 0
            ? { incomplete_reason: "unreadable_evidence" as const }
            : {}),
      };
    } else {
      conversations = await this.selectedAnswerConversations(requested, filters);
      if (intent !== "lookup") {
        scope = {
          intent,
          complete: false,
          total_count: null,
          included_count: 0,
          omitted_count: null,
          ...(filters ? {
            occurred_after: filters.occurred_after,
            occurred_before: filters.occurred_before,
          } : {}),
          incomplete_reason: filters ? "range_too_wide" : "missing_time_range",
        };
      }
    }
    if (!conversations.length && scope?.total_count !== 0) {
      throw new PersonalContextError(
        "no_context",
        HttpStatus.UNPROCESSABLE_ENTITY,
        "No current messages to answer from; search again",
      );
    }
    const completeMode = intent !== "lookup" && completeRange?.allowed === true;
    const transcript = answerTranscript(
      conversations,
      await describe(conversations),
      completeMode
        ? {
            max_messages: COMPLETE_ANSWER_MESSAGES_MAX,
            message_chars: COMPLETE_ANSWER_MESSAGE_CHARS,
            transcript_chars: COMPLETE_ANSWER_TRANSCRIPT_CHARS,
          }
        : {
            max_messages: ANSWER_MESSAGES_MAX,
            message_chars: ANSWER_MESSAGE_CHARS,
            transcript_chars: ANSWER_TRANSCRIPT_CHARS,
          },
    );
    if (scope) {
      scope.included_count = transcript.refs.length;
      scope.omitted_count = scope.total_count === null
        ? null
        : Math.max(0, scope.total_count - transcript.refs.length);
      if (
        scope.complete
        && ((scope.omitted_count ?? 0) > 0 || transcript.truncated)
      ) {
        scope.complete = false;
        scope.incomplete_reason = "transcript_limit";
      }
    }
    return {
      query,
      ...(executorType ? { executor_type: executorType } : {}),
      evidence_text: [
        "QUESTION",
        query,
        "",
        ...(scope ? [
          "EVIDENCE SCOPE",
          `intent=${scope.intent}`,
          `complete=${scope.complete}`,
          `authorized_total=${scope.total_count ?? "unknown"}`,
          `included=${scope.included_count}`,
          `omitted=${scope.omitted_count ?? "unknown"}`,
          ...(scope.incomplete_reason
            ? [`incomplete_reason=${scope.incomplete_reason}`]
            : []),
          "",
        ] : []),
        ...(filters ? [
          "EVIDENCE TIME RANGE",
          `${filters.occurred_after} through ${filters.occurred_before}`,
          "",
        ] : []),
        "CONVERSATIONS",
        transcript.text || "(no authorized messages in this scope)",
      ].join("\n"),
      refs: transcript.refs,
      ...(scope ? { scope } : {}),
    };
  }

  private async selectedAnswerConversations(
    requested: Array<{ thread_id: string; event_ids: string[] }>,
    filters?: AnswerFilters,
  ) {
    const conversations: Array<{
      thread_id: string;
      messages: ConversationMessage[];
    }> = [];
    for (const conversation of requested) {
      const { events } = await this.readThread(conversation.thread_id);
      const wanted = new Set(conversation.event_ids);
      const indexes = events.flatMap((event, index) =>
        wanted.has(event.id) ? [index] : []);
      const { messages: currentMessages } = await this.readMessages(
        conversation.thread_id,
        events,
        indexes,
      );
      if (indexes.length !== wanted.size || currentMessages.length !== indexes.length) {
        throw new PersonalContextError(
          "context_changed",
          HttpStatus.CONFLICT,
          "Search context changed; search again",
        );
      }
      const messages = filters
        ? currentMessages.filter((message) =>
            Date.parse(message.occurred_at) >= Date.parse(filters.occurred_after)
            && Date.parse(message.occurred_at) <= Date.parse(filters.occurred_before)
            && (!filters.sources || filters.sources.includes(message.source))
            && (!filters.thread_ids
              || filters.thread_ids.includes(message.thread_id)))
        : currentMessages;
      if (messages.length) {
        conversations.push({ thread_id: conversation.thread_id, messages });
      }
    }
    return conversations;
  }

  private async completeAnswerConversations(filters: {
    occurred_after: string;
    occurred_before: string;
    sources?: string[];
    thread_ids?: string[];
  }) {
    const host = this.runtime.requireHost();
    const result = await host.get("context").assemble({
      schema_version: "1.0",
      id: randomUUID(),
      org_id: this.runtime.orgId(),
      principal: { actor_type: "human", actor_id: this.runtime.orgId() },
      consumer_id: "personal-search-answer-complete",
      purpose: "answer an exhaustive time-bounded search question",
      allowed_uses: ["reason"],
      temporal: { mode: "current" },
      filters,
      requested_kinds: ["event"],
      budget: {
        profile: "personal-search-answer-complete-v1",
        max_tokens: 1_000_000,
        max_items: COMPLETE_SCOPE_ITEMS_MAX,
        max_raw_evidence: COMPLETE_SCOPE_ITEMS_MAX,
      },
    });
    const items = result.bundle.sections.flatMap((section) => section.items)
      .filter((item) => item.kind === "event");
    const evidenceLedger = result.bundle.budget_ledger.sections
      .find((section) => section.kind === "evidence");
    const truncated = evidenceLedger?.truncated_items ?? 0;
    const read = await host.get("context-authority").openContextRead(
      this.runtime.orgId(),
      { filters },
    );
    const metadata = new Map(read.events.map((event) => [event.id, event]));
    const bodies = await host.get("blobs").getMany(items.flatMap((item) => {
      const contentHash = metadata.get(item.resource_id)?.content_hash;
      return contentHash ? [contentHash] : [];
    }));
    const grouped = new Map<string, ConversationMessage[]>();
    let unreadable = 0;
    for (const item of items) {
      const event = metadata.get(item.resource_id);
      if (
        !event
        || event.operation === "tombstone"
        || !event.thread_id
        || !event.content_hash
        || !event.content_media_type
        || item.content_hash !== event.content_hash
      ) {
        unreadable += 1;
        continue;
      }
      const bytes = bodies.get(event.content_hash);
      const content = bytes
        && createHash("sha256").update(bytes).digest("hex") === event.content_hash
        ? storedMessageContent(bytes, event.content_media_type)
        : undefined;
      if (!content) {
        unreadable += 1;
        continue;
      }
      const parentExternalId = stringAttribute(event.attrs, "parent_external_id");
      const messages = grouped.get(event.thread_id) ?? [];
      messages.push({
        event_id: event.id,
        external_id: event.external_id,
        content_hash: event.content_hash,
        source: event.source,
        thread_id: event.thread_id,
        ...(event.actor_id ? { actor_id: event.actor_id } : {}),
        ...(parentExternalId ? { parent_external_id: parentExternalId } : {}),
        occurred_at: event.occurred_at,
        text: content.text,
        ...(content.attachments.length
          ? { attachments: content.attachments }
          : {}),
        selection_reason: "hit",
      });
      grouped.set(event.thread_id, messages);
    }
    const conversations = [...grouped].map(([thread_id, messages]) => {
      messages.sort((left, right) => compareEvent(
        { occurred_at: left.occurred_at, id: left.event_id },
        { occurred_at: right.occurred_at, id: right.event_id },
      ));
      const byExternal = new Map(messages.map((message) => [
        `${message.source}\u0000${message.external_id}`,
        message.event_id,
      ]));
      for (const message of messages) {
        if (message.parent_external_id) {
          message.reply_to_event_id = byExternal.get(
            `${message.source}\u0000${message.parent_external_id}`,
          );
        }
      }
      return { thread_id, messages };
    });
    return {
      conversations,
      total: items.length + truncated,
      truncated,
      unreadable,
    };
  }
}

function answerIntent(value: unknown): SearchAnswerIntent {
  if (value === undefined) return "lookup";
  if (value !== "lookup" && value !== "aggregate" && value !== "list") {
    invalid("intent must be lookup, aggregate or list");
  }
  return value;
}

function completeScopeRange(filters: {
  occurred_after: string;
  occurred_before: string;
}) {
  const duration = Date.parse(filters.occurred_before)
    - Date.parse(filters.occurred_after);
  return {
    allowed: duration <= COMPLETE_SCOPE_DAYS_MAX * 24 * 60 * 60 * 1_000,
  };
}

interface AnswerFilters {
  occurred_after: string;
  occurred_before: string;
  sources?: string[];
  thread_ids?: string[];
}

function answerFilters(value: unknown): AnswerFilters {
  const filters = strictObject(
    value,
    new Set(["occurred_after", "occurred_before", "sources", "thread_ids"]),
    "filters",
  );
  const occurredAfter = requiredTimestamp(
    filters.occurred_after,
    "filters.occurred_after",
  );
  const occurredBefore = requiredTimestamp(
    filters.occurred_before,
    "filters.occurred_before",
  );
  if (Date.parse(occurredAfter) > Date.parse(occurredBefore)) {
    invalid("filters.occurred_before cannot precede filters.occurred_after");
  }
  return {
    occurred_after: occurredAfter,
    occurred_before: occurredBefore,
    ...(filters.sources === undefined
      ? {}
      : { sources: stringList(filters.sources, "filters.sources") }),
    ...(filters.thread_ids === undefined
      ? {}
      : { thread_ids: stringList(filters.thread_ids, "filters.thread_ids") }),
  };
}

function eventKey(event: { occurred_at: string; id: string }): string {
  return `${event.occurred_at}\u0000${event.id}`;
}

function compareEvent(
  left: { occurred_at: string; id: string },
  right: { occurred_at: string; id: string },
): number {
  const leftKey = eventKey(left);
  const rightKey = eventKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function boundaryKey(value: unknown, field: string): string {
  const body = strictObject(
    value,
    new Set(["occurred_at", "event_id"]),
    field,
  );
  return eventKey({
    occurred_at: requiredString(body.occurred_at, `${field}.occurred_at`),
    id: requiredString(body.event_id, `${field}.event_id`),
  });
}

function answerConversations(
  value: unknown,
): Array<{ thread_id: string; event_ids: string[] }> {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > ANSWER_CONVERSATIONS_MAX
  ) {
    invalid(
      `conversations must contain 1 to ${ANSWER_CONVERSATIONS_MAX} entries`,
    );
  }
  let total = 0;
  return value.map((entry, index) => {
    const body = strictObject(
      entry,
      new Set(["thread_id", "event_ids"]),
      `conversations[${index}]`,
    );
    const eventIds = body.event_ids;
    if (
      !Array.isArray(eventIds)
      || eventIds.length === 0
      || eventIds.some((id) => typeof id !== "string" || !id.trim())
      || new Set(eventIds).size !== eventIds.length
    ) {
      invalid(
        `conversations[${index}].event_ids must be a non-empty list of unique IDs`,
      );
    }
    total += eventIds.length;
    if (total > ANSWER_MESSAGES_MAX) {
      invalid(`conversations may reference at most ${ANSWER_MESSAGES_MAX} messages`);
    }
    return {
      thread_id: requiredString(
        body.thread_id,
        `conversations[${index}].thread_id`,
      ),
      event_ids: eventIds as string[],
    };
  });
}

function answerTranscript(
  conversations: Array<{
    thread_id: string;
    messages: ConversationMessage[];
  }>,
  labels: SearchConversationLabels,
  limits: {
    max_messages: number;
    message_chars: number;
    transcript_chars: number;
  },
) {
  const refs: string[] = [];
  const numbers = new Map<string, number>();
  let budget = limits.transcript_chars;
  let truncated = false;
  const sections: string[] = [];
  for (const conversation of conversations) {
    const sender = (eventId: string, actorId?: string) =>
      labels.actors.get(eventId) ?? actorId ?? "unknown";
    const lines: string[] = [];
    for (const message of conversation.messages) {
      if (refs.length >= limits.max_messages) {
        truncated = true;
        break;
      }
      const attachments = (message.attachments ?? [])
        .map((attachment) =>
          `[attachment: ${attachment.filename || attachment.media_type}]`);
      const normalizedText = message.text.replace(/\s+/g, " ");
      if (normalizedText.length > limits.message_chars) truncated = true;
      const body = [
        normalizedText.slice(0, limits.message_chars),
        ...attachments,
      ].filter(Boolean).join(" ");
      if (body.length > budget) {
        truncated = true;
        break;
      }
      budget -= body.length;
      refs.push(message.event_id);
      numbers.set(message.event_id, refs.length);
      const parent = message.reply_to_event_id
        ? numbers.get(message.reply_to_event_id)
        : undefined;
      const sentAt =
        `${message.occurred_at.slice(0, 16).replace("T", " ")} UTC`;
      lines.push(
        `[${refs.length}] ${sentAt} · ${sender(message.event_id, message.actor_id)}`
        + `${parent ? ` (reply to [${parent}])` : ""}: ${body}`,
      );
    }
    if (lines.length) {
      sections.push([
        `## ${labels.threads.get(conversation.thread_id)?.title ?? conversation.thread_id}`,
        ...lines,
      ].join("\n"));
    }
  }
  return { text: sections.join("\n\n"), refs, truncated };
}

function storedMessageContent(bytes: Uint8Array, mediaType: string) {
  const text = bodyTextFromStored(bytes, mediaType)?.trim() ?? "";
  const attachments = mediaType === CONTENT_PARTS_MEDIA_TYPE
    ? (parseStoredContentParts(bytes) ?? [])
      .filter((part) => part.role === "attachment")
      .map((part) => ({
        media_type: part.media_type || "application/octet-stream",
        ...(part.source_filename ? { filename: part.source_filename } : {}),
      }))
    : [];
  return text || attachments.length ? { text, attachments } : undefined;
}

function stringAttribute(
  attrs: ContextAuthorityRead["events"][number]["attrs"],
  key: string,
): string | undefined {
  const value = attrs?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strictObject(
  value: unknown,
  allowed: ReadonlySet<string>,
  name: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }
  const body = value as Record<string, unknown>;
  const unexpected = Object.keys(body).find((key) => !allowed.has(key));
  if (unexpected) invalid(`Unexpected ${name} field: ${unexpected}`);
  return body;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    invalid(`${name} is required`);
  }
  return (value as string).trim();
}

function stringList(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > 1_000
    || value.some((entry) => typeof entry !== "string" || !entry.trim())
    || new Set(value).size !== value.length
  ) {
    invalid(`${name} must be a non-empty list of unique strings`);
  }
  return value as string[];
}

function requiredTimestamp(value: unknown, name: string): string {
  const text = requiredString(value, name);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) invalid(`${name} must be an ISO datetime`);
  return new Date(timestamp).toISOString();
}

function boundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < min
    || value > max
  ) {
    invalid(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function invalid(message: string): never {
  throw new PersonalContextError(
    "invalid_request",
    HttpStatus.BAD_REQUEST,
    message,
  );
}
