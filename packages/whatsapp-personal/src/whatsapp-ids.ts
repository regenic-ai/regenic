const CHAT_ID = /^(?:[\d.-]+|[\w.+-]+)@(?:c\.us|g\.us|lid)$/i;
const EMBEDDED_CHAT_ID = /([\d.-]+|[\w.+-]+)@(?:c\.us|g\.us|lid)/i;
const DATA_ID = /^(true|false)_((?:[\d.-]+|[\w.+-]+)@(?:c\.us|g\.us|lid))_(.+)$/i;

export function isWhatsAppChatId(value: string | undefined): boolean {
  return Boolean(value && CHAT_ID.test(value.trim()));
}

export function parseWhatsAppChatId(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  if (isWhatsAppChatId(trimmed)) {
    return trimmed;
  }
  const fromDataId = parseWhatsAppDataId(trimmed);
  if (fromDataId) {
    return fromDataId.chat_id;
  }
  const embedded = trimmed.match(EMBEDDED_CHAT_ID);
  return embedded ? embedded[0] : null;
}

export function parseWhatsAppDataId(
  value: string | undefined,
): { from_me: boolean; chat_id: string; message_id: string } | null {
  const match = value?.trim().match(DATA_ID);
  if (!match) {
    return null;
  }
  return {
    from_me: match[1].toLowerCase() === "true",
    chat_id: match[2],
    message_id: match[3],
  };
}

export function whatsappConversationKind(chatId: string): string | undefined {
  if (chatId.endsWith("@g.us")) {
    return "group";
  }
  if (chatId.endsWith("@c.us") || chatId.endsWith("@lid")) {
    return "direct";
  }
  return undefined;
}

export function whatsappThreadId(chatId: string): string {
  return `whatsapp-personal:${chatId}`;
}
