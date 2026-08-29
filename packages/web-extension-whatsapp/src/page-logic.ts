const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export const OUTGOING_WA_ICONS = new Set([
  "msg-check",
  "msg-dblcheck",
  "msg-dblcheck-ack",
  "msg-time",
  "msg-wait",
  "tail-out",
  "status-check",
  "status-dblcheck",
  "status-time",
]);

export const INCOMING_WA_ICONS = new Set(["tail-in"]);

export function isOutgoingWhatsAppIcon(value: string | null | undefined): boolean {
  return OUTGOING_WA_ICONS.has(normalize(value ?? "").toLowerCase());
}

export function isIncomingWhatsAppIcon(value: string | null | undefined): boolean {
  return INCOMING_WA_ICONS.has(normalize(value ?? "").toLowerCase());
}

export function bubbleLooksOutgoing(
  pane: { left: number; width: number },
  bubble: { left: number; width: number },
): boolean | null {
  if (pane.width <= 0 || bubble.width <= 0) {
    return null;
  }
  const leftGap = bubble.left - pane.left;
  const rightGap = pane.left + pane.width - (bubble.left + bubble.width);
  if (Math.abs(leftGap - rightGap) < pane.width * 0.08) {
    return null;
  }
  return rightGap < leftGap;
}

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
  if (candidates.length > 1 && /^[A-Z]{1,3}$/.test(candidates[0])) {
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
  const parsed = parseWhatsAppDataId(dataId);
  if (parsed) {
    return parsed.from_me;
  }
  return dataId.startsWith("true_");
}

