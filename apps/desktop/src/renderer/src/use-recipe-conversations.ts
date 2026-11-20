import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchConversationDirectory, type ConversationDirectoryItem } from "./api";
import type { RecipeConversationOption } from "./types";

const DIRECTORY_LIMIT = 40;

/**
 * Recent conversations for the automation editor, then a capped name query.
 * A saved conversation is loaded by id so a slow catalog cannot mark it unavailable.
 * `ready` is true once that first page is stored.
 */
export function useRecipeConversationCatalog(
  initialConversations: RecipeConversationOption[],
  active: boolean,
  reloadKey: string,
  pinnedIds: readonly string[] = [],
) {
  const [discovered, setDiscovered] = useState<RecipeConversationOption[]>([]);
  const [ready, setReady] = useState(false);
  const loadRef = useRef<{
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);
  const pinnedKey = pinnedIds.filter((id) => id.trim()).join("\n");
  const start = useCallback(() => {
    const current = loadRef.current;
    if (current) return current.promise;
    const controller = new AbortController();
    let entry: { controller: AbortController; promise: Promise<void> } | null = null;
    const ids = pinnedKey.split("\n").filter((id) => id.length > 0);
    const promise = Promise.all([
      fetchConversationDirectory({ limit: DIRECTORY_LIMIT }, { signal: controller.signal }),
      ...ids.map((threadId) =>
        fetchConversationDirectory({ thread_id: threadId, limit: 1 }, { signal: controller.signal }),
      ),
    ])
      .then((pages) => {
        if (controller.signal.aborted || loadRef.current !== entry) return;
        setDiscovered((current) =>
          mergeDirectoryOptions(current, pages.flat().map(directoryOption)),
        );
        setReady(true);
      })
      .catch((error: unknown) => {
        if (loadRef.current === entry) loadRef.current = null;
        throw error;
      });
    entry = { controller, promise };
    loadRef.current = entry;
    return promise;
  }, [reloadKey, pinnedKey]);
  const load = useCallback((signal: AbortSignal) => {
    const pending = start();
    if (signal.aborted) {
      return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        () => {
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) onAbort();
          else resolve();
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }, [start]);
  const search = useCallback((query: string, signal: AbortSignal) => {
    const needle = query.trim();
    if (!needle) return Promise.resolve();
    return fetchConversationDirectory(
      { q: needle, limit: DIRECTORY_LIMIT },
      { signal },
    ).then((rows) => {
      if (signal.aborted) return;
      setDiscovered((current) => mergeDirectoryOptions(current, rows.map(directoryOption)));
    });
  }, []);

  useEffect(() => {
    if (!active) {
      loadRef.current?.controller.abort();
      loadRef.current = null;
      setDiscovered([]);
      setReady(false);
      return;
    }
    const pending = start();
    void pending.catch(() => undefined);
    return () => {
      loadRef.current?.controller.abort();
      loadRef.current = null;
    };
  }, [active, start]);

  const conversations = useMemo(() => {
    return mergeDirectoryOptions(initialConversations, discovered);
  }, [initialConversations, discovered]);

  return { conversations, load, search, ready };
}

function directoryOption(item: ConversationDirectoryItem): RecipeConversationOption {
  return {
    id: item.id,
    label: item.label,
    source: item.source,
    can_send: item.can_send,
    has_work: item.has_work,
    ...(item.conversation_name ? { conversation_name: item.conversation_name } : {}),
  };
}

function mergeDirectoryOptions(
  current: readonly RecipeConversationOption[],
  next: readonly RecipeConversationOption[],
): RecipeConversationOption[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of next) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}
