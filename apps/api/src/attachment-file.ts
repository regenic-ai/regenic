import { createHash } from "node:crypto";
import { HttpException, HttpStatus } from "@nestjs/common";
import {
  CONTENT_PARTS_MEDIA_TYPE,
  parseStoredContentParts,
  storedPartContentHash,
  type AuthorityStore,
  type BlobStore,
  type EventRecord,
} from "@regenic/domain";

/** Same ceiling as inbound attachment ingest. Larger files are refused before the bytes are read. */
export const ATTACHMENT_OPEN_MAX_BYTES = 8 * 1024 * 1024;

export interface OpenedAttachment {
  filename: string;
  media_type: string;
  bytes: Uint8Array;
  thread_id?: string;
}

export function base64DecodedSize(value: string): number {
  const trimmed = value.replace(/\s/g, "");
  if (!trimmed) return 0;
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((trimmed.length * 3) / 4) - padding);
}

export function agentContextFileUrl(
  mcpUrl: string,
  eventId: string,
  partIndex: number,
): string {
  const root = mcpUrl.replace(/\/mcp$/, "");
  return `${root}/files/${encodeURIComponent(eventId)}/${partIndex}`;
}

const PREVIEWABLE_IMAGE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

const EXTENSION_BY_MEDIA: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "application/pdf": ".pdf",
  "application/msword": ".doc",
  "application/vnd.ms-excel": ".xls",
  "application/vnd.ms-powerpoint": ".ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/zip": ".zip",
  "text/plain": ".txt",
};

/** A name the OS can hand to an app, plus the type those bytes actually are. */
export function describeStoredFile(
  filename: string,
  declared: string,
  bytes?: Uint8Array,
): { filename: string; media_type: string } {
  const mediaType = chooseMediaType(declared, bytes);
  return {
    filename: filenameWithExtension(filename, mediaType),
    media_type: mediaType,
  };
}

/** List rows load these bytes so an image can preview and a bare name can gain a suffix. */
export function attachmentNeedsPreviewBytes(filename: string, mediaType: string): boolean {
  if (mediaType.startsWith("image/") || isImageFilename(filename)) return true;
  return !hasFilenameExtension(filename);
}

export function hasFilenameExtension(filename: string): boolean {
  const base = filename.split(/[/\\]/u).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return /^[A-Za-z0-9]{1,8}$/u.test(base.slice(dot + 1));
}

function isImageFilename(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|hei[cf])$/iu.test(filename);
}

function chooseMediaType(declared: string, bytes?: Uint8Array): string {
  const fallback = normalizeMediaType(declared);
  if (!bytes) return fallback;
  const sniffed = sniffMagic(bytes);
  if (!sniffed) return fallback;
  if (
    fallback === "application/octet-stream"
    || sniffed.startsWith("image/")
    || fallback.startsWith("image/")
  ) {
    return sniffed;
  }
  return fallback;
}

/** Browser-decodable type confirmed by the file header. A declared image type is not enough. */
export function previewImageType(bytes: Uint8Array): string | undefined {
  const sniffed = sniffMagic(bytes);
  return sniffed && PREVIEWABLE_IMAGE.has(sniffed) ? sniffed : undefined;
}

function normalizeMediaType(declared: string): string {
  const value = declared.includes("/") ? declared : "application/octet-stream";
  return value === "image/jpg" ? "image/jpeg" : value;
}

function filenameWithExtension(filename: string, mediaType: string): string {
  const ext = EXTENSION_BY_MEDIA[mediaType];
  if (!ext) return filename;
  if (!hasFilenameExtension(filename)) return `${filename}${ext}`;
  if (!mediaType.startsWith("image/") || !isImageFilename(filename)) return filename;
  return filenameWithImageExtension(filename, ext);
}

function filenameWithImageExtension(filename: string, ext: string): string {
  const current = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (current === ext || (ext === ".jpg" && current === ".jpeg")) return filename;
  return `${filename.slice(0, filename.lastIndexOf("."))}${ext}`;
}

function sniffMagic(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 4
    && bytes[0] === 0x47
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x38
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes.length >= 4
    && bytes[0] === 0x25
    && bytes[1] === 0x50
    && bytes[2] === 0x44
    && bytes[3] === 0x46
  ) {
    return "application/pdf";
  }
  const isoBrand = isoBrandMedia(bytes);
  if (isoBrand) return isoBrand;
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
    return officePackageMedia(bytes);
  }
  if (
    bytes.length >= 8
    && bytes[0] === 0xd0
    && bytes[1] === 0xcf
    && bytes[2] === 0x11
    && bytes[3] === 0xe0
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
  return undefined;
}

function isoBrandMedia(bytes: Uint8Array): string | undefined {
  if (
    bytes.length < 12
    || bytes[4] !== 0x66
    || bytes[5] !== 0x74
    || bytes[6] !== 0x79
    || bytes[7] !== 0x70
  ) {
    return undefined;
  }
  const brand = Buffer.from(bytes.subarray(8, 12)).toString("ascii");
  if (brand === "avif" || brand === "avis") return "image/avif";
  if (brand === "heic" || brand === "heix" || brand === "hevc") return "image/heic";
  if (brand === "heif" || brand === "mif1") return "image/heif";
  return undefined;
}

function officePackageMedia(bytes: Uint8Array): string {
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
  return "application/zip";
}

function includesUtf16(sample: string, text: string): boolean {
  let encoded = "";
  for (const char of text) encoded += `${char}\u0000`;
  return sample.includes(encoded);
}

