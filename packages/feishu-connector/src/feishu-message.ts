export const FEISHU_SOURCE = "feishu";

export interface FeishuMention {
  key?: string;
  id?: string;
  name?: string;
}

export function extractFeishuText(
  msgType: string,
  content: string | undefined,
  names?: ReadonlyMap<string, string>,
  mentions?: readonly FeishuMention[],
): string | undefined {
  if (!content) {
    return undefined;
  }
  const resolved = mergeFeishuDisplayNames(names, mentions);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return msgType === "text"
      ? resolveAtText(content.trim(), resolved) || undefined
      : undefined;
  }
  if (msgType === "text") {
    return isObject(parsed) && typeof parsed.text === "string"
      ? resolveAtText(parsed.text.trim(), resolved) || undefined
      : undefined;
  }
  if (msgType === "post") {
    const text = applyMentionKeys(extractPostText(parsed, resolved), resolved);
    return text || undefined;
  }
  return undefined;
}

export function collectFeishuUserIds(input: {
  sender_id?: string;
  content?: string;
  mentions?: readonly FeishuMention[];
}): string[] {
  const ids = new Set<string>();
  addLookupId(ids, input.sender_id);
  for (const mention of input.mentions ?? []) {
    addLookupId(ids, mention.id);
  }
  if (!input.content) {
    return [...ids];
  }
  let parsed: unknown = input.content;
  try {
    parsed = JSON.parse(input.content);
  } catch {
    collectAtIds(input.content, ids);
    return [...ids];
  }
  collectAtIdsFromValue(parsed, ids);
  return [...ids];
}

export function feishuMentionNames(
  mentions?: readonly FeishuMention[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const mention of mentions ?? []) {
    const name = cleanMentionName(mention.name);
    if (!name) {
      if (mention.id && isEveryoneId(mention.id)) {
        rememberEveryone(names, mention, "所有人");
      }
      continue;
    }
    if (mention.id) {
      names.set(mention.id, name);
    }
    if (mention.key) {
      names.set(mention.key, name);
    }
    if (
      (mention.id && isEveryoneId(mention.id)) ||
      (mention.key && isEveryoneId(mention.key))
    ) {
      rememberEveryone(names, mention, name);
    }
  }
  return names;
}

export function mergeFeishuDisplayNames(
  names?: ReadonlyMap<string, string>,
  mentions?: readonly FeishuMention[],
): Map<string, string> {
  const merged = feishuMentionNames(mentions);
  if (!names) {
    return merged;
  }
  for (const [id, name] of names) {
    if (!merged.has(id)) {
      merged.set(id, name);
    }
  }
  return merged;
}

export function feishuConversationKind(
  chatMode: string | undefined,
): "group" | "direct" {
  return chatMode === "p2p" ? "direct" : "group";
}

export function feishuCreateTimeToIso(
  createTime: string | undefined,
  fallback: string,
): string {
  const ms = feishuCreateTimeMs(createTime);
  if (ms === undefined) {
    return fallback;
  }
  return new Date(ms).toISOString();
}

export function feishuCreateTimeToStartSeconds(
  createTime: string | undefined,
): string | undefined {
  const ms = feishuCreateTimeMs(createTime);
  if (ms === undefined) {
    return undefined;
  }
  return String(Math.floor(ms / 1000));
}

export function senderKind(
  senderType: string | undefined,
): "user" | "assistant" | undefined {
  if (senderType === "user") {
    return "user";
  }
  if (senderType === "app" || senderType === "bot") {
    return "assistant";
  }
  return undefined;
}

function feishuCreateTimeMs(createTime: string | undefined): number | undefined {
  if (!createTime) {
    return undefined;
  }
  const n = Number(createTime);
  if (!Number.isFinite(n) || n <= 0) {
    return undefined;
  }
  return n < 1e12 ? n * 1000 : n;
}

function extractPostText(
  value: unknown,
  names?: ReadonlyMap<string, string>,
): string {
  if (!isObject(value)) {
    return "";
  }
  const locales = ["zh_cn", "en_us", "ja_jp"];
  for (const locale of locales) {
    const localized = value[locale];
    if (isObject(localized)) {
      return extractPostText(localized, names);
    }
  }
  const chunks: string[] = [];
  if (typeof value.title === "string" && value.title.trim()) {
    chunks.push(value.title.trim());
  }
  if (Array.isArray(value.content)) {
    const body = walkPostNodes(value.content, names);
    if (body) {
      chunks.push(body);
    }
  }
  return chunks.join("\n").trim();
}