export function isSendAriaLabel(label: string | null | undefined): boolean {
  return SEND_ARIA_LABELS.has(normalize(label ?? "").toLowerCase());
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

export function stableMessageId(params: {
  chatId: string;
  text: string;
  fromMe: boolean;
  dataId?: string | null;
  messageContext?: string;
}): string {
  const dataId = params.dataId?.trim();
  if (dataId) {
    return opaqueWhatsAppLiveMessageId(dataId);
  }
  return opaqueWhatsAppLiveMessageId(
    `${params.fromMe ? "out" : "in"}|${params.chatId}|${params.messageContext ?? ""}|${params.text}`,
  );
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

export function conversationJidFromCandidates(
  ids: Array<string | null | undefined>,
): string | null {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const groups = unique.filter((id) => id.endsWith("@g.us"));
  if (groups.length === 1) {
    return groups[0];
  }
  if (groups.length > 1) {
    return null;
  }
  return unique.length === 1 ? unique[0] : null;
}

export function liveMessageBelongsToOpenChat(
  openChatId: string,
  dataChatId: string | null | undefined,
): boolean {
  if (!dataChatId) {
    return true;
  }
  if (dataChatId === openChatId) {
    return true;
  }
  const dataIsGroup = dataChatId.endsWith("@g.us");
  if (openChatId.endsWith("@g.us")) {
    return !dataIsGroup;
  }
  return !dataIsGroup;
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
  const fromPhone = phoneNumberToChatId(trimmed);
  if (fromPhone) {
    return fromPhone;
  }
  const embedded = trimmed.match(EMBEDDED_CHAT_ID);
  return embedded ? embedded[0] : null;
}

function phoneNumberToChatId(value: string): string | null {
  const match = value.match(/(?:wa\.me\/|[?&]phone=|tel:)(\+?\d[\d\s-]{6,18}\d)/i);
  if (!match) {
    return null;
  }
  const digits = match[1].replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    return null;
  }
  return `${digits}@c.us`;
}

export function firstWhatsAppChatIdFromValues(
  values: Array<string | null | undefined>,
): string | null {
  for (const value of values) {
    const parsed = parseWhatsAppChatId(value ?? undefined);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

const WID_SERVERS = new Set(["c.us", "g.us", "lid"]);
const REACT_JID_KEYS = [
  "$1",
  "_serialized",
  "serialized",
  "id",
  "_id",
  "chatId",
  "chat_id",
  "jid",
  "wid",
  "key",
  "remote",
  "peer",
  "chat",
  "contact",
  "conversation",
  "data",
  "memoizedProps",
  "pendingProps",
  "memoizedState",
];
const DISPLAY_NAME_KEYS = [
  "name",
  "subject",
  "formattedTitle",
  "displayName",
  "formattedName",
  "notify",
  "shortName",
  "pushname",
  "verifiedName",
];

export interface NamedWhatsAppChat {
  id: string;
  names: string[];
}

export function jidFromReactLikeValue(value: unknown): string | null {
  return walkForJid(value, 0, new Set());
}

export function namedChatFromRecord(value: unknown): NamedWhatsAppChat | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = walkForJid(record.id, 0, new Set()) ?? walkForJid(record._id, 0, new Set());
  if (!id) {
    return null;
  }
  const names = displayNamesFrom(record);
  if (record.contact && typeof record.contact === "object") {
    names.push(...displayNamesFrom(record.contact as Record<string, unknown>));
  }
  const unique = [...new Set(names.map(normalize).filter(Boolean))];
  if (!unique.length) {
    return null;
  }
  return { id, names: unique };
}

export function uniqueJidForDisplayName(
  title: string | null | undefined,
  chats: NamedWhatsAppChat[],
): string | null {
  const wanted = normalize(title ?? "");
  if (!wanted || isPresenceText(wanted)) {
    return null;
  }
  const exact = uniqueIds(
    chats.filter((chat) => chat.names.some((name) => name === wanted)),
  );
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    return null;
  }
  const wantedLower = wanted.toLowerCase();
  const insensitive = uniqueIds(
    chats.filter((chat) => chat.names.some((name) => name.toLowerCase() === wantedLower)),
  );
  if (insensitive.length === 1) {
    return insensitive[0];
  }
  if (insensitive.length > 1) {
    return null;
  }
  const fuzzy = uniqueIds(
    chats.filter((chat) => chat.names.some((name) => titlesReferToSameChat(name, wanted))),
  );
  return fuzzy.length === 1 ? fuzzy[0] : null;
}

export function isIgnorableChatListTitle(title: string | null | undefined): boolean {
  const value = normalize(title ?? "");
  if (!value) {
    return true;
  }
  return (
    /^(archived|archived chats|已归档|已封存)$/i.test(value)
    || /^message notifications are off/i.test(value)
    || /^turn on$/i.test(value)
    || /^get whatsapp for/i.test(value)
    || /sync your contacts/i.test(value)
  );
}

export function phoneDigitsFromDisplayTitle(title: string | null | undefined): string | null {
  const stripped = stripTitleEllipsis(normalize(title ?? ""));
  if (!stripped) {
    return null;
  }
  const letters = stripped.replace(/[\d\s+().-]/g, "");
  if (letters.length > 2) {
    return null;
  }
  const digits = stripped.replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

export function titlesReferToSameChat(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = normalize(left ?? "");
  const b = normalize(right ?? "");
  if (!a || !b) {
    return false;
  }
  if (a === b) {
    return true;
  }
  const compactA = stripTitleEllipsis(a).toLowerCase();
  const compactB = stripTitleEllipsis(b).toLowerCase();
  if (compactA === compactB) {
    return true;
  }
  const phoneA = phoneDigitsFromDisplayTitle(a);
  const phoneB = phoneDigitsFromDisplayTitle(b);
  if (phoneA && phoneB && phonesMatch(phoneA, phoneB)) {
    return true;
  }
  if (hasTitleEllipsis(a) || hasTitleEllipsis(b)) {
    const shorter = compactA.length <= compactB.length ? compactA : compactB;
    const longer = compactA.length <= compactB.length ? compactB : compactA;
    return shorter.length >= 6 && longer.startsWith(shorter);
  }
  return false;
}

function stripTitleEllipsis(value: string): string {
  return value.replace(/[.…]+$/g, "").trim();
}

function hasTitleEllipsis(value: string): boolean {
  return /[.…]$/.test(normalize(value));
}

function phonesMatch(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 8 && (longer.startsWith(shorter) || longer.endsWith(shorter));
}

export function chatIdFromPhoneDisplayTitle(title: string | null | undefined): string | null {
  const digits = phoneDigitsFromDisplayTitle(title);
  return digits ? `${digits}@c.us` : null;
}

export function phoneDigitsFromWhatsAppChatId(chatId: string): string | null {
  const match = chatId.trim().match(/^(\d{7,15})@c\.us$/i);
  return match ? match[1] : null;
}

export function fromMeFromPrePlainText(
  value: string | undefined,
  localNames: readonly string[] = [],
): boolean | null {
  const match = value?.match(/\]\s*(.+?):\s*$/);
  if (!match) {
    return null;
  }
  const name = normalize(match[1]).replace(/^~\s*/, "");
  if (!name) {
    return null;
  }
  if (/^(you|你|您)$/i.test(name)) {
    return true;
  }
  const wanted = name.toLowerCase();
  if (localNames.some((local) => normalize(local).toLowerCase() === wanted)) {
    return true;
  }
  return null;
}

export function groupSenderFromDomTexts(texts: readonly string[]): {
  name: string | null;
  phone: string | null;
} {
  let name: string | null = null;
  let phone: string | null = null;
  for (const raw of texts) {
    const text = normalize(raw);
    if (!text || text.length >= 80) {
      continue;
    }
    if (/^~\s*.+$/.test(text)) {
      name = text.replace(/^~\s*/, "");
      continue;
    }
    if (/^\+\d[\d\s\-()]{6,}$/.test(text)) {
      phone = text;
    }
  }
  return { name, phone };
}

export function senderNameFromPrePlainText(value: string | undefined): string | null {
  const match = value?.match(/\]\s*(.+?):\s*$/);
  if (!match) {
    return null;
  }
  const name = normalize(match[1]).replace(/^~\s*/, "");
  if (!name || /^(you|你|您)$/i.test(name)) {
    return null;
  }
  return name;
}

