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

export function opaqueWhatsAppLiveMessageId(messageId: string): string {
  const trimmed = messageId.trim();
  if (!trimmed) {
    return "";
  }
  if (!trimmed.includes(":")) {
    return trimmed;
  }
  return `h${fnv1aHex(trimmed)}`;
}

export function whatsappLiveExternalId(chatId: string, messageId: string): string {
  return `${chatId}:${opaqueWhatsAppLiveMessageId(messageId)}`;
}

function fnv1aHex(value: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x01000193);
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

export function whatsAppLiveActorId(input: {
  chatId: string;
  fromMe: boolean;
  senderId?: string;
}): string | undefined {
  if (input.fromMe) {
    return "local-owner";
  }
  const sender = input.senderId?.trim() ?? "";
  if (isWhatsAppChatId(sender)) {
    return sender;
  }
  if (whatsappConversationKind(input.chatId) === "group") {
    return sender || undefined;
  }
  return isWhatsAppChatId(input.chatId) ? input.chatId : undefined;
}
