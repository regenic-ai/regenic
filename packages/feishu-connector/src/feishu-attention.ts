import type { ThreadAttention } from "@regenic/domain";

const lastInbound = new Map<string, string>();
const localRead = new Set<string>();
const statusCache = new Map<string, { at: number; is_read: boolean }>();
const STATUS_TTL_MS = 15_000;

export function rememberFeishuInbound(chatId: string, messageId: string): void {
  const id = messageId.trim();
  if (!chatId.trim() || !id.startsWith("om_")) {
    return;
  }
  lastInbound.set(chatId, id);
  localRead.delete(chatId);
}

export function lastFeishuInbound(chatId: string): string | undefined {
  return lastInbound.get(chatId);
}

export function feishuMessageId(value?: string): string | undefined {
  const id = value?.trim() ?? "";
  return id.startsWith("om_") ? id : undefined;
}

/** Live poll cache first; store-derived inbound id is only a hint. */
export function resolveFeishuInbound(
  chatId: string,
  hint?: string,
): string | undefined {
  return lastFeishuInbound(chatId) ?? feishuMessageId(hint);
}

export function markFeishuChatRead(chatId: string): void {
  localRead.add(chatId);
}

export function feishuAttentionOf(chatId: string, isRead?: boolean): ThreadAttention | undefined {
  if (localRead.has(chatId)) {
    return { unread: false, unread_count: 0 };
  }
  if (isRead === undefined) {
    return undefined;
  }
  return isRead
    ? { unread: false, unread_count: 0 }
    : { unread: true, unread_count: 1 };
}

export function cacheFeishuReadStatus(messageId: string, isRead: boolean): void {
  if (!messageId.startsWith("om_")) {
    return;
  }
  statusCache.set(messageId, { at: Date.now(), is_read: isRead });
}

export function cachedFeishuReadStatus(messageId: string): boolean | undefined {
  const hit = statusCache.get(messageId);
  if (!hit || Date.now() - hit.at > STATUS_TTL_MS) {
    return undefined;
  }
  return hit.is_read;
}

export function resetFeishuAttention(): void {
  lastInbound.clear();
  localRead.clear();
  statusCache.clear();
}

export function parseFeishuReadStatus(value: unknown): Map<string, boolean> {
  const root = isObject(value) && isObject(value.data) ? value.data : value;
  const statuses = new Map<string, boolean>();
  if (!isObject(root) || !Array.isArray(root.items)) {
    return statuses;
  }
  for (const item of root.items) {
    if (!isObject(item) || typeof item.message_id !== "string") {
      continue;
    }
    statuses.set(item.message_id, item.is_read === true);
  }
  return statuses;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
