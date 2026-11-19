import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchInboxHeads } from "./api";
import { loadRecipeConversations } from "./recipe-conversations";
import type { RecipeConversationOption } from "./types";

/**
 * One complete shown+hidden conversation walk for the automation editor.
 * `active` covers a new automation, an existing one, and a draft opened from work.
 * Closing a menu does not cancel the walk. Leaving the editor or changing `reloadKey` does.
 * `ready` becomes true only after that full result is stored.
 */
export function useRecipeConversationCatalog(
  initialConversations: RecipeConversationOption[],
  active: boolean,
  reloadKey: string,
) {
  const [discovered, setDiscovered] = useState<RecipeConversationOption[]>([]);
  const [ready, setReady] = useState(false);
  const loadRef = useRef<{
    controller: AbortController;
    promise: Promise<void>;
  } | null>(null);
  const start = useCallback(() => {
    const current = loadRef.current;
    if (current) return current.promise;
    const controller = new AbortController();
    let entry: { controller: AbortController; promise: Promise<void> } | null = null;
    const promise = loadRecipeConversations(fetchInboxHeads, controller.signal)
      .then((next) => {
        if (controller.signal.aborted || loadRef.current !== entry) return;
        setDiscovered(next);
        setReady(true);
      })
      .catch((error: unknown) => {
        if (loadRef.current === entry) loadRef.current = null;
        throw error;
      });
    entry = { controller, promise };
    loadRef.current = entry;
    return promise;
  }, [reloadKey]);
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

  useEffect(() => {
    if (!active) return;
    const pending = start();
    void pending.catch(() => undefined);
    return () => {
      loadRef.current?.controller.abort();
      loadRef.current = null;
      setDiscovered([]);
      setReady(false);
    };
  }, [active, start]);

  const conversations = useMemo(() => {
    const byId = new Map(initialConversations.map((item) => [item.id, item]));
    for (const item of discovered) byId.set(item.id, item);
    return [...byId.values()];
  }, [initialConversations, discovered]);

  return { conversations, load, ready };
}
