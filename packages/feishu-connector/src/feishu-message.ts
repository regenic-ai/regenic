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
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = Buffer.from(bytes.subarray(8, 12)).toString("ascii");
    if (brand === "avif" || brand === "avis") return "image/avif";
    if (brand === "heic" || brand === "heix" || brand === "hevc") return "image/heic";
    if (brand === "heif" || brand === "mif1") return "image/heif";
    const compact = brand.replace(/\s+/g, "");
    if (compact === "qt") return "video/quicktime";
    if (compact === "M4A" || compact === "M4B" || compact === "M4P") return "audio/mp4";
    if (
      compact === "isom" || compact === "iso2" || compact === "iso5" || compact === "iso6"
      || compact === "mp41" || compact === "mp42" || compact === "avc1" || compact === "dash"
      || compact === "MSNV" || compact === "M4V" || compact === "M4VH" || compact === "F4V"
    ) {
      return "video/mp4";
    }
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    const kind = Buffer.from(bytes.subarray(8, 12)).toString("ascii");
    if (kind === "WAVE") return "audio/wav";
    if (kind === "AVI ") return "video/x-msvideo";
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const sample = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 64))).toString("latin1");
    return sample.includes("webm") ? "video/webm" : "video/x-matroska";
  }
  if (bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return "audio/ogg";
  }
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return "audio/mpeg";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] === 0xf1 || bytes[1] === 0xf9)) {
    return "audio/aac";
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return "audio/mpeg";
  }
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    const sample = Buffer.from(bytes).toString("latin1");
    if (sample.includes("word/document.xml")) {
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    }
    if (sample.includes("xl/workbook.xml")) {
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    }
    if (sample.includes("ppt/presentation.xml")) {
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    }
    return fallback === "application/octet-stream" || !fallback.includes("/")
      ? "application/zip"
      : fallback;
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0xd0 &&
    bytes[1] === 0xcf &&
    bytes[2] === 0x11 &&
    bytes[3] === 0xe0
  ) {
    const sample = Buffer.from(bytes).toString("latin1");
    if (sample.includes("WordDocument") || includesUtf16(sample, "WordDocument")) {
      return "application/msword";
    }
    if (sample.includes("Workbook") || includesUtf16(sample, "Workbook")) {
      return "application/vnd.ms-excel";
    }
    if (sample.includes("PowerPoint") || includesUtf16(sample, "PowerPoint")) {
      return "application/vnd.ms-powerpoint";
    }
  }
  return fallback.includes("/") ? fallback : "application/octet-stream";
}

const MEDIA_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "video/x-msvideo": ".avi",
  "audio/mpeg": ".mp3",
  "audio/mp4": ".m4a",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/aac": ".aac",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/zip": ".zip",
};

/** Keep a real suffix. Add one when the stored name cannot tell the OS what to open. */
export function filenameForMedia(filename: string, mediaType: string): string {
  const ext = MEDIA_EXTENSION[mediaType === "image/jpg" ? "image/jpeg" : mediaType];
  if (!ext) return filename;
  if (!hasFilenameSuffix(filename)) return `${filename}${ext}`;
  if (!/\.(png|jpe?g|gif|webp|avif|hei[cf])$/iu.test(filename)) {
    return filename;
  }
  const current = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (current === ext || (ext === ".jpg" && current === ".jpeg")) return filename;
  return `${filename.slice(0, filename.lastIndexOf("."))}${ext}`;
}

function hasFilenameSuffix(filename: string): boolean {
  const base = filename.split(/[/\\]/u).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  return dot > 0 && /^[A-Za-z0-9]{1,8}$/u.test(base.slice(dot + 1));
}

