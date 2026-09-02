import type { DshHistoryEvent } from "./dsh-cli-client";

const OFFER_TYPES = new Set([
  "user/message",
  "assistant/message",
  "turn/start",
  "turn/end",
  "tool/call",
]);

const hubs = new Map<string, DshSessionLiveHub>();

export const DSH_WAIT_DEBOUNCE_MS = 20;

/** Mux frames that mean wait(2) should fire for this inferior. */
export function dshMuxFrameWaits(frame: Record<string, unknown>): boolean {
  const type = typeof frame.type === "string" ? frame.type : "";
  if (type === "question/requested" || type === "approval/requested") {
    return true;
  }
  if (type !== "session/event") {
    return false;
  }
  const eventType = sessionEventType(frame.event);
  return eventType === "turn/start" || eventType === "turn/end";
}

export function sessionEventFromMuxFrame(
  frame: Record<string, unknown>,
): { sessionId: string; event: DshHistoryEvent } | undefined {
  if (frame.type !== "session/event") {
    return undefined;
  }
  const sessionId =
    typeof frame.sessionId === "string" ? frame.sessionId.trim() : "";
  const raw = frame.event;
  if (!sessionId || !isObject(raw) || typeof raw.type !== "string") {
    return undefined;
  }
  const seq = raw.seq;
  const time = raw.time;
  if (typeof seq !== "number" || !Number.isInteger(seq) || typeof time !== "number") {
    return undefined;
  }
  return {
    sessionId,
    event: {
      type: raw.type,
      seq,
      time,
      data: raw.data,
    },
  };
}

export function dshLiveHubFor(installationId: string): DshSessionLiveHub {
  let hub = hubs.get(installationId);
  if (!hub) {
    hub = new DshSessionLiveHub();
    hubs.set(installationId, hub);
  }
  return hub;
}

export function dropDshLiveHub(installationId: string): void {
  hubs.get(installationId)?.stop();
  hubs.delete(installationId);
}

/**
 * Live sysout for one DSH web install. Mux `session/event` frames land here;
 * poll drains them without advancing the history cursor. Wait listeners are
 * the absentee notify fd (turn/end, live prompts, mux reconnect).
 */
export class DshSessionLiveHub {
  private readonly buffers = new Map<string, DshHistoryEvent[]>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;

  offer(sessionId: string, event: DshHistoryEvent): boolean {
    if (this.stopped || !OFFER_TYPES.has(event.type)) {
      return false;
    }
    const bucket = this.buffers.get(sessionId) ?? [];
    if (bucket.some((item) => item.seq === event.seq)) {
      this.buffers.set(sessionId, bucket);
      return false;
    }
    bucket.push(event);
    this.buffers.set(sessionId, bucket);
    return true;
  }

  drain(sessionId: string): DshHistoryEvent[] {
    const events = this.buffers.get(sessionId) ?? [];
    this.buffers.delete(sessionId);
    return events;
  }

  wait(sessionId: string, listener: () => void): () => void {
    let bucket = this.waiters.get(sessionId);
    if (!bucket) {
      bucket = new Set();
      this.waiters.set(sessionId, bucket);
    }
    bucket.add(listener);
    return () => {
      const current = this.waiters.get(sessionId);
      if (!current) {
        return;
      }
      current.delete(listener);
      if (current.size === 0) {
        this.waiters.delete(sessionId);
        this.clearTimer(sessionId);
      }
    };
  }

  notify(sessionId: string): void {
    if (this.stopped || !this.waiters.get(sessionId)?.size) {
      return;
    }
    this.clearTimer(sessionId);
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.fire(sessionId);
    }, DSH_WAIT_DEBOUNCE_MS);
    timer.unref?.();
    this.timers.set(sessionId, timer);
  }

  notifyReconnect(): void {
    for (const sessionId of this.waiters.keys()) {
      this.notify(sessionId);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const sessionId of [...this.timers.keys()]) {
      this.clearTimer(sessionId);
    }
    this.waiters.clear();
    this.buffers.clear();
  }

  private fire(sessionId: string): void {
    const listeners = [...(this.waiters.get(sessionId) ?? [])];
    for (const listener of listeners) {
      listener();
    }
  }

  private clearTimer(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    this.timers.delete(sessionId);
  }
}

function sessionEventType(value: unknown): string | undefined {
  return isObject(value) && typeof value.type === "string"
    ? value.type
    : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
