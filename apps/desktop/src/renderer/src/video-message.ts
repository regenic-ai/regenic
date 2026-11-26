import type { InboxAttachment } from "./types";

const COVER_NAME = /^cover\.(jpe?g|png|webp)$/iu;
const VIDEO_EXT = /^(?:mp4|webm|mov|mkv|avi|m4v)$/iu;
/** Feishu and WhatsApp hand videos names like 8537….mp4 or VID-20260921-WA0005.mp4. */
const OPAQUE_STEM = /^(?:\d{6,}|vid-\d{8}-wa\d+|attachment|video)$/iu;

export interface ChatVideo {
  file: InboxAttachment;
  index: number;
  poster?: InboxAttachment;
  posterIndex?: number;
}

export type AttachmentSlot =
  | { kind: "file"; file: InboxAttachment; index: number }
  | { kind: "video"; video: ChatVideo };

export function isVideoCover(file: InboxAttachment): boolean {
  const base = basename(file.filename);
  if (!COVER_NAME.test(base)) return false;
  return file.media_type.startsWith("image/") || /\.(?:jpe?g|png|webp|gif)$/iu.test(base);
}

export function isChatVideo(file: InboxAttachment): boolean {
  if (file.media_type.startsWith("video/")) return true;
  const type = file.media_type || "application/octet-stream";
  if (type !== "application/octet-stream") return false;
  return VIDEO_EXT.test(extension(file.filename));
}

/**
 * A chat video and the cover image sent with it are one picture.
 * The cover is the next or previous part, and its name is cover.jpg / cover.webp.
 */
export function layoutAttachments(files: readonly InboxAttachment[]): AttachmentSlot[] {
  const used = new Set<number>();
  const slots: AttachmentSlot[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    if (used.has(index)) continue;
    if (isVideoCover(file) && files[index + 1] && isChatVideo(files[index + 1]!)) {
      continue;
    }
    if (isChatVideo(file)) {
      const next = files[index + 1];
      const previous = index > 0 ? files[index - 1] : undefined;
      let poster: InboxAttachment | undefined;
      let posterIndex: number | undefined;
      if (next && isVideoCover(next) && !used.has(index + 1)) {
        poster = next;
        posterIndex = index + 1;
      } else if (previous && isVideoCover(previous) && !used.has(index - 1)) {
        poster = previous;
        posterIndex = index - 1;
      }
      if (posterIndex !== undefined) used.add(posterIndex);
      slots.push({ kind: "video", video: { file, index, poster, posterIndex } });
      continue;
    }
    slots.push({ kind: "file", file, index });
  }
  return slots;
}

export function pairedCoverIndexes(files: readonly InboxAttachment[]): Set<number> {
  const indexes = new Set<number>();
  for (const slot of layoutAttachments(files)) {
    if (slot.kind === "video" && slot.video.posterIndex !== undefined) {
      indexes.add(slot.video.posterIndex);
    }
  }
  return indexes;
}

export function videoDisplayName(filename: string, fallback: string): string {
  const base = basename(filename);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return OPAQUE_STEM.test(stem) ? fallback : base;
}

function basename(filename: string): string {
  return filename.split(/[/\\]/u).pop() ?? filename;
}

function extension(filename: string): string {
  const base = basename(filename);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1);
}