function includesUtf16(sample: string, text: string): boolean {
  let encoded = "";
  for (const char of text) encoded += `${char}\u0000`;
  return sample.includes(encoded);
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
): "group" | "direct" | undefined {
  if (chatMode === "p2p") {
    return "direct";
  }
  if (chatMode === "group") {
    return "group";
  }
  return undefined;
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

export function feishuCreateTimeMs(createTime: string | undefined): number | undefined {
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
  if (tag === "text") {
    const text = typeof value.text === "string" ? value.text : "";
    return projectFeishuStyles(text, value.style);
  }
  if (tag === "a") {
    const text = typeof value.text === "string" ? value.text : "";
    const href = typeof value.href === "string" ? value.href.trim() : "";
    const styled = projectFeishuStyles(text, value.style);
    if (href && href !== text.trim()) {
      return styled ? `${styled} (${href})` : href;
    }
    return styled || href;
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

export type FeishuTextStyle = "bold" | "italic" | "underline" | "lineThrough";

export type FeishuPostNode =
  | { tag: "text"; text: string; style?: FeishuTextStyle[] }
  | { tag: "at"; user_id: string; user_name?: string };

export type FeishuOutgoingBody =
  | { msg_type: "text"; content: { text: string } }
  | { msg_type: "post"; content: { zh_cn: { content: FeishuPostNode[][] } } };

const FEISHU_AT_TAG =
  /<at\s+user_id\s*=\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”|＂([^＂]*)＂)\s*>([\s\S]*?)<\/at>/gi;

/**
 * Feishu only notifies an @ when the wire is a text `<at>` tag or a post `at`
 * node. A plain `@name` is ordinary text. Mentions become post nodes here so
 * the kernel still sends one body string.
 */
export function feishuOutgoingBody(text: string): FeishuOutgoingBody {
  const nodes = splitFeishuMentions(text).flatMap((node) =>
    node.tag === "text" ? styleFeishuText(node.text) : [node],
  );
  if (!nodes.some((node) => node.tag === "at" || node.style?.length)) {
    return { msg_type: "text", content: { text } };
  }
  return {
    msg_type: "post",
    content: { zh_cn: { content: feishuPostParagraphs(nodes) } },
  };
}

const PLAIN_MENTION = /(^|[^\w@])@([^\s@<]+)/;
const TRAILING_MENTION_PUNCT = /[，。,.!！?？:：;；、)）\]]+$/u;
const MENTION_BOUNDARY = /[\s，。,.!！?？:：;；、)）\]]/u;

/**
 * Turns a copied `@名字` into `<at>` when that name belongs to exactly one
 * chat member. The longest member name wins, so `@John Smith` does not mention
 * a different person named John. Only `@所有人` and the Feishu placeholder
 * `@_all` mention everyone. Unmatched text, emails, and existing `<at>` tags
 * stay as they are.
 */
export function applyFeishuPlainMentions(
  text: string,
  names: ReadonlyMap<string, string>,
): string {
  const ordered = [...names.keys()].filter((name) => name.length > 0)
    .sort((left, right) => right.length - left.length);
  return rewriteOutsideAtTags(text, (part) => replacePlainMentions(part, ordered, names));
}

function replacePlainMentions(
  part: string,
  ordered: readonly string[],
  names: ReadonlyMap<string, string>,
): string {
  let out = "";
  for (let index = 0; index < part.length; index += 1) {
    if (part[index] !== "@") {
      out += part[index];
      continue;
    }
    const prefix = index === 0 ? "" : part[index - 1];
    if (prefix && isMentionPrefixBlocked(prefix)) {
      out += "@";
      continue;
    }
    const rest = part.slice(index + 1);
    const everyone = everyoneTokenLength(rest);
    if (everyone) {
      out += `<at user_id="all">所有人</at>`;
      index += everyone;
      continue;
    }
    const name = ordered.find((candidate) =>
      rest.startsWith(candidate) && isMentionBoundary(rest[candidate.length]),
    );
    const userId = name ? names.get(name) : undefined;
    if (!name || !userId) {
      out += "@";
      continue;
    }
    out += `<at user_id="${userId}">${name}</at>`;
    index += name.length;
  }
  return out;
}

/** Names still written as `@名字`, excluding `@所有人` and text already inside `<at>`. */
export function feishuPlainMentionNames(text: string): string[] {
  const found = new Set<string>();
  rewriteOutsideAtTags(text, (part) => {
    const pattern = new RegExp(PLAIN_MENTION.source, "g");
    let match = pattern.exec(part);
    while (match) {
      const prefix = match[1] ?? "";
      const raw = match[2] ?? "";
      if (prefix !== "." && prefix !== "．" && prefix !== "-" && prefix !== "_") {
        const token = raw.replace(TRAILING_MENTION_PUNCT, "");
        if (
          token &&
          !token.includes(".") &&
          !token.includes("/") &&
          !token.includes(":") &&
          !everyoneMentionId(token)
        ) {
          found.add(token);
        }
      }
      match = pattern.exec(part);
    }
    return part;
  });
  return [...found];
}

/** Drops blank ids and names shared by more than one member. */
export function feishuMentionNameIndex(
  members: readonly { id?: string; name?: string }[],
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const member of members) {
    const name = member.name?.trim() ?? "";
    const id = mentionUserId(member.id);
    if (!name || !id || id === "all") {
      continue;
    }
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const index = new Map<string, string>();
  for (const member of members) {
    const name = member.name?.trim() ?? "";
    const id = mentionUserId(member.id);
    if (name && id && id !== "all" && counts.get(name) === 1) {
      index.set(name, id);
    }
  }
  return index;
}

