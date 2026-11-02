import {
  ChannelDriverRegistry,
  WORK_RELATED_THREAD_LIMIT,
  formatRelatedConversations,
  workRelatedQueries,
} from "@regenic/domain";
import { PersonalContextService } from "./personal-context.service";
import { PersonalConversationContextService } from "./personal-conversation-context.service";
import { PersonalConversationLabelsService } from "./personal-conversation-labels.service";
import { PersonalRuntimeService } from "./personal-runtime.service";

const WORK_RELATED_HIT_LIMIT = 8;
/** Reciprocal rank fusion constant, same as the search index uses. */
const WORK_RELATED_RRF_K = 60;
/** Search runs before the agent starts, so it must never hold the run back long. */
export const WORK_RELATED_TIMEOUT_MS = 5_000;

export interface WorkRelatedRequest {
  thread_id: string;
  /** The message the work item is about. */
  current?: string;
  /** Messages just before it in the same thread, oldest first. */
  recent?: string[];
  /** Messages the agent already receives as background; not repeated. */
  covered_event_ids?: string[];
}

export type WorkRelatedLookup = (
  request: WorkRelatedRequest,
) => Promise<string | undefined>;

type SearchResult = Awaited<ReturnType<PersonalContextService["searchExpanded"]>>;
type SearchConversation = SearchResult["conversations"][number];
type SearchMessage = SearchConversation["messages"][number];

interface FusedConversation {
  thread_id: string;
  score: number;
  messages: Map<string, SearchMessage>;
}

/**
 * Searches all indexed conversations for messages related to a work item.
 * Same index and authorization as the desktop search and the context search
 * MCP. Several queries (the message, the message with the turns before it,
 * and the identifiers in them) are fused by rank. Messages already in the
 * background are dropped; older parts of the same thread stay.
 */
export class PersonalWorkRelated {
  private readonly context: PersonalContextService;
  private readonly labels: PersonalConversationLabelsService;

  constructor(runtime: PersonalRuntimeService, drivers: ChannelDriverRegistry) {
    this.context = new PersonalContextService(
      runtime,
      new PersonalConversationContextService(runtime),
    );
    this.labels = new PersonalConversationLabelsService(runtime, drivers);
  }

  lookup: WorkRelatedLookup = async (request) => {
    const queries = workRelatedQueries(request);
    if (!queries.length) {
      return undefined;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), WORK_RELATED_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.search(request, queries), timeout]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  private async search(
    request: WorkRelatedRequest,
    queries: string[],
  ): Promise<string | undefined> {
    const settled = await Promise.allSettled(
      queries.map((query) =>
        this.context.searchExpanded({
          query,
          kind: "messages",
          limit: WORK_RELATED_HIT_LIMIT,
          context: { before: 2, after: 2, reply_depth: 2, max_messages: 30 },
        }),
      ),
    );
    const covered = new Set(request.covered_event_ids ?? []);
    const fused = new Map<string, FusedConversation>();
    for (const outcome of settled) {
      if (outcome.status !== "fulfilled") continue;
      let rank = 0;
      for (const conversation of outcome.value.conversations) {
        const fresh = conversation.messages.filter(
          (message) => !covered.has(message.event_id),
        );
        if (!fresh.length) continue;
        rank += 1;
        const entry = fused.get(conversation.thread_id) ?? {
          thread_id: conversation.thread_id,
          score: 0,
          messages: new Map<string, SearchMessage>(),
        };
        entry.score += 1 / (WORK_RELATED_RRF_K + rank);
        for (const message of fresh) entry.messages.set(message.event_id, message);
        fused.set(conversation.thread_id, entry);
      }
    }
    if (!settled.some((outcome) => outcome.status === "fulfilled")) {
      return undefined;
    }
    const top = [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, WORK_RELATED_THREAD_LIMIT)
      .map((entry) => ({
        thread_id: entry.thread_id,
        messages: [...entry.messages.values()].sort((a, b) =>
          a.occurred_at.localeCompare(b.occurred_at),
        ),
      }));
    if (!top.length) {
      return undefined;
    }
    const labels = await this.labels.describe(top);
    const speakers = new Map<string, string>();
    for (const conversation of top) {
      for (const message of conversation.messages) {
        speakers.set(
          message.event_id,
          labels.actors.get(message.event_id) ?? message.actor_id ?? "user",
        );
      }
    }
    const text = formatRelatedConversations(
      top.map((conversation) => {
        const thread = labels.threads.get(conversation.thread_id);
        return {
          title: thread?.title ?? undefined,
          channel: thread?.channel_label ?? undefined,
          same_thread: conversation.thread_id === request.thread_id,
          lines: conversation.messages.map((message) => {
            const parent = message.reply_to_event_id
              ? speakers.get(message.reply_to_event_id)
              : undefined;
            return {
              speaker: speakers.get(message.event_id) ?? "user",
              text: message.text,
              occurred_at: message.occurred_at,
              ...(parent ? { reply_to: parent } : {}),
            };
          }),
        };
      }),
    );
    return text || undefined;
  }
}
