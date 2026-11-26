import type { InboxAttachment } from "./types";
import { pairedCoverIndexes } from "./video-message.ts";

export interface PreviewImage {
  id: string;
  src: string;
  alt: string;
  filename: string;
}

export const PREVIEW_ZOOM_MIN = 1;
export const PREVIEW_ZOOM_MAX = 5;
export const PREVIEW_ZOOM_STEP = 0.25;

export function previewImageId(eventId: string, index: number): string {
  return `${eventId}:${index}`;
}

const PREVIEWABLE_IMAGE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

export function imagePreviewSrc(file: InboxAttachment): string | undefined {
  if (!file.data_base64) return undefined;
  const declared = file.media_type === "image/jpg" ? "image/jpeg" : file.media_type;
  const media = PREVIEWABLE_IMAGE.has(declared) ? declared : imageMediaFromName(file.filename);
  if (!media) return undefined;
  return `data:${media};base64,${file.data_base64}`;
}

function imageMediaFromName(filename: string): string | undefined {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  if (ext === "avif") return "image/avif";
  return undefined;
}

export function collectPreviewImages(
  items: ReadonlyArray<{ event: { id: string }; attachments?: InboxAttachment[] }>,
): PreviewImage[] {
  const images: PreviewImage[] = [];
  for (const item of items) {
    const covers = pairedCoverIndexes(item.attachments ?? []);
    for (const [index, file] of (item.attachments ?? []).entries()) {
      if (covers.has(index)) continue;
      const src = imagePreviewSrc(file);
      if (!src) {
        continue;
      }
      images.push({
        id: previewImageId(item.event.id, index),
        src,
        alt: file.filename,
        filename: file.filename,
      });
    }
  }
  return images;
}

export function nextPreviewIndex(index: number, size: number, delta: number): number {
  if (size <= 0) {
    return 0;
  }
  return ((index + delta) % size + size) % size;
}

export function clampPreviewZoom(value: number): number {
  return Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, value));
}

export function nextPreviewZoom(current: number, deltaY: number): number {
  const direction = deltaY > 0 ? -1 : 1;
  return clampPreviewZoom(Number((current + direction * PREVIEW_ZOOM_STEP).toFixed(2)));
}
