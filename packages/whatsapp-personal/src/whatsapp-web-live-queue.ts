import { createMemoryEgressQueue, type EgressQueueItem } from "@regenic/domain";
import { whatsappThreadId } from "./whatsapp-ids";

const SEND_RATE_LIMIT_MS = 2_000;
const SEND_COMMAND_TTL_MS = 5 * 60 * 1_000;
const MAX_PENDING_SEND_COMMANDS = 100;
const MAX_SEND_TEXT_CHARS = 4_000;

export interface WhatsAppLiveOutboundMatch {
  id: string;
}

const queue = createMemoryEgressQueue({
  ttl_ms: SEND_COMMAND_TTL_MS,
  max_pending: MAX_PENDING_SEND_COMMANDS,
  rate_limit_ms: SEND_RATE_LIMIT_MS,
  max_text_chars: MAX_SEND_TEXT_CHARS,
});
const recentOutbounds = new Map<string, { id: string; expires_at: number }>();

export function enqueueWhatsAppLiveCommand(input: {
  installationId: string;
  chatId: string;
  text: string;
  sendNow?: boolean;
  delayMs?: number;
}): EgressQueueItem {
  pruneOutbounds(Date.now());
  const command = queue.enqueue({
    installation_id: input.installationId,
    thread_id: whatsappThreadId(input.chatId),
    chat_id: input.chatId,
    text: input.text,
    send_now: input.sendNow,
    delay_ms: input.delayMs,
  });
  rememberOutbound(
    input.chatId,
    command.text,
    command.id,
    Date.parse(command.expires_at),
  );
  return command;
}

export function listWhatsAppLiveCommands(installationId: string): EgressQueueItem[] {
  pruneOutbounds(Date.now());
  return queue.list(installationId);
}

export function acknowledgeWhatsAppLiveCommand(
  installationId: string,
  id: string,
): { acknowledged: boolean } {
  return queue.ack(installationId, id);
}

export function matchWhatsAppLiveOutbound(
  chatId: string,
  text: string,
): WhatsAppLiveOutboundMatch | undefined {
  pruneOutbounds(Date.now());
  const remembered = recentOutbounds.get(outboundKey(chatId, text));
  if (!remembered) {
    return undefined;
  }
  return { id: remembered.id };
}

function rememberOutbound(
  chatId: string,
  text: string,
  id: string,
  expiresAt: number,
): void {
  recentOutbounds.set(outboundKey(chatId, text), { id, expires_at: expiresAt });
}

function outboundKey(chatId: string, text: string): string {
  return `${chatId}:${text.replace(/\s+/g, " ").trim()}`;
}

function pruneOutbounds(nowMs: number): void {
  for (const [key, remembered] of recentOutbounds) {
    if (remembered.expires_at <= nowMs) {
      recentOutbounds.delete(key);
    }
  }
}
