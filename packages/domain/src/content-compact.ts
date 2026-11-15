import { randomUUID } from "node:crypto";
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
  BlobObject,
  FencedBlobStore,
  ContentPart,
  ContentPartRole,
} from "./ingestion";

export interface ContentCompactResult {
  scanned: number;
  rewritten: number;
  failed: number;
  released_bytes: number;
  paused: boolean;
}

export interface ContentCompactOptions {
  signal?: AbortSignal;
  pauseIf?: () => boolean;
}

const CONTENT_ROLES = new Set<ContentPartRole>([
  "body",
  "attachment",
  "transcript",
  "metadata",
]);
const BLOB_WRITE_LEASE_MS = 120_000;

export async function compactEmbeddedContent(
  authority: AuthorityStore,
  blobs: FencedBlobStore,
  orgId: string,
  options: ContentCompactOptions = {},
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
  let failed = 0;
  let paused = false;

  for (const [index, hash] of hashes.entries()) {
    if (options.signal?.aborted || options.pauseIf?.()) {
      paused = true;
      break;
    }
    if (index > 0 && index % 8 === 0) {
      await yieldEventLoop();
      if (options.signal?.aborted || options.pauseIf?.()) {
        paused = true;
        break;
      }
    }
    const meta = metas.get(hash);
    if (!meta || meta.media_type !== CONTENT_PARTS_MEDIA_TYPE) {
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await blobs.get(hash);
    } catch {
      failed += 1;
      continue;
    }
    const parts = parseStoredContentParts(bytes);
    if (!parts) {
      continue;
    }
    if (!envelopeHasEmbeddedBytes(parts)) {
      continue;
    }
    const content = partsToContent(parts);
    if (!content) {
      failed += 1;
      continue;
    }
    const canonical = canonicalizeContent(content);
    if (canonical.hash === hash) {
      continue;
    }
    const blobObjects: BlobObject[] = [
      {
        hash: canonical.hash,
        bytes: canonical.bytes,
        mediaType: canonical.media_type,
      },
      ...canonical.blobs,
    ];
    const updated = await writeAndRepointContent(
      authority,
      blobs,
      hash,
      canonical.hash,
      canonical.media_type,
      canonical.bytes.byteLength,
      extraBlobsForCanonical(canonical),
      blobObjects,
    );
    if (updated > 0) rewritten += 1;
  }

  return {
    scanned: hashes.length,
    rewritten,
    failed,
    released_bytes: 0,
    paused,
  };
}

async function writeAndRepointContent(
  authority: AuthorityStore,
  blobs: FencedBlobStore,
  oldHash: string,
  newHash: string,
  mediaType: string,
  byteSize: number,
  extraBlobs: ReturnType<typeof extraBlobsForCanonical>,
  blobObjects: readonly BlobObject[],
): Promise<number> {
  const unique = new Map(blobObjects.map((blob) => [blob.hash, blob]));
  const reserveInput = {
    owner_id: randomUUID(),
    lease_duration_ms: BLOB_WRITE_LEASE_MS,
    blobs: [...unique.values()].map((blob) => ({
      content_hash: blob.hash,
      media_type: blob.mediaType,
      byte_size: blob.bytes.byteLength,
    })),
  };
  const reservations = await authority.reserveBlobWrites(reserveInput);
  const completed = new Map(reservations.map((reservation) => [reservation.content_hash, reservation]));
  try {
    for (const reservation of reservations) {
      const blob = unique.get(reservation.content_hash);
      if (!blob) throw new Error("Authority reserved an unrequested compaction Blob");
      if (reservation.mode === "write") {
        await blobs.putFenced(blob.hash, blob.bytes, blob.mediaType, reservation.generation);
        continue;
      }

      if (await blobs.exists(blob.hash)) {
        if (!Buffer.from(await blobs.get(blob.hash)).equals(Buffer.from(blob.bytes))) {
          throw new Error(`Stored compaction Blob does not match its content hash: ${blob.hash}`);
        }
        continue;
      }

      const repair = await authority.reserveBlobWrites({
        ...reserveInput,
        blobs: reserveInput.blobs.filter((item) => item.content_hash === blob.hash),
        force_write_hashes: [blob.hash],
      });
      const [claim] = repair;
      if (!claim || claim.mode !== "write") {
        throw new Error(`Missing compaction Blob could not be claimed for repair: ${blob.hash}`);
      }
      completed.set(claim.content_hash, claim);
      await blobs.putFenced(blob.hash, blob.bytes, blob.mediaType, claim.generation);
    }

    const updated = await authority.repointContentHash({
      old_content_hash: oldHash,
      new_content_hash: newHash,
      content_media_type: mediaType,
      content_byte_size: byteSize,
      extra_blobs: extraBlobs,
      blob_reservations: [...completed.values()],
    });
    if (updated === 0) {
      await authority.releaseBlobReservations([...completed.values()]);
    }
    return updated;
  } catch (error) {
    await authority.releaseBlobReservations([...completed.values()]);
    throw error;
  }
}

function yieldEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
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
    if (typeof part.external_locator === "string" && part.external_locator) {
      content.push({ ...base, external_locator: part.external_locator });
      continue;
    }
    return undefined;
  }
  return content.length > 0 ? content : undefined;
}
