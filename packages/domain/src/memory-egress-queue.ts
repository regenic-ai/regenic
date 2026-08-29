import { randomUUID } from "node:crypto";
import { ChannelDriverError, type EgressQueueItem } from "./channel-driver";

export interface MemoryEgressEnqueueInput {
  installation_id: string;
  thread_id: string;
  chat_id: string;
  text: string;
  send_now?: boolean;
  delay_ms?: number;
}

export interface MemoryEgressQueue {
  enqueue(input: MemoryEgressEnqueueInput): EgressQueueItem;
  list(installationId: string): EgressQueueItem[];
  ack(installationId: string, id: string): { acknowledged: boolean };
}

export function createMemoryEgressQueue(
  options: {
    ttl_ms?: number;
    max_pending?: number;
    rate_limit_ms?: number;
    max_text_chars?: number;
    now?: () => number;
  } = {},
): MemoryEgressQueue {
  const ttlMs = options.ttl_ms ?? 5 * 60 * 1_000;
  const maxPending = options.max_pending ?? 100;
  const rateLimitMs = options.rate_limit_ms ?? 0;
  const maxTextChars = options.max_text_chars ?? 4_000;
  const nowMs = options.now ?? Date.now;
  const commands = new Map<string, EgressQueueItem & { installation_id: string }>();
  const lastSend = new Map<string, number>();

  function prune(at: number): void {
    for (const [id, command] of commands) {
      if (Date.parse(command.expires_at) <= at) {
        commands.delete(id);
      }
    }
    for (const [key, sentAt] of lastSend) {
      if (at - sentAt >= ttlMs) {
        lastSend.delete(key);
      }
    }
  }

  return {
    enqueue(input) {
      const text = input.text.trim();
      if (!text) {
        throw new ChannelDriverError("invalid_config", "text is required");
      }
      if (text.length > maxTextChars) {
        throw new ChannelDriverError(
          "invalid_config",
          `text must be ${maxTextChars} characters or shorter`,
        );
      }
      const at = nowMs();
      prune(at);
      const pending = [...commands.values()].filter(
        (command) => command.installation_id === input.installation_id,
      );
      if (pending.length >= maxPending) {
        throw new ChannelDriverError("throttled", "Send command queue is full");
      }
      if (rateLimitMs > 0) {
        const rateKey = `${input.installation_id}:${input.chat_id}`;
        const last = lastSend.get(rateKey) ?? 0;
        if (at - last < rateLimitMs) {
          throw new ChannelDriverError("throttled", "Send commands are rate limited");
        }
        lastSend.set(rateKey, at);
      }
      const command = {
        id: randomUUID(),
        installation_id: input.installation_id,
        thread_id: input.thread_id,
        chat_id: input.chat_id,
        text,
        send_now: input.send_now === true,
        delay_ms: input.delay_ms ?? 0,
        created_at: new Date(at).toISOString(),
        expires_at: new Date(at + ttlMs).toISOString(),
      };
      commands.set(command.id, command);
      const { installation_id: _installationId, ...visible } = command;
      return visible;
    },
    list(installationId) {
      prune(nowMs());
      return [...commands.values()]
        .filter((command) => command.installation_id === installationId)
        .sort((left, right) => left.created_at.localeCompare(right.created_at))
        .map(({ installation_id: _installationId, ...visible }) => visible);
    },
    ack(installationId, id) {
      const command = commands.get(id);
      if (!command || command.installation_id !== installationId) {
        return { acknowledged: false };
      }
      commands.delete(id);
      return { acknowledged: true };
    },
  };
}