function walkPostNodes(
  value: unknown,
  names?: ReadonlyMap<string, string>,
): string {
  if (Array.isArray(value)) {
    const isBlock = value.length > 0 && value.every((item) => Array.isArray(item));
    return value
      .map((item) => walkPostNodes(item, names))
      .filter((item) => item.length > 0)
      .join(isBlock ? "\n" : "");
  }
  if (!isObject(value)) {
    return "";
  }
  const tag = value.tag;
  if (tag === "at") {
    return mentionLabel(value, names);
  }
  if (tag === "text" || tag === "a") {
    return typeof value.text === "string" ? value.text : "";
  }
  if (Array.isArray(value.content)) {
    return walkPostNodes(value.content, names);
  }
  return "";
}

function mentionLabel(
  value: Record<string, unknown>,
  names?: ReadonlyMap<string, string>,
): string {
  const userId =
    typeof value.user_id === "string" ? value.user_id : undefined;
  if (userId && isEveryoneId(userId)) {
    return everyoneLabel(names);
  }
  const userName =
    typeof value.user_name === "string" ? value.user_name : undefined;
  const text = typeof value.text === "string" ? value.text : undefined;
  const named =
    (userId ? names?.get(userId) : undefined) ??
    (userName ? names?.get(userName) : undefined) ??
    (text ? names?.get(text) : undefined) ??
    userName ??
    text;
  const clean = cleanMentionName(named);
  if (!clean) {
    return text ?? userName ?? "";
  }
  return `@${clean}`;
}

function resolveAtText(
  text: string,
  names?: ReadonlyMap<string, string>,
): string {
  return applyMentionKeys(
    text.replace(
      /<at\s+user_id="([^"]+)">(.*?)<\/at>/gi,
      (_all, userId, label) => {
        if (isEveryoneId(String(userId))) {
          return everyoneLabel(names);
        }
        const named =
          names?.get(String(userId)) ??
          names?.get(String(label).trim()) ??
          String(label)
            .replace(/^@/, "")
            .trim();
        const clean = cleanMentionName(named);
        if (!clean) {
          return String(label);
        }
        return `@${clean}`;
      },
    ),
    names,
  )
    .replace(/\s+/g, " ")
    .trim();
}

function applyMentionKeys(
  text: string,
  names?: ReadonlyMap<string, string>,
): string {
  return text.replace(/@_all\b|@_user_\d+/gi, (key) => {
    if (isEveryoneId(key)) {
      return everyoneLabel(names);
    }
    const named = names?.get(key);
    const clean = cleanMentionName(named);
    return clean ? `@${clean}` : key;
  });
}

function collectAtIdsFromValue(value: unknown, ids: Set<string>): void {
  if (typeof value === "string") {
    collectAtIds(value, ids);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectAtIdsFromValue(item, ids);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  addLookupId(
    ids,
    typeof value.user_id === "string" ? value.user_id : undefined,
  );
  for (const nested of Object.values(value)) {
    collectAtIdsFromValue(nested, ids);
  }
}

function collectAtIds(text: string, ids: Set<string>): void {
  const pattern = /<at\s+user_id="([^"]+)"/gi;
  let match = pattern.exec(text);
  while (match) {
    addLookupId(ids, match[1]);
    match = pattern.exec(text);
  }
}

function addLookupId(ids: Set<string>, id: string | undefined): void {
  const value = id?.trim();
  if (!value || isEveryoneId(value) || isMentionPlaceholder(value.replace(/^@/, ""))) {
    return;
  }
  ids.add(value);
}

function rememberEveryone(
  names: Map<string, string>,
  mention: FeishuMention,
  name: string,
): void {
  names.set("all", name);
  names.set("@_all", name);
  if (mention.id) {
    names.set(mention.id, name);
  }
  if (mention.key) {
    names.set(mention.key, name);
  }
}

function everyoneLabel(names?: ReadonlyMap<string, string>): string {
  const named =
    cleanMentionName(names?.get("all")) ??
    cleanMentionName(names?.get("@_all"));
  return `@${named ?? "所有人"}`;
}

function cleanMentionName(value: string | undefined): string | undefined {
  const clean = value?.replace(/^@/, "").trim();
  if (!clean || isMentionPlaceholder(clean)) {
    return undefined;
  }
  return clean;
}

function isEveryoneId(id: string): boolean {
  const value = id.trim().toLowerCase();
  return value === "all" || value === "@_all";
}

function isMentionPlaceholder(value: string): boolean {
  return /^_user_\d+$/i.test(value) || /^_all$/i.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
