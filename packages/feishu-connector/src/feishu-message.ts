export const FEISHU_SOURCE = "feishu";

export function extractFeishuText(
  msgType: string,
  content: string | undefined,
): string | undefined {
  if (!content) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return msgType === "text" ? content.trim() || undefined : undefined;
  }
  if (msgType === "text") {
    return isObject(parsed) && typeof parsed.text === "string"
      ? parsed.text.trim() || undefined
      : undefined;
  }
  if (msgType === "post") {
    const text = extractPostText(parsed);
    return text || undefined;
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

function extractPostText(value: unknown): string {
  if (!isObject(value)) {
    return "";
  }
  const locales = ["zh_cn", "en_us", "ja_jp"];
  for (const locale of locales) {
    const localized = value[locale];
    if (isObject(localized)) {
      return extractPostText(localized);
    }
  }
  const chunks: string[] = [];
  if (typeof value.title === "string" && value.title.trim()) {
    chunks.push(value.title.trim());
  }
  if (Array.isArray(value.content)) {
    const body = walkPostNodes(value.content);
    if (body) {
      chunks.push(body);
    }
  }
  return chunks.join("\n").trim();
}

function walkPostNodes(value: unknown): string {
  if (Array.isArray(value)) {
    const isBlock = value.length > 0 && value.every((item) => Array.isArray(item));
    return value
      .map((item) => walkPostNodes(item))
      .filter((item) => item.length > 0)
      .join(isBlock ? "\n" : "");
  }
  if (!isObject(value)) {
    return "";
  }
  const tag = value.tag;
  if (tag === "text" || tag === "a" || tag === "at") {
    return typeof value.text === "string" ? value.text : "";
  }
  if (Array.isArray(value.content)) {
    return walkPostNodes(value.content);
  }
  return "";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
