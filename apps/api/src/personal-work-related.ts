import {
  ChannelDriverRegistry,
  WORK_RELATED_THREAD_LIMIT,
  formatRelatedConversations,
} from "@regenic/domain";
import { PersonalContextService } from "./personal-context.service";
import { PersonalConversationContextService } from "./personal-conversation-context.service";
import { PersonalConversationLabelsService } from "./personal-conversation-labels.service";
import { PersonalRuntimeService } from "./personal-runtime.service";

/** Query text sent to search. A long ticket body only adds noise. */
export const WORK_RELATED_QUERY_MAX = 1_000;
const WORK_RELATED_QUERY_MIN = 2;
const WORK_RELATED_HIT_LIMIT = 8;
/** Search runs before the agent starts, so it must never hold the run back long. */
export const WORK_RELATED_TIMEOUT_MS = 5_000;

export type WorkRelatedLookup = (
  threadId: string,
  query: string,
) => Promise<string | undefined>;

/**
 * Searches other conversations and channels for messages related to a work
 * item. Same index and authorization as the desktop search and the context
 * search MCP; the work item's own thread is excluded because the recent
 * window already carries it.
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

  lookup: WorkRelatedLookup = async (threadId, query) => {
    const text = workRelatedQuery(query);
    if (!text) {
      return undefined;
    }
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), WORK_RELATED_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([this.search(threadId, text), timeout]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  };

  private async search(threadId: string, query: string): Promise<string | undefined> {
    const result = await this.context.searchExpanded({
      query,
      kind: "messages",
      limit: WORK_RELATED_HIT_LIMIT,
      context: { before: 2, after: 2, reply_depth: 2, max_messages: 30 },
    });
    const others = result.conversations
      .filter((conversation) => conversation.thread_id !== threadId)
      .slice(0, WORK_RELATED_THREAD_LIMIT);
    if (!others.length) {
      return undefined;
    }
    const labels = await this.labels.describe(others);
    const speakers = new Map<string, string>();
    for (const conversation of others) {
      for (const message of conversation.messages) {
        speakers.set(
          message.event_id,
          labels.actors.get(message.event_id) ?? message.actor_id ?? "user",
        );
      }
    }
    const text = formatRelatedConversations(
      others.map((conversation) => {
        const thread = labels.threads.get(conversation.thread_id);
        return {
          title: thread?.title ?? undefined,
          channel: thread?.channel_label ?? undefined,
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

export function workRelatedQuery(text: string | undefined): string | undefined {
  const query = text?.replace(/\s+/g, " ").trim().slice(0, WORK_RELATED_QUERY_MAX);
  return query && query.length >= WORK_RELATED_QUERY_MIN ? query : undefined;
}
