export const CONTENT_PARTS_MEDIA_TYPE =
  "application/vnd.regenic.content-parts+json";

export const SURFACE_MEDIA_TYPE = "application/vnd.regenic.surface+json";

export interface StoredContentPart {
  role?: string;
  media_type?: string;
  source_filename?: string | null;
  text?: string;
  content_hash?: string;
  bytes_base64?: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function isTextMediaType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === SURFACE_MEDIA_TYPE
  );
}

export function parseStoredContentParts(
  bytes: Uint8Array,
): StoredContentPart[] | undefined {
  try {
    const parts = JSON.parse(
      Buffer.from(bytes).toString("utf8"),
    ) as StoredContentPart[];
    return Array.isArray(parts) && parts.length > 0 ? parts : undefined;
  } catch {
    return undefined;
  }
}

export function storedPartText(part: StoredContentPart): string | undefined {
  if (typeof part.text === "string") {
    return part.text;
  }
  if (!part.bytes_base64 || !part.media_type || !isTextMediaType(part.media_type)) {
    return undefined;
  }
  return Buffer.from(part.bytes_base64, "base64").toString("utf8");
}

export function storedPartBytes(part: StoredContentPart): Uint8Array | undefined {
  if (!part.bytes_base64) {
    return undefined;
  }
  return Buffer.from(part.bytes_base64, "base64");
}

export function storedPartContentHash(part: StoredContentPart): string | undefined {
  if (part.content_hash && SHA256_PATTERN.test(part.content_hash)) {
    return part.content_hash;
  }
  return undefined;
}

export function envelopeHasEmbeddedBytes(parts: readonly StoredContentPart[]): boolean {
  return parts.some((part) => typeof part.bytes_base64 === "string");
}

export function attachmentHashesFromStoredParts(
  parts: readonly StoredContentPart[],
): string[] {
  const hashes: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (part.role !== "attachment") {
      continue;
    }
    const hash = storedPartContentHash(part);
    if (!hash || seen.has(hash)) {
      continue;
    }
    seen.add(hash);
    hashes.push(hash);
  }
  return hashes;
}
