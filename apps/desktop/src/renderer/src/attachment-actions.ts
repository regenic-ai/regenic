import type { InboxAttachment } from "./types";

export function openAttachmentFile(eventId: string, file: InboxAttachment): Promise<void> {
  if (file.part_index === undefined || !window.regenic?.openAttachment) {
    return Promise.reject(new Error("attachment.openFailed"));
  }
  return window.regenic.openAttachment({
    eventId,
    partIndex: file.part_index,
    filename: file.filename,
  });
}

export function attachmentReady(file: InboxAttachment): boolean {
  return Boolean(file.content_hash || file.data_base64 || (file.byte_size !== undefined && file.byte_size > 0));
}

/** Bytes the chat can play itself. Larger files stay a card the OS opens. */
export const INLINE_MEDIA_BYTES = 8 * 1024 * 1024;

const VIDEO = new Set(["video/mp4", "video/webm"]);
const AUDIO = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/wav",
  "audio/wave",
  "audio/ogg",
  "audio/aac",
  "audio/webm",
]);

const VIDEO_EXT: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
};
const AUDIO_EXT: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  aac: "audio/aac",
};

export function inlineMediaKind(file: InboxAttachment): "video" | "audio" | undefined {
  if (!attachmentReady(file) || file.part_index === undefined) return undefined;
  if (file.byte_size === undefined || file.byte_size > INLINE_MEDIA_BYTES) return undefined;
  const type = playableType(file);
  if (!type) return undefined;
  if (VIDEO.has(type)) return "video";
  if (AUDIO.has(type)) return "audio";
  return undefined;
}

/** The bytes the player received can actually be played. A sniffed type replaces a bare octet-stream. */
export function inlineBytesPlay(kind: "video" | "audio", mediaType: string): boolean {
  const type = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  return kind === "video" ? VIDEO.has(type) : AUDIO.has(type);
}

export async function readAttachmentObjectUrl(
  eventId: string,
  file: InboxAttachment,
): Promise<{ url: string; mediaType: string }> {
  if (file.part_index === undefined || !window.regenic?.readAttachment) {
    throw new Error("attachment.openFailed");
  }
  const result = await window.regenic.readAttachment({
    eventId,
    partIndex: file.part_index,
    filename: file.filename,
  });
  const binary = atob(result.dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const mediaType = result.mediaType || file.media_type;
  return {
    url: URL.createObjectURL(new Blob([bytes], { type: mediaType })),
    mediaType,
  };
}

function playableType(file: InboxAttachment): string | undefined {
  const declared = file.media_type.toLowerCase();
  if (VIDEO.has(declared) || AUDIO.has(declared)) return declared;
  if (declared !== "application/octet-stream" && declared !== "") return undefined;
  const base = file.filename.split(/[/\\]/u).pop() ?? file.filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return VIDEO_EXT[ext] ?? AUDIO_EXT[ext];
}
