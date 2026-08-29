const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export const SEND_ARIA_LABELS = new Set([
  "send",
  "发送",
  "傳送",
  "enviar",
  "envoyer",
  "senden",
  "invia",
  "kirim",
  "送信",
  "보내기",
  "отправить",
  "ارسال",
]);

export function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._@-]+/g, "-").replace(/^-|-$/g, "") || "active-chat";
}

export function isPresenceText(value: string): boolean {
  return (
    /^(last seen|online|typing|recording|click here)/i.test(value)
    || /^last seen /i.test(value)
    || /^(最后一次出现|最后上线|在线|正在输入|正在录音|点击这里)/.test(value)
    || /^(visto por último|en línea|escribiendo)/i.test(value)
    || /^(zuletzt gesehen|online|tippt)/i.test(value)
  );
}

export function firstChatTitleFromLines(explicitTitle: string, lines: string[]): string | null {
  const explicit = normalize(explicitTitle);
  if (explicit) {
    return explicit;
  }
  const candidates = lines
    .map(normalize)
    .filter((candidate) => candidate && !isPresenceText(candidate) && !candidate.startsWith("ic-"));
  if (candidates.length > 1 && /^[A-Z]$/.test(candidates[0])) {
    return candidates[1];
  }
  return candidates[0] ?? null;
}

export function commandTargetsActiveChat(
  commandChatId: string,
  activeChatId: string | null | undefined,
): boolean {
  return Boolean(activeChatId && activeChatId === commandChatId);
}

export function isFromMeByDataId(dataId: string): boolean {
  return dataId.startsWith("true_") || dataId.includes("_true_");
}

export function isSendAriaLabel(label: string | null | undefined): boolean {
  return SEND_ARIA_LABELS.has(normalize(label ?? "").toLowerCase());
}

export function stableMessageId(params: {
  chatId: string;
  text: string;
  fromMe: boolean;
  dataId?: string | null;
  messageContext?: string;
}): string {
  const dataId = params.dataId?.trim();
  if (dataId) {
    return dataId;
  }
  const direction = params.fromMe ? "out" : "in";
  return `${direction}:${params.chatId}:${params.messageContext ?? ""}:${params.text}`;
}

export function parseWhatsAppTimestamp(
  prePlainText: string | undefined,
  now: () => string = () => new Date().toISOString(),
): string {
  const raw = prePlainText?.match(/\[([^\]]+)\]/)?.[1]?.trim();
  if (!raw) {
    return now();
  }
  const parsed = Date.parse(raw);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  const european = raw.match(
    /^(\d{1,2}):(\d{2})(?::(\d{2}))?,\s*(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  );
  if (european) {
    const [, hour, minute, second, day, month, year] = european;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second ?? 0),
    );
    if (!Number.isNaN(date.getTime())) {
      return date.toISOString();
    }
  }
  return now();
}

export function isLoopbackApiOrigin(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    return false;
  }
  return LOOPBACK_HOSTS.has(parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase());
}

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
  const fromDataId = trimmed.match(DATA_ID);
  if (fromDataId) {
    return fromDataId[2];
  }
  const embedded = trimmed.match(EMBEDDED_CHAT_ID);
  return embedded ? embedded[0] : null;
}

export function normalizeLoopbackApiOrigin(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim().replace(/\/$/, "") ?? "";
  if (!trimmed) {
    return fallback;
  }
  return isLoopbackApiOrigin(trimmed) ? trimmed : fallback;
}
