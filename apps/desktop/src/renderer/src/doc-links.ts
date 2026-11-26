const DOC_URL =
  /https?:\/\/(?:(?:[\w.-]+\.)?(?:feishu\.cn|larksuite\.com|larkoffice\.com)\/(?:docx|docs|wiki|sheets|base|file)\/[^\s)]+|docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/[^\s)]+)/gi;

export interface CloudDocLink {
  title: string;
  url: string;
}

/** Titles and addresses already stored in message text. Nothing is fetched. */
export function cloudDocLinks(text: string): CloudDocLink[] {
  const found: CloudDocLink[] = [];
  const seen = new Set<string>();
  const pattern = new RegExp(DOC_URL.source, "gi");
  let match = pattern.exec(text);
  while (match) {
    const url = match[0].replace(/[.,;:!?]+$/u, "");
    if (!seen.has(url)) {
      seen.add(url);
      const before = text.slice(Math.max(0, match.index - 80), match.index);
      const titled = before.match(/(\S{1,80})\s*\(\s*$/u);
      const title = titled?.[1]?.trim() || urlTitle(url);
      found.push({ title, url });
    }
    match = pattern.exec(text);
  }
  return found;
}

function urlTitle(url: string): string {
  try {
    const path = new URL(url).pathname.split("/").filter(Boolean);
    const documentId = path.indexOf("d");
    const segment = documentId >= 0 && path[documentId + 1]
      ? path[documentId + 1]
      : [...path].reverse().find((part) => part !== "edit" && part !== "view");
    return decodeURIComponent(segment || url);
  } catch {
    return url;
  }
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
