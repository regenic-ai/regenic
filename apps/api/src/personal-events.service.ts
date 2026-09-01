import { Injectable } from "@nestjs/common";
import { EventEmitter } from "node:events";
import {
  PERSONAL_SSE_INBOX_DIGEST,
  PERSONAL_SSE_THREAD_UPDATED,
  type PersonalSseEventType,
  type PersonalSsePayload,
} from "@regenic/domain";

export type PersonalEventType = PersonalSseEventType;
export type PersonalEventPayload = PersonalSsePayload;

type PersonalEventListener = <T extends PersonalEventType>(
  type: T,
  payload: PersonalEventPayload[T],
) => void;

@Injectable()
export class PersonalEventsService {
  private readonly bus = new EventEmitter();

  inboxDigest(digest: string): void {
    if (!digest.trim()) {
      return;
    }
    this.bus.emit(PERSONAL_SSE_INBOX_DIGEST, { digest });
  }

  threadUpdated(thread_id: string): void {
    const id = thread_id.trim();
    if (!id) {
      return;
    }
    this.bus.emit(PERSONAL_SSE_THREAD_UPDATED, { thread_id: id });
  }

  subscribe(listener: PersonalEventListener): () => void {
    const onDigest = (payload: PersonalEventPayload["inbox.digest"]) =>
      listener(PERSONAL_SSE_INBOX_DIGEST, payload);
    const onThread = (payload: PersonalEventPayload["thread.updated"]) =>
      listener(PERSONAL_SSE_THREAD_UPDATED, payload);
    this.bus.on(PERSONAL_SSE_INBOX_DIGEST, onDigest);
    this.bus.on(PERSONAL_SSE_THREAD_UPDATED, onThread);
    return () => {
      this.bus.off(PERSONAL_SSE_INBOX_DIGEST, onDigest);
      this.bus.off(PERSONAL_SSE_THREAD_UPDATED, onThread);
    };
  }
}
