import { plainMessageText } from "./copy-message.ts";

const DOC_URL =
  /https?:\/\/(?:(?:[\w.-]+\.)?(?:feishu\.cn|larksuite\.com|larkoffice\.com)\/(?:docx|docs|wiki|sheets|base|slides|file)\/[^\s)<]+|docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/[^\s)<]+|drive\.google\.com\/file\/d\/[^\s)<]+)/gi;

export type CloudDocKind = "DOC" | "XLS" | "PPT" | "BASE" | "WIKI" | "FILE";
export type CloudDocHost = "feishu" | "google";

export interface CloudDocLink {
  title: string;
  url: string;
  kind: CloudDocKind;
  host: CloudDocHost;
}

/** Titles and addresses already stored in message text. Nothing is fetched. */
export function cloudDocLinks(text: string): CloudDocLink[] {
  const readable = plainMessageText(text);
  const found: CloudDocLink[] = [];
  const seen = new Set<string>();
  const pattern = new RegExp(DOC_URL.source, "gi");
  let match = pattern.exec(readable);
  while (match) {
    const url = match[0].replace(/[.,;:!?]+$/u, "");
    if (!seen.has(url)) {
      seen.add(url);
      const before = readable.slice(Math.max(0, match.index - 120), match.index);
      found.push({
        title: humanTitle(before),
        url,
        kind: cloudDocKind(url),
        host: cloudDocHost(url),
      });
    }
    match = pattern.exec(readable);
  }
  return found;
}

/** The card replaces the address, the way a chat doc unfurl replaces the bare link. */
export function textWithoutCloudDocs(text: string): string {
  let next = plainMessageText(text);
  for (const link of cloudDocLinks(next)) {
    const escaped = link.url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const markdown = new RegExp(`\\[[^\\]\\n]{0,120}\\]\\(\\s*${escaped}\\s*\\)`, "gu");
    const titled = new RegExp(`\\S{1,80}\\s*\\(\\s*${escaped}\\s*\\)`, "gu");
    next = next.replace(markdown, "").replace(titled, "").replaceAll(link.url, "");
  }
  return next
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cloudDocKind(url: string): CloudDocKind {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname;
    if (parsed.searchParams.has("sheet") || /\/(?:sheets|spreadsheets)(?:\/|$)/u.test(path)) return "XLS";
    if (parsed.searchParams.has("table")) return "BASE";
    if (/\/(?:presentation|slides)(?:\/|$)/u.test(path)) return "PPT";
    if (/\/base(?:\/|$)/u.test(path)) return "BASE";
    if (parsed.hostname === "drive.google.com" || /\/file(?:\/|$)/u.test(path)) return "FILE";
    if (/\/wiki(?:\/|$)/u.test(path)) return "WIKI";
  } catch {
    return "DOC";
  }
  return "DOC";
}

export function cloudDocHost(url: string): CloudDocHost {
  try {
    const host = new URL(url).hostname;
    if (host === "docs.google.com" || host === "drive.google.com") return "google";
  } catch {
    return "feishu";
  }
  return "feishu";
}

function humanTitle(before: string): string {
  const markdown = before.match(/\[([^\]\n]{1,80})\]\(\s*$/u);
  const paren = before.match(/(\S{1,80})\s*\(\s*$/u);
  const raw = markdown?.[1] ?? paren?.[1] ?? "";
  const title = raw.replace(/^[\s[【(]+/u, "").replace(/[\s\])】.。:：,，]+$/u, "").trim();
  if (!title || isOpaqueId(title) || /https?:\/\//u.test(title)) return "";
  return title;
}

function isOpaqueId(value: string): boolean {
  return /^[A-Za-z0-9_-]{12,}$/u.test(value);
}

export function formatFileSize(size: number | undefined): string {
  if (size === undefined || !Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) {
    const kb = size / 1024;
    return `${kb >= 10 ? Math.round(kb) : kb.toFixed(1)} KB`;
  }
  const mb = size / (1024 * 1024);
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

export function fileTypeLabel(filename: string, mediaType: string): string {
  const ext = filename.includes(".")
    ? filename.slice(filename.lastIndexOf(".") + 1).trim()
    : "";
  if (ext && ext.length <= 5) return ext.toUpperCase();
  if (mediaType === "application/pdf") return "PDF";
  if (mediaType.includes("spreadsheet") || mediaType.includes("excel")) return "XLS";
  if (mediaType.includes("wordprocessing") || mediaType.includes("msword")) return "DOC";
  if (mediaType.includes("presentation") || mediaType.includes("powerpoint")) return "PPT";
  if (mediaType.startsWith("text/")) return "TXT";
  if (mediaType === "image/png") return "PNG";
  if (mediaType === "image/jpeg" || mediaType === "image/jpg") return "JPEG";
  if (mediaType === "image/gif") return "GIF";
  if (mediaType === "image/webp") return "WEBP";
  if (mediaType.startsWith("image/")) return "IMG";
  return "FILE";
}
