import { createHash } from "node:crypto";
import {
  CONTENT_PARTS_MEDIA_TYPE,
  isTextMediaType,
  parseStoredContentParts,
  storedPartContentHash,
  type StoredContentPart,
} from "./content-parts";
import type { ContentPart } from "./ingestion";

export async function preserveResolvedAttachments(
  incoming: ContentPart[],
  existingBytes: Uint8Array | undefined,
  existingMediaType: string | undefined,
  readBlob: (hash: string) => Promise<Uint8Array | undefined>,
): Promise<ContentPart[]> {
  if (!existingBytes || !existingMediaType) {
    return incoming;
  }
  const existingParts =
    existingMediaType === CONTENT_PARTS_MEDIA_TYPE
      ? (parseStoredContentParts(existingBytes) ?? [])
      : [];
  const byLocator = new Map<string, StoredContentPart>();
  for (const part of existingParts) {
    if (
      part.role === "attachment" &&
      typeof part.external_locator === "string" &&
      storedPartContentHash(part)
    ) {
      byLocator.set(part.external_locator, part);
    }
  }
  if (byLocator.size === 0) {
    return incoming;
  }
  const merged: ContentPart[] = [];
  for (const part of incoming) {
    if (
      part.role !== "attachment" ||
      !part.external_locator ||
      (part.bytes && isUsableAttachmentBytes(part.bytes, part.media_type))
    ) {
      merged.push(part);
      continue;
    }
    const prior = byLocator.get(part.external_locator);
    const hash = prior ? storedPartContentHash(prior) : undefined;
    const bytes = hash ? await readBlob(hash) : undefined;
    if (bytes && isUsableAttachmentBytes(bytes, prior?.media_type ?? part.media_type)) {
      merged.push({
        role: "attachment",
        media_type: prior?.media_type ?? part.media_type,
        source_filename:
          part.source_filename ?? prior?.source_filename ?? undefined,
        external_locator: part.external_locator,
        bytes,
      });
      continue;
    }
    merged.push(part);
  }
  return merged;
}

export interface AttachmentResolution {
  resolvedHashes: string[];
  unresolvedCount: number;
}

export function isLikelyJsonDocument(bytes: Uint8Array): boolean {
  let index = 0;
  while (
    index < bytes.length &&
    (bytes[index] === 0x09 ||
      bytes[index] === 0x0a ||
      bytes[index] === 0x0d ||
      bytes[index] === 0x20)
  ) {
    index += 1;
  }
  if (index >= bytes.length || (bytes[index] !== 0x7b && bytes[index] !== 0x5b)) {
    return false;
  }
  try {
    JSON.parse(Buffer.from(bytes).toString("utf8"));
    return true;
  } catch {
    return false;
  }
}

export function isUsableAttachmentBytes(
  bytes: Uint8Array,
  mediaType: string,
): boolean {
  if (bytes.byteLength === 0) {
    return false;
  }
  if (jsonMediaType(mediaType)) {
    return true;
  }
  return !isLikelyJsonDocument(bytes);
}

export function resolutionFromParts(
  parts: readonly ContentPart[],
): AttachmentResolution {
  const hashes: string[] = [];
  const seen = new Set<string>();
  let unresolved = 0;
  for (const part of parts) {
    if (part.role !== "attachment") {
      continue;
    }
    if (
      part.bytes &&
      isUsableAttachmentBytes(part.bytes, part.media_type)
    ) {
      const hash = createHash("sha256").update(part.bytes).digest("hex");
      if (!seen.has(hash)) {
        seen.add(hash);
        hashes.push(hash);
      }
      continue;
    }
    unresolved += 1;
  }
  return { resolvedHashes: hashes, unresolvedCount: unresolved };
}

export function resolutionFromCanonical(canonical: {
  bytes: Uint8Array;
  media_type: string;
}): AttachmentResolution {
  return resolutionFromStored(canonical.bytes, canonical.media_type);
}

export function resolutionFromStored(
  bytes: Uint8Array,
  mediaType: string,
): AttachmentResolution {
  if (mediaType === CONTENT_PARTS_MEDIA_TYPE) {
    const parts = parseStoredContentParts(bytes);
    return parts
      ? resolutionFromStoredParts(parts)
      : { resolvedHashes: [], unresolvedCount: 0 };
  }
  if (isTextMediaType(mediaType) || bytes.byteLength === 0) {
    return {
      resolvedHashes: [],
      unresolvedCount: bytes.byteLength === 0 && !isTextMediaType(mediaType) ? 1 : 0,
    };
  }
  return {
    resolvedHashes: [createHash("sha256").update(bytes).digest("hex")],
    unresolvedCount: 0,
  };
}

export function incomingImprovesAttachments(
  existing: AttachmentResolution,
  incoming: AttachmentResolution,
): boolean {
  const have = new Set(existing.resolvedHashes);
  const added = incoming.resolvedHashes.filter((hash) => !have.has(hash));
  return added.length > 0 && !incomingWorsensAttachments(existing, incoming);
}

export function incomingWorsensAttachments(
  existing: AttachmentResolution,
  incoming: AttachmentResolution,
): boolean {
  const next = new Set(incoming.resolvedHashes);
  return existing.resolvedHashes.some((hash) => !next.has(hash));
}

function resolutionFromStoredParts(
  parts: readonly StoredContentPart[],
): AttachmentResolution {
  const hashes: string[] = [];
  const seen = new Set<string>();
  let unresolved = 0;
  for (const part of parts) {
    if (part.role !== "attachment") {
      continue;
    }
    const hash = storedPartContentHash(part);
    if (hash) {
      if (!seen.has(hash)) {
        seen.add(hash);
        hashes.push(hash);
      }
      continue;
    }
    unresolved += 1;
  }
  return { resolvedHashes: hashes, unresolvedCount: unresolved };
}

function jsonMediaType(mediaType: string): boolean {
  return (
    mediaType === "application/json" ||
    mediaType.endsWith("+json") ||
    mediaType.startsWith("text/")
  );
}
