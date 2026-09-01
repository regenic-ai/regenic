import { Injectable } from "@nestjs/common";
import { EventEmitter } from "node:events";

export type PersonalEventType = "inbox.digest" | "thread.updated";

export type PersonalEventPayload = {
  "inbox.digest": { digest: string };
  "thread.updated": { thread_id: string };
};

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
    this.bus.emit("inbox.digest", { digest });
  }

  threadUpdated(thread_id: string): void {
    const id = thread_id.trim();
    if (!id) {
      return;
    }
    this.bus.emit("thread.updated", { thread_id: id });
  }

  subscribe(listener: PersonalEventListener): () => void {
    const onDigest = (payload: PersonalEventPayload["inbox.digest"]) =>
      listener("inbox.digest", payload);
    const onThread = (payload: PersonalEventPayload["thread.updated"]) =>
      listener("thread.updated", payload);
    this.bus.on("inbox.digest", onDigest);
    this.bus.on("thread.updated", onThread);
    return () => {
      this.bus.off("inbox.digest", onDigest);
      this.bus.off("thread.updated", onThread);
    };
  }
}
