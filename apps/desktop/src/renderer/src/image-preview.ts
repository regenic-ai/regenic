import type { InboxAttachment } from "./types";

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

export function imagePreviewSrc(file: InboxAttachment): string | undefined {
  if (!file.data_base64 || !file.media_type.startsWith("image/")) {
    return undefined;
  }
  return `data:${file.media_type};base64,${file.data_base64}`;
}

export function collectPreviewImages(
  items: ReadonlyArray<{ event: { id: string }; attachments?: InboxAttachment[] }>,
): PreviewImage[] {
  const images: PreviewImage[] = [];
  for (const item of items) {
    for (const [index, file] of (item.attachments ?? []).entries()) {
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
