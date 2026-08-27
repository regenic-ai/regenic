import { canonicalizeContent, extraBlobsForCanonical } from "./canonicalization";
import {
  CONTENT_PARTS_MEDIA_TYPE,
  envelopeHasEmbeddedBytes,
  parseStoredContentParts,
  storedPartBytes,
  storedPartText,
  type StoredContentPart,
} from "./content-parts";
import type {
  AuthorityStore,
  BlobStore,
  ContentPart,
  ContentPartRole,
} from "./ingestion";

export interface ContentCompactResult {
  scanned: number;
  rewritten: number;
  released_bytes: number;
}

const CONTENT_ROLES = new Set<ContentPartRole>([
  "body",
  "attachment",
  "transcript",
  "metadata",
]);

export async function compactEmbeddedContent(
  authority: AuthorityStore,
  blobs: BlobStore,
  orgId: string,
): Promise<ContentCompactResult> {
  const events = await authority.listEvents(orgId);
  const hashes = [
    ...new Set(
      events.flatMap((event) =>
        event.content_hash ? [event.content_hash] : [],
      ),
    ),
  ];
  const metas = await authority.findBlobs(hashes);
  let rewritten = 0;
  let released = 0;

  for (const hash of hashes) {
    const meta = metas.get(hash);
    if (!meta || meta.media_type !== CONTENT_PARTS_MEDIA_TYPE) {
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await blobs.get(hash);
    } catch {
      continue;
    }
    const parts = parseStoredContentParts(bytes);
    if (!parts || !envelopeHasEmbeddedBytes(parts)) {
      continue;
    }
    const content = partsToContent(parts);
    if (!content) {
      continue;
    }
    const canonical = canonicalizeContent(content);
    if (canonical.hash === hash) {
      continue;
    }
    await blobs.putMany([
      {
        hash: canonical.hash,
        bytes: canonical.bytes,
        mediaType: canonical.media_type,
      },
      ...canonical.blobs,
    ]);
    await authority.repointContentHash({
      old_content_hash: hash,
      new_content_hash: canonical.hash,
      content_media_type: canonical.media_type,
      content_byte_size: canonical.bytes.byteLength,
      extra_blobs: extraBlobsForCanonical(canonical),
    });
    await blobs.delete(hash);
    rewritten += 1;
    released += Math.max(
      0,
      bytes.byteLength -
        canonical.bytes.byteLength -
        canonical.blobs.reduce((sum, blob) => sum + blob.bytes.byteLength, 0),
    );
  }

  return {
    scanned: hashes.length,
    rewritten,
    released_bytes: released,
  };
}

function partsToContent(parts: StoredContentPart[]): ContentPart[] | undefined {
  const content: ContentPart[] = [];
  for (const part of parts) {
    if (!part.role || !CONTENT_ROLES.has(part.role as ContentPartRole) || !part.media_type) {
      return undefined;
    }
    const base = {
      role: part.role as ContentPartRole,
      media_type: part.media_type,
      ...(typeof part.source_filename === "string" && part.source_filename
        ? { source_filename: part.source_filename }
        : {}),
    };
    const text = storedPartText(part);
    const bytes = storedPartBytes(part);
    if (text !== undefined && part.role !== "attachment") {
      content.push({ ...base, text });
      continue;
    }
    if (bytes) {
      content.push({ ...base, bytes });
      continue;
    }
    return undefined;
  }
  return content.length > 0 ? content : undefined;
}
