import { createHash } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  CONTENT_PARTS_MEDIA_TYPE,
  bodyTextFromStored,
  parseStoredContentParts,
  type ContextAuthorityRead,
  type ContextSelectionReason,
} from "@regenic/domain";
import { PersonalContextError } from "./personal-context-error";
import type { SearchConversationLabels } from "./personal-conversation-labels.service";
import { PersonalRuntimeService } from "./personal-runtime.service";

const ANSWER_QUERY_MAX = 8_000;
const ANSWER_CONVERSATIONS_MAX = 20;
const ANSWER_MESSAGES_MAX = 200;
const ANSWER_MESSAGE_CHARS = 2_000;
const ANSWER_TRANSCRIPT_CHARS = 24_000;

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
      new Set(["thread_id", "direction", "boundary", "until", "limit"]),
      "body",
    );
    const threadId = requiredString(body.thread_id, "thread_id");
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
      new Set(["query", "conversations", "executor_type"]),
      "body",
    );
    const query = requiredString(body.query, "query");
    if (query.length > ANSWER_QUERY_MAX) invalid("query is too long");
    const executorType = body.executor_type === undefined
      ? undefined
      : requiredString(body.executor_type, "executor_type");
    const requested = answerConversations(body.conversations);
    const conversations: Array<{
      thread_id: string;
      messages: ConversationMessage[];
    }> = [];
    for (const conversation of requested) {
      const { events } = await this.readThread(conversation.thread_id);
      const wanted = new Set(conversation.event_ids);
      const indexes = events.flatMap((event, index) =>
        wanted.has(event.id) ? [index] : []);
      const { messages } = await this.readMessages(
        conversation.thread_id,
        events,
        indexes,
      );
      if (indexes.length !== wanted.size || messages.length !== indexes.length) {
        throw new PersonalContextError(
          "context_changed",
          HttpStatus.CONFLICT,
          "Search context changed; search again",
        );
      }
      if (messages.length) {
        conversations.push({ thread_id: conversation.thread_id, messages });
      }
    }
    if (!conversations.length) {
      throw new PersonalContextError(
        "no_context",
        HttpStatus.UNPROCESSABLE_ENTITY,
        "No current messages to answer from; search again",
      );
    }
    const transcript = answerTranscript(
      conversations,
      await describe(conversations),
    );
    return {
      query,
      ...(executorType ? { executor_type: executorType } : {}),
      evidence_text: [
        "QUESTION",
        query,
        "",
        "CONVERSATIONS",
        transcript.text,
      ].join("\n"),
      refs: transcript.refs,
    };
  }
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
) {
  const refs: string[] = [];
  const numbers = new Map<string, number>();
  let budget = ANSWER_TRANSCRIPT_CHARS;
  const sections: string[] = [];
  for (const conversation of conversations) {
    const sender = (eventId: string, actorId?: string) =>
      labels.actors.get(eventId) ?? actorId ?? "unknown";
    const lines: string[] = [];
    for (const message of conversation.messages) {
      const attachments = (message.attachments ?? [])
        .map((attachment) =>
          `[attachment: ${attachment.filename || attachment.media_type}]`);
      const body = [
        message.text.slice(0, ANSWER_MESSAGE_CHARS).replace(/\s+/g, " "),
        ...attachments,
      ].filter(Boolean).join(" ");
      if (body.length > budget) break;
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
  return { text: sections.join("\n\n"), refs };
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