function rewriteOutsideAtTags(
  text: string,
  rewrite: (part: string) => string,
): string {
  const pattern = new RegExp(FEISHU_AT_TAG.source, "gi");
  let out = "";
  let last = 0;
  let match = pattern.exec(text);
  while (match) {
    out += rewrite(text.slice(last, match.index));
    out += match[0];
    last = match.index + match[0].length;
    match = pattern.exec(text);
  }
  return out + rewrite(text.slice(last));
}

function everyoneMentionId(name: string): string | undefined {
  if (name === "所有人" || name.toLowerCase() === "_all") {
    return "all";
  }
  return undefined;
}

function everyoneTokenLength(rest: string): number | undefined {
  if (rest.startsWith("所有人") && isMentionBoundary(rest["所有人".length])) {
    return "所有人".length;
  }
  if (rest.slice(0, 4).toLowerCase() === "_all" && isMentionBoundary(rest[4])) {
    return 4;
  }
  return undefined;
}

function isMentionPrefixBlocked(prefix: string): boolean {
  return prefix === "." || prefix === "．" || prefix === "-" || prefix === "_" || /[\w@]/.test(prefix);
}

function isMentionBoundary(char: string | undefined): boolean {
  return char === undefined || MENTION_BOUNDARY.test(char);
}

/** Official text-message @ syntax, used when the client cannot send post. */
export function feishuMentionText(text: string): string {
  const nodes = splitFeishuMentions(text);
  if (!nodes.some((node) => node.tag === "at")) {
    return text;
  }
  return nodes
    .map((node) => {
      if (node.tag === "text") {
        return node.text;
      }
      return `<at user_id="${node.user_id}">${node.user_name ?? ""}</at>`;
    })
    .join("");
}

function splitFeishuMentions(text: string): FeishuPostNode[] {
  const nodes: FeishuPostNode[] = [];
  const pattern = new RegExp(FEISHU_AT_TAG.source, "gi");
  let last = 0;
  let match = pattern.exec(text);
  while (match) {
    if (match.index > last) {
      pushFeishuText(nodes, text.slice(last, match.index));
    }
    const userId = mentionUserId(match[1] ?? match[2] ?? match[3] ?? match[4]);
    if (!userId) {
      pushFeishuText(nodes, match[0]);
    } else {
      const userName = mentionUserName(match[5] ?? "", userId);
      nodes.push({
        tag: "at",
        user_id: userId,
        ...(userName ? { user_name: userName } : {}),
      });
    }
    last = match.index + match[0].length;
    match = pattern.exec(text);
  }
  if (last < text.length) {
    pushFeishuText(nodes, text.slice(last));
  }
  return nodes;
}

function feishuPostParagraphs(nodes: readonly FeishuPostNode[]): FeishuPostNode[][] {
  const lines: FeishuPostNode[][] = [[]];
  for (const node of nodes) {
    if (node.tag === "at") {
      lines[lines.length - 1].push(node);
      continue;
    }
    const parts = node.text.split("\n");
    parts.forEach((part, index) => {
      if (index > 0) {
        lines.push([]);
      }
      if (part) {
        lines[lines.length - 1].push({
          tag: "text",
          text: part,
          ...(node.style?.length ? { style: node.style } : {}),
        });
      }
    });
  }
  const paragraphs = lines.filter((line) => line.length > 0);
  return paragraphs.length > 0 ? paragraphs : [[{ tag: "text", text: "" }]];
}

function projectFeishuStyles(text: string, style: unknown): string {
  if (!text || !Array.isArray(style)) {
    return text;
  }
  let out = text;
  if (style.includes("lineThrough")) out = `~~${out}~~`;
  if (style.includes("italic")) out = `*${out}*`;
  if (style.includes("bold")) out = `**${out}**`;
  if (style.includes("underline")) out = `<u>${out}</u>`;
  return out;
}

function styleFeishuText(text: string): FeishuPostNode[] {
  return parseStyledRuns(text, []).map((run) => ({
    tag: "text",
    text: run.text,
    ...(run.style.length > 0 ? { style: run.style } : {}),
  }));
}

