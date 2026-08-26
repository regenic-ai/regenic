export const FEISHU_SOURCE = "feishu";

export interface FeishuMention {
  key?: string;
  id?: string;
  name?: string;
}

export interface FeishuMediaRef {
  kind: "image" | "file";
  key: string;
  filename?: string;
  media_type?: string;
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

export function extractFeishuMedia(
  msgType: string,
  content: string | undefined,
): FeishuMediaRef[] {
  if (!content) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  if (msgType === "image") {
    return mediaKeyRefs(parsed, "image");
  }
  if (msgType === "file" || msgType === "audio" || msgType === "media") {
    return mediaKeyRefs(parsed, "file");
  }
  if (msgType === "post") {
    return uniqueMedia(collectPostMedia(parsed));
  }
  return [];
}

export function sniffMediaType(bytes: Uint8Array, fallback: string): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return "application/pdf";
  }
  return fallback.includes("/") ? fallback : "application/octet-stream";
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

export function isFeishuSelfSender(
  senderId: string | undefined,
  selfUserId: string | undefined,
): boolean {
  const sender = senderId?.trim() ?? "";
  const self = selfUserId?.trim() ?? "";
  return sender.length > 0 && self.length > 0 && sender === self;
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

function mediaKeyRefs(value: unknown, fallback: "image" | "file"): FeishuMediaRef[] {
  if (!isObject(value)) {
    return [];
  }
  const imageKey = objectString(value, "image_key") ?? objectString(value, "imageKey");
  const fileKey = objectString(value, "file_key") ?? objectString(value, "fileKey");
  const fileName =
    objectString(value, "file_name") ??
    objectString(value, "fileName") ??
    objectString(value, "name");
  const refs: FeishuMediaRef[] = [];
  if (fallback === "image" && imageKey) {
    return [
      {
        kind: "image",
        key: imageKey,
        filename: fileName ?? "image.png",
        media_type: "image/png",
      },
    ];
  }
  if (fileKey) {
    const filename = fileName ?? "attachment";
    refs.push({
      kind: "file",
      key: fileKey,
      filename,
      media_type: mediaTypeFromFilename(filename),
    });
  }
  if (imageKey) {
    refs.push({
      kind: "image",
      key: imageKey,
      filename: fileName && !fileKey ? fileName : "cover.png",
      media_type: "image/png",
    });
  }
  return refs;
}

function collectPostMedia(value: unknown): FeishuMediaRef[] {
  const refs: FeishuMediaRef[] = [];
  walkPostMedia(value, refs);
  return refs;
}

function walkPostMedia(value: unknown, refs: FeishuMediaRef[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      walkPostMedia(item, refs);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  for (const locale of ["zh_cn", "en_us", "ja_jp"]) {
    if (isObject(value[locale])) {
      walkPostMedia(value[locale], refs);
    }
  }
  if (value.tag === "img") {
    const key =
      objectString(value, "image_key") ??
      objectString(value, "imageKey") ??
      objectString(value, "file_key");
    if (key) {
      refs.push({
        kind: "image",
        key,
        filename: objectString(value, "file_name") ?? "image.png",
        media_type: "image/png",
      });
    }
  }
  if (Array.isArray(value.content)) {
    walkPostMedia(value.content, refs);
  }
}

function uniqueMedia(refs: FeishuMediaRef[]): FeishuMediaRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const id = `${ref.kind}:${ref.key}`;
    if (seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  });
}

function mediaTypeFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  if (ext === "png") {
    return "image/png";
  }
  if (ext === "jpg" || ext === "jpeg") {
    return "image/jpeg";
  }
  if (ext === "gif") {
    return "image/gif";
  }
  if (ext === "webp") {
    return "image/webp";
  }
  if (ext === "pdf") {
    return "application/pdf";
  }
  if (ext === "mp4") {
    return "video/mp4";
  }
  if (ext === "ogg" || ext === "opus") {
    return "audio/ogg";
  }
  return "application/octet-stream";
}

function objectString(
  value: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
