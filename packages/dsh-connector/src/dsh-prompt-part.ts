import type { ContentPart } from "@regenic/domain";

export const DSH_IMAGE_MEDIA = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export const DSH_INLINE_FILE_MEDIA = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

const MAX_INLINE_CHARS = 48_000;

export type DshImageMediaType = (typeof DSH_IMAGE_MEDIA)[number];

export type DshPromptPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      mimeType: DshImageMediaType;
      mediaType: DshImageMediaType;
      data: string;
      name?: string;
    };

export function dshImageMediaType(mediaType: string): DshImageMediaType | null {
  const normalized =
    mediaType.trim().toLowerCase() === "image/jpg"
      ? "image/jpeg"
      : mediaType.trim().toLowerCase();
  return DSH_IMAGE_MEDIA.find((item) => item === normalized) ?? null;
}

export function canonicalBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function promptFromContentParts(content: ContentPart[]): {
  text: string;
  content?: DshPromptPart[];
} {
  const texts: string[] = [];
  const images: DshPromptPart[] = [];
  const fileNotes: string[] = [];
  for (const entry of content) {
    if (entry.role === "body" && isTextMedia(entry.media_type) && typeof entry.text === "string") {
      const text = entry.text.trim();
      if (text) {
        texts.push(entry.text);
      }
      continue;
    }
    if (entry.role !== "attachment") {
      continue;
    }
    const image = imagePart(entry);
    if (image) {
      images.push(image);
      continue;
    }
    fileNotes.push(fileNote(entry));
  }
  const text =
    [...texts, ...fileNotes].join("\n\n").trim() ||
    images
      .map((part) => `[Attached: ${part.type === "image" ? (part.name ?? "image") : part.text}]`)
      .join("\n\n")
      .trim();
  if (text.length === 0) {
    throw new Error("Send intent must include a text body or attachment");
  }
  if (images.length === 0) {
    return { text };
  }
  return {
    text,
    content: [{ type: "text", text }, ...images],
  };
}

function imagePart(entry: ContentPart): DshPromptPart | null {
  const mediaType = dshImageMediaType(entry.media_type);
  if (!mediaType || entry.bytes === undefined || entry.bytes.byteLength === 0) {
    return null;
  }
  const name = displayName(entry.source_filename, "image");
  return {
    type: "image",
    mimeType: mediaType,
    mediaType,
    data: canonicalBase64(entry.bytes),
    name,
  };
}

function fileNote(entry: ContentPart): string {
  const name = displayName(entry.source_filename, "attachment");
  if (entry.bytes && DSH_INLINE_FILE_MEDIA.has(entry.media_type)) {
    const decoded = decodeUtf8(entry.bytes);
    if (decoded !== null) {
      const truncated =
        decoded.length > MAX_INLINE_CHARS
          ? `${decoded.slice(0, MAX_INLINE_CHARS)}\n\n[Truncated ${name}]`
          : decoded;
      return `Attached: ${name} (${entry.media_type})\n\n${wrapFence(fenceLang(entry.media_type, name), truncated)}`;
    }
  }
  return `[Attached: ${name}]`;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) {
    return null;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function fenceLang(mediaType: string, name: string): string {
  if (mediaType === "application/json") {
    return "json";
  }
  if (mediaType === "text/markdown") {
    return "markdown";
  }
  if (mediaType === "text/csv") {
    return "csv";
  }
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  return ext && ext !== name ? ext : "";
}

function wrapFence(lang: string, body: string): string {
  let ticks = "```";
  while (body.includes(ticks)) {
    ticks += "`";
  }
  return `${ticks}${lang}\n${body}\n${ticks}`;
}

function displayName(filename: string | undefined, fallback: string): string {
  const base = (filename ?? "")
    .replace(/[/\\]/g, "")
    .replace(/^\.+/g, "")
    .trim()
    .slice(0, 120);
  return base.length > 0 ? base : fallback;
}

function isTextMedia(mediaType: string): boolean {
  return mediaType === "text/plain" || mediaType === "text/markdown";
}
