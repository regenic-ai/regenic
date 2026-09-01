import { currentApiOrigin, subscribeApiOriginChanged } from "./api.ts";
import {
  connectPersonalEventsWithDeps,
  type PersonalEventHandlers,
  type PersonalEventsDeps,
} from "./personal-events-core.ts";

export type { PersonalEventHandlers, PersonalEventsDeps } from "./personal-events-core.ts";
export { personalEventsUrl } from "./personal-events-core.ts";

export function connectPersonalEvents(
  handlers: PersonalEventHandlers,
  deps: Partial<PersonalEventsDeps> = {},
): () => void {
  return connectPersonalEventsWithDeps(handlers, {
    origin: deps.origin ?? currentApiOrigin,
    subscribeOrigin: deps.subscribeOrigin ?? subscribeApiOriginChanged,
    EventSource: deps.EventSource ?? EventSource,
    setTimeout: deps.setTimeout ?? ((handler, ms) => window.setTimeout(handler, ms)),
    clearTimeout: deps.clearTimeout ?? ((timer) => window.clearTimeout(timer)),
  });
}