export function isAuthorLabelText(value: string): boolean {
  const text = normalize(value);
  if (!text) {
    return true;
  }
  if (/^(you|你|您)$/i.test(text)) {
    return true;
  }
  if (/^~\s*.+$/.test(text) && text.length < 80) {
    return true;
  }
  return /^\+\d[\d\s\-()]{6,}$/.test(text);
}

export function isLoadOlderMessagesText(value: string): boolean {
  return /click here to get older messages|点击这里获取更早的消息|點這裡取得較早的訊息/i.test(
    normalize(value),
  );
}

export function stableGroupParticipantId(
  chatId: string,
  senderName: string,
  jid?: string | null,
): string {
  const parsed = parseWhatsAppChatId(jid ?? undefined);
  if (parsed) {
    return parsed;
  }
  const slug = normalize(senderName)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return `participant:${chatId}:${slug || "unknown"}`;
}

function uniqueIds(chats: NamedWhatsAppChat[]): string[] {
  return [...new Set(chats.map((chat) => chat.id))];
}

function displayNamesFrom(record: Record<string, unknown>): string[] {
  const names: string[] = [];
  for (const key of DISPLAY_NAME_KEYS) {
    const value = record[key];
    if (typeof value === "string" && normalize(value) && !isWhatsAppChatId(value)) {
      names.push(value);
    }
  }
  return names;
}

function walkForJid(value: unknown, depth: number, seen: Set<object>): string | null {
  if (value == null || depth > 8) {
    return null;
  }
  if (typeof value === "string") {
    return parseWhatsAppChatId(value);
  }
  if (typeof value !== "object") {
    return null;
  }
  if (seen.has(value)) {
    return null;
  }
  seen.add(value);
  if (seen.size > 80) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const direct = jidFromWidShape(record);
  if (direct) {
    return direct;
  }
  for (const key of REACT_JID_KEYS) {
    if (key in record) {
      const found = walkForJid(record[key], depth + 1, seen);
      if (found) {
        return found;
      }
    }
  }
  if (record.next && typeof record.next === "object") {
    return walkForJid(record.next, depth + 1, seen);
  }
  return null;
}

function jidFromWidShape(record: Record<string, unknown>): string | null {
  const serialized = firstWhatsAppChatIdFromValues([
    typeof record._serialized === "string" ? record._serialized : undefined,
    typeof record.$1 === "string" ? record.$1 : undefined,
    typeof record.serialized === "string" ? record.serialized : undefined,
  ]);
  if (serialized) {
    return serialized;
  }
  if (typeof record.user === "string" && typeof record.server === "string") {
    const server = record.server.replace(/^@/, "").toLowerCase();
    if (WID_SERVERS.has(server)) {
      return parseWhatsAppChatId(`${record.user}@${record.server}`);
    }
  }
  return null;
}

export function isOneShotScanResult(value: string): boolean {
  return /one-shot|not ingested|did not respond after injection/i.test(value);
}

export function normalizeLoopbackApiOrigin(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim().replace(/\/$/, "") ?? "";
  if (!trimmed) {
    return fallback;
  }
  return isLoopbackApiOrigin(trimmed) ? trimmed : fallback;
}
