import { createHash } from "node:crypto";
import type { ContentPart, IngestRecord } from "./ingestion";

export interface CanonicalContent {
  bytes: Uint8Array;
  hash: string;
  media_type: string;
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

function canonicalizeParts(parts: ContentPart[]): {
  bytes: Uint8Array;
  media_type: string;
} {
  if (parts.length === 1) {
    return {
      bytes: canonicalizePart(parts[0]),
      media_type: parts[0].media_type,
    };
  }

  const envelope = parts.map((part) => ({
    role: part.role,
    media_type: part.media_type,
    source_filename: part.source_filename ?? null,
    bytes_base64: Buffer.from(canonicalizePart(part)).toString("base64"),
  }));

  return {
    bytes: Buffer.from(JSON.stringify(envelope), "utf8"),
    media_type: "application/vnd.regenic.content-parts+json",
  };
}

export function canonicalizeRecordContent(record: IngestRecord): CanonicalContent {
  if (!record.content || record.content.length === 0) {
    throw new ContentUnavailableError();
  }

  const canonical = canonicalizeParts(record.content);

  return {
    ...canonical,
    hash: createHash("sha256").update(canonical.bytes).digest("hex"),
  };
}