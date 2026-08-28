import { createHash } from "node:crypto";
import {
  CONTENT_PARTS_MEDIA_TYPE,
  isTextMediaType,
} from "./content-parts";
import { isUsableAttachmentBytes } from "./content-resolution";
import type { BlobMetaInput, BlobObject, ContentPart, IngestRecord } from "./ingestion";

export interface CanonicalContent {
  bytes: Uint8Array;
  hash: string;
  media_type: string;
  blobs: BlobObject[];
}

export class ContentUnavailableError extends Error {
  constructor() {
    super("Content must be resolved before ingestion");
    this.name = "ContentUnavailableError";
  }
}

function canonicalizePart(part: ContentPart): Uint8Array {
  if (part.bytes !== undefined) {
    return new Uint8Array(part.bytes);
  }

  if (part.text !== undefined) {
    return Buffer.from(part.text.replace(/\r\n?/g, "\n"), "utf8");
  }

  throw new ContentUnavailableError();
}

function shouldInlinePart(part: ContentPart): boolean {
  return part.role !== "attachment" && isTextMediaType(part.media_type);
}

function isPointerPart(part: ContentPart): boolean {
  return Boolean(part.external_locator) || isEmptyAttachment(part);
}

function isEmptyAttachment(part: ContentPart): boolean {
  return (
    part.role === "attachment" &&
    part.bytes !== undefined &&
    part.bytes.byteLength === 0
  );
}

function encodeEnvelopePart(
  part: ContentPart,
  blobs: BlobObject[],
): Record<string, string> {
  const encoded: Record<string, string> = {
    role: part.role,
    media_type: part.media_type,
  };
  if (part.source_filename) {
    encoded.source_filename = part.source_filename;
  }
  if (part.external_locator) {
    encoded.external_locator = part.external_locator;
  }
  if (
    part.role === "attachment" &&
    (part.bytes === undefined ||
      !isUsableAttachmentBytes(part.bytes, part.media_type))
  ) {
    return encoded;
  }
  const bytes = canonicalizePart(part);
  if (shouldInlinePart(part)) {
    encoded.text = Buffer.from(bytes).toString("utf8");
    return encoded;
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  blobs.push({
    hash,
    bytes,
    mediaType: part.media_type,
  });
  encoded.content_hash = hash;
  return encoded;
}

function canonicalizeParts(parts: ContentPart[]): {
  bytes: Uint8Array;
  media_type: string;
  blobs: BlobObject[];
} {
  if (parts.length === 1 && !isPointerPart(parts[0])) {
    return {
      bytes: canonicalizePart(parts[0]),
      media_type: parts[0].media_type,
      blobs: [],
    };
  }

  const blobs: BlobObject[] = [];
  const envelope = parts.map((part) => encodeEnvelopePart(part, blobs));

  return {
    bytes: Buffer.from(JSON.stringify(envelope), "utf8"),
    media_type: CONTENT_PARTS_MEDIA_TYPE,
    blobs: uniqueBlobs(blobs),
  };
}

function uniqueBlobs(items: BlobObject[]): BlobObject[] {
  const seen = new Set<string>();
  const unique: BlobObject[] = [];
  for (const item of items) {
    if (seen.has(item.hash)) {
      continue;
    }
    seen.add(item.hash);
    unique.push(item);
  }
  return unique;
}

export function canonicalizeContent(parts: ContentPart[]): CanonicalContent {
  if (parts.length === 0) {
    throw new ContentUnavailableError();
  }
  const canonical = canonicalizeParts(parts);
  return {
    ...canonical,
    hash: createHash("sha256").update(canonical.bytes).digest("hex"),
  };
}

export function canonicalizeRecordContent(record: IngestRecord): CanonicalContent {
  if (!record.content || record.content.length === 0) {
    throw new ContentUnavailableError();
  }
  return canonicalizeContent(record.content);
}

export function blobsForCanonical(canonical: CanonicalContent): BlobObject[] {
  return [
    {
      hash: canonical.hash,
      bytes: canonical.bytes,
      mediaType: canonical.media_type,
    },
    ...canonical.blobs,
  ];
}

export function extraBlobsForCanonical(
  canonical: CanonicalContent,
): BlobMetaInput[] | undefined {
  if (canonical.blobs.length === 0) {
    return undefined;
  }
  return canonical.blobs.map((blob) => ({
    content_hash: blob.hash,
    media_type: blob.mediaType,
    byte_size: blob.bytes.byteLength,
  }));
}
