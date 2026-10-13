import {
  conversationId,
  parseConversationThread,
  resolveMessageSurface,
  type ConversationThread,
  type EventRecord,
} from "@regenic/domain";
import { resolveInboxBody } from "./inbox-body";

export function byEventTime(
  left: { event: EventRecord },
  right: { event: EventRecord },
): number {
  if (left.event.occurred_at !== right.event.occurred_at) {
    return left.event.occurred_at < right.event.occurred_at ? -1 : 1;
  }
  return left.event.id < right.event.id ? -1 : 1;
}

export function messageSurfaceOf(
  event: EventRecord,
  body: Awaited<ReturnType<typeof resolveInboxBody>>,
) {
  return resolveMessageSurface({
    source: event.source,
    external_id: event.external_id,
    body_text: body.body_text,
    stored: body.surface,
  });
}

export function threadOf(event: EventRecord): ConversationThread {
  const id = conversationId(event.source, event.external_id, event.id);
  try {
    return parseConversationThread(id);
  } catch {
    return { source: event.source, target: event.external_id };
  }
}

