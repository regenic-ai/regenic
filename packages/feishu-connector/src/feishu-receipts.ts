import type { MessageReceipt } from "@regenic/domain";

const receiptCache = new Map<string, { at: number; receipt: MessageReceipt }>();
const RECEIPT_TTL_MS = 15_000;

export function feishuSentMessageId(externalId: string): string | undefined {
  const trimmed = externalId.trim();
  if (trimmed.startsWith("om_")) {
    return trimmed;
  }
  const cut = trimmed.indexOf(":out:");
  if (cut < 0) {
    return undefined;
  }
  const sent = trimmed.slice(cut + 5).trim();
  return sent.startsWith("om_") ? sent : undefined;
}

export function receiptFromReadUsers(value: unknown): MessageReceipt {
  const items = readUserItems(value);
  if (items.length === 0) {
    return { state: "sent" };
  }
  const latest = items.reduce((best, item) =>
    item.timestamp > best.timestamp ? item : best,
  );
  return {
    state: "read",
    read_count: items.length,
    ...(latest.timestamp ? { read_at: latest.timestamp } : {}),
  };
}

export function cachedFeishuReceipt(messageId: string): MessageReceipt | undefined {
  const hit = receiptCache.get(messageId);
  if (!hit || Date.now() - hit.at > RECEIPT_TTL_MS) {
    return undefined;
  }
  return hit.receipt;
}

export function cacheFeishuReceipt(messageId: string, receipt: MessageReceipt): void {
  if (!messageId.startsWith("om_")) {
    return;
  }
  receiptCache.set(messageId, { at: Date.now(), receipt });
}

export function resetFeishuReceipts(): void {
  receiptCache.clear();
}

function readUserItems(
  value: unknown,
): Array<{ user_id: string; timestamp: string }> {
  const root = isObject(value) && isObject(value.data) ? value.data : value;
  if (!isObject(root) || !Array.isArray(root.items)) {
    return [];
  }
  return root.items.flatMap((item) => {
    if (!isObject(item) || typeof item.user_id !== "string" || !item.user_id.trim()) {
      return [];
    }
    return [
      {
        user_id: item.user_id.trim(),
        timestamp: typeof item.timestamp === "string" ? item.timestamp : "",
      },
    ];
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