function parseStyledRuns(
  text: string,
  style: FeishuTextStyle[],
): Array<{ text: string; style: FeishuTextStyle[] }> {
  const runs: Array<{ text: string; style: FeishuTextStyle[] }> = [];
  let index = 0;
  while (index < text.length) {
    const mark = nextFeishuMark(text, index);
    if (!mark) {
      pushStyledRun(runs, text.slice(index), style);
      break;
    }
    if (mark.index > index) {
      pushStyledRun(runs, text.slice(index, mark.index), style);
    }
    if (mark.style === "code") {
      pushStyledRun(runs, text.slice(mark.contentStart, mark.contentEnd), []);
    } else {
      const added = mark.style === "boldItalic"
        ? ["bold", "italic"] as const
        : [mark.style];
      runs.push(...parseStyledRuns(
        text.slice(mark.contentStart, mark.contentEnd),
        [...style, ...added],
      ));
    }
    index = mark.end;
  }
  return runs;
}

function nextFeishuMark(
  text: string,
  from: number,
): { index: number; contentStart: number; contentEnd: number; end: number; style: FeishuTextStyle | "boldItalic" | "code" } | undefined {
  const found = [
    findWrappedMark(text, from, "***", "***", "boldItalic"),
    findWrappedMark(text, from, "~~", "~~", "lineThrough"),
    findWrappedMark(text, from, "**", "**", "bold"),
    findItalicMark(text, from),
    findWrappedMark(text, from, "<u>", "</u>", "underline"),
    findWrappedMark(text, from, "`", "`", "code"),
  ].filter((mark) => mark !== undefined);
  return found.sort((left, right) => left.index - right.index)[0];
}

function findWrappedMark(
  text: string,
  from: number,
  open: string,
  close: string,
  style: FeishuTextStyle | "boldItalic" | "code",
): { index: number; contentStart: number; contentEnd: number; end: number; style: FeishuTextStyle | "boldItalic" | "code" } | undefined {
  let search = from;
  while (search < text.length) {
    const opener = text.indexOf(open, search);
    if (opener < 0) {
      return undefined;
    }
    const contentStart = opener + open.length;
    const closer = text.indexOf(close, contentStart);
    if (closer > contentStart) {
      return {
        index: opener,
        contentStart,
        contentEnd: closer,
        end: closer + close.length,
        style,
      };
    }
    search = opener + open.length;
  }
  return undefined;
}

function findItalicMark(
  text: string,
  from: number,
): { index: number; contentStart: number; contentEnd: number; end: number; style: "italic" } | undefined {
  for (let opener = from; opener < text.length; opener += 1) {
    if (text[opener] !== "*" || text[opener + 1] === "*") {
      if (text[opener] === "*" && text[opener + 1] === "*") opener += 1;
      continue;
    }
    for (let closer = opener + 1; closer < text.length; closer += 1) {
      if (text[closer] !== "*" || text[closer + 1] === "*") {
        if (text[closer] === "*" && text[closer + 1] === "*") closer += 1;
        continue;
      }
      if (closer === opener + 1) {
        break;
      }
      return {
        index: opener,
        contentStart: opener + 1,
        contentEnd: closer,
        end: closer + 1,
        style: "italic",
      };
    }
  }
  return undefined;
}

function pushStyledRun(
  runs: Array<{ text: string; style: FeishuTextStyle[] }>,
  text: string,
  style: FeishuTextStyle[],
): void {
  if (!text) {
    return;
  }
  const last = runs[runs.length - 1];
  if (last && sameFeishuStyle(last.style, style)) {
    last.text += text;
    return;
  }
  runs.push({ text, style: [...style] });
}

function sameFeishuStyle(left: readonly FeishuTextStyle[], right: readonly FeishuTextStyle[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function pushFeishuText(nodes: FeishuPostNode[], text: string): void {
  if (!text) {
    return;
  }
  const last = nodes[nodes.length - 1];
  if (last?.tag === "text") {
    last.text += text;
    return;
  }
  nodes.push({ tag: "text", text });
}

function mentionUserId(raw: string | undefined): string | undefined {
  const value = raw?.trim() ?? "";
  if (!value) {
    return undefined;
  }
  if (isEveryoneId(value)) {
    return "all";
  }
  return /^[A-Za-z0-9:_-]{1,128}$/.test(value) ? value : undefined;
}

function mentionUserName(label: string, userId: string): string | undefined {
  if (userId === "all") {
    return cleanMentionName(label) ?? "所有人";
  }
  return cleanMentionName(label);
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
  if (ext === "doc") return "application/msword";
  if (ext === "docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (ext === "xls") return "application/vnd.ms-excel";
  if (ext === "xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  if (ext === "ppt") return "application/vnd.ms-powerpoint";
  if (ext === "pptx") {
    return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
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
