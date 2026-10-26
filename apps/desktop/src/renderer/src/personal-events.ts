import { currentApiOrigin, subscribeApiOriginChanged } from "./api.ts";
import {
  connectPersonalEventsWithDeps,
  type PersonalEventHandlers,
  type PersonalEventsDeps,
} from "./personal-events-core.ts";

export type { PersonalEventHandlers, PersonalEventsDeps } from "./personal-events-core.ts";
export { personalEventsUrl } from "./personal-events-core.ts";

const workListeners = new Set<(workItemId: string) => void>();

export function subscribeWorkUpdates(
  listener: (workItemId: string) => void,
): () => void {
  workListeners.add(listener);
  return () => workListeners.delete(listener);
}

export function connectPersonalEvents(
  handlers: PersonalEventHandlers,
  deps: Partial<PersonalEventsDeps> = {},
): () => void {
  return connectPersonalEventsWithDeps({
    ...handlers,
    onWorkUpdated: (workItemId) => {
      handlers.onWorkUpdated?.(workItemId);
      for (const listener of workListeners) listener(workItemId);
    },
  }, {
    origin: deps.origin ?? currentApiOrigin,
    subscribeOrigin: deps.subscribeOrigin ?? subscribeApiOriginChanged,
    EventSource: deps.EventSource ?? EventSource,
    setTimeout: deps.setTimeout ?? ((handler, ms) => window.setTimeout(handler, ms)),
    clearTimeout: deps.clearTimeout ?? ((timer) => window.clearTimeout(timer)),
  });
}