export function attachmentContentDisposition(filename: string): string {
  const safe = filename
    .replace(/[\r\n"]/g, "")
    .replace(/[/\\]/g, "")
    .trim();
  const bounded = keepFilenameSuffix(safe, 120) || "attachment";
  const ascii = bounded.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(bounded)}`;
}

function keepFilenameSuffix(filename: string, max: number): string {
  if (filename.length <= max) return filename;
  const dot = filename.lastIndexOf(".");
  const suffix = dot > 0 ? filename.slice(dot) : "";
  if (!/^\.[A-Za-z0-9]{1,8}$/u.test(suffix) || suffix.length >= max) {
    return filename.slice(0, max);
  }
  return `${filename.slice(0, max - suffix.length)}${suffix}`;
}

/**
 * Stream one stored attachment. Sidecar bytes are read only after metadata
 * shows the file is within the size cap. `beforeRead` runs at that point so
 * a caller can count the open or refuse it before the blob is loaded.
 */
export async function openEventAttachment(
  authority: AuthorityStore,
  blobs: BlobStore,
  orgId: string,
  eventId: string,
  partIndex: number,
  options?: {
    lockedThread?: string;
    beforeRead?: () => Promise<void>;
  },
): Promise<OpenedAttachment> {
  if (!eventId.trim() || !Number.isInteger(partIndex) || partIndex < 0) {
    throw fileError("invalid_request", HttpStatus.BAD_REQUEST, "Attachment address is invalid");
  }
  const event = await authority.getEvent(orgId, eventId);
  if (!event?.content_hash) {
    throw fileError("not_found", HttpStatus.NOT_FOUND, "Attachment was not found");
  }
  if (!attachmentThreadAllowed(event, options?.lockedThread)) {
    throw fileError(
      "forbidden",
      HttpStatus.FORBIDDEN,
      "This file is outside the conversation this run can open",
    );
  }
  const beforeRead = options?.beforeRead;
  const envelopeMeta = await authority.findBlob(event.content_hash);
  const envelope = await blobs.get(event.content_hash).catch(() => undefined);
  if (
    !envelopeMeta
    || !envelope
    || createHash("sha256").update(envelope).digest("hex") !== event.content_hash
  ) {
    throw fileError("not_found", HttpStatus.NOT_FOUND, "Attachment was not found");
  }
  if (envelopeMeta.media_type !== CONTENT_PARTS_MEDIA_TYPE) {
    throw fileError("not_found", HttpStatus.NOT_FOUND, "Attachment was not found");
  }
  const parts = parseStoredContentParts(envelope);
  const part = parts?.[partIndex];
  if (!part || part.role !== "attachment") {
    throw fileError("not_found", HttpStatus.NOT_FOUND, "Attachment was not found");
  }
  const filename = cleanFilename(part.source_filename);
  const hash = storedPartContentHash(part);
  if (hash) {
    const meta = await authority.findBlob(hash);
    if (!meta) {
      throw fileError("not_found", HttpStatus.NOT_FOUND, "Attachment was not found");
    }
    await beforeRead?.();
    assertOpenSize(meta.byte_size);
    const bytes = await blobs.get(hash).catch(() => undefined);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== hash) {
      throw fileError("not_found", HttpStatus.NOT_FOUND, "Attachment was not found");
    }
    assertOpenSize(bytes.byteLength);
    return openedFile(
      filename,
      meta.media_type || part.media_type || "application/octet-stream",
      bytes,
      event.thread_id,
    );
  }
  if (typeof part.bytes_base64 === "string") {
    await beforeRead?.();
    assertOpenSize(base64DecodedSize(part.bytes_base64));
    const bytes = Buffer.from(part.bytes_base64, "base64");
    assertOpenSize(bytes.byteLength);
    return openedFile(
      filename,
      part.media_type || "application/octet-stream",
      bytes,
      event.thread_id,
    );
  }
  throw fileError("not_found", HttpStatus.NOT_FOUND, "Attachment was not found");
}

export function attachmentThreadAllowed(
  event: Pick<EventRecord, "thread_id"> | undefined,
  lockedThread: string | undefined,
): boolean {
  if (!lockedThread) return true;
  return event?.thread_id === lockedThread;
}

function assertOpenSize(byteSize: number): void {
  if (byteSize > ATTACHMENT_OPEN_MAX_BYTES) {
    throw fileError(
      "file_too_large",
      HttpStatus.PAYLOAD_TOO_LARGE,
      "Attachment is too large to open",
      byteSize,
    );
  }
}

function openedFile(
  filename: string,
  mediaType: string,
  bytes: Uint8Array,
  threadId: string | undefined,
): OpenedAttachment {
  const described = describeStoredFile(filename, mediaType, bytes);
  return {
    filename: described.filename,
    media_type: described.media_type,
    bytes,
    thread_id: threadId,
  };
}

function cleanFilename(filename: string | null | undefined): string {
  const clean = (filename ?? "")
    .replace(/[\r\n"]/g, "")
    .replace(/[/\\]/g, "")
    .trim()
    .slice(0, 120);
  return clean || "attachment";
}

function fileError(
  code: string,
  status: number,
  message: string,
  byteSize?: number,
): HttpException {
  return new HttpException(
    {
      error: {
        code,
        message,
        ...(byteSize === undefined ? {} : { byte_size: byteSize }),
      },
    },
    status,
  );
}
