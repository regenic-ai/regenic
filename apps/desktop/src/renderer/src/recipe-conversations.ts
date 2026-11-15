import { groupInboxThreads, type InboxThread } from "./inbox.ts";
import { threadTitle } from "./message-view.ts";
import type { InboxHeadsPage } from "./api";
import type { InboxViewItem, RecipeConversationOption } from "./types";

export function recipeConversationOptions(threads: InboxThread[]): RecipeConversationOption[] {
  return threads.map((thread) => ({
    id: thread.id,
    label: threadTitle(thread),
    source: thread.source || thread.channel,
    can_send: thread.can_send,
    record_class: thread.record_class,
    thread_facet: thread.thread_facet,
    unit_kind: thread.unit_kind ?? undefined,
    has_work: Boolean(thread.work),
    body_text: thread.messages[thread.messages.length - 1]?.body_text,
  }));
}

/** Inbox heads are paginated separately for shown and hidden conversations. */
export async function loadRecipeConversations(
  fetchPage: (
    query: { list: "shown" | "hidden"; limit: number; before?: string; before_id?: string },
    init: { signal: AbortSignal },
  ) => Promise<InboxHeadsPage>,
  signal: AbortSignal,
): Promise<RecipeConversationOption[]> {
  const lists = await Promise.all(
    (["shown", "hidden"] as const).map(async (list) => {
      const items: InboxViewItem[] = [];
      let cursor: InboxHeadsPage["next_before"] = null;
      const seen = new Set<string>();
      do {
        signal.throwIfAborted();
        const page = await fetchPage({ list, limit: 200, ...cursor }, { signal });
        signal.throwIfAborted();
        items.push(...page.pinned, ...page.live, ...(page.active_work ?? []));
        if (!page.has_older) break;
        const next = page.next_before;
        if (!next || seen.has(JSON.stringify(next))) {
          throw new Error("Conversation pagination did not advance");
        }
        seen.add(JSON.stringify(next));
        cursor = next;
      } while (cursor);
      return items;
    }),
  );
  signal.throwIfAborted();
  return recipeConversationOptions(groupInboxThreads(lists.flat()));
}
