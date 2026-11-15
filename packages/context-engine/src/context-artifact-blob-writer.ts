import { randomUUID } from "node:crypto";
import {
  canonicalContextJson,
  type BlobMetaInput,
  type BlobReservation,
  type ContextArtifact,
  type ContextArtifactStore,
  type FencedBlobStore,
} from "@regenic/domain";

const BLOB_WRITE_LEASE_MS = 120_000;
const CONTEXT_ARTIFACT_MEDIA_TYPE = "application/vnd.regenic.context-artifact+json";

export async function persistContextArtifact(
  artifact: ContextArtifact,
  artifacts: ContextArtifactStore,
  blobs?: FencedBlobStore,
): Promise<void> {
  const bodyHash = artifact.body_hash && artifact.body_storage !== "artifact"
    ? artifact.body_hash
    : undefined;
  const body = bodyHash && artifact.attrs !== undefined
    ? Buffer.from(canonicalContextJson(artifact.attrs), "utf8")
    : undefined;
  const metadata = new Map<string, BlobMetaInput>();
  for (const reference of artifact.input_refs) {
    if (reference.content_hash) {
      metadata.set(reference.content_hash, {
        content_hash: reference.content_hash,
        media_type: "application/octet-stream",
        byte_size: 0,
      });
    }
  }
  if (bodyHash) {
    metadata.set(bodyHash, {
      content_hash: bodyHash,
      media_type: CONTEXT_ARTIFACT_MEDIA_TYPE,
      byte_size: body?.byteLength ?? 0,
    });
  }

  const reservations = await artifacts.reserveBlobWrites({
    owner_id: randomUUID(),
    lease_duration_ms: BLOB_WRITE_LEASE_MS,
    blobs: [...metadata.values()],
  });
  const reservationsByHash = new Map(reservations.map((reservation) => [
    reservation.content_hash,
    reservation,
  ]));
  try {
    for (const reservation of reservations) {
      const isBody = reservation.content_hash === bodyHash;
      if (!isBody) {
        if (reservation.mode === "write") {
          throw new Error(`Missing bytes for context evidence Blob: ${reservation.content_hash}`);
        }
        continue;
      }

      if (!blobs) throw new Error("Fenced BlobStore is required to persist context artifact bodies");
      if (reservation.mode === "write") {
        if (!body) throw new Error(`Missing bytes for context artifact body: ${reservation.content_hash}`);
        await blobs.putFenced(reservation.content_hash, body, CONTEXT_ARTIFACT_MEDIA_TYPE, reservation.generation);
        continue;
      }

      if (await blobs.exists(reservation.content_hash)) {
        if (body && !Buffer.from(await blobs.get(reservation.content_hash)).equals(body)) {
          throw new Error(`Stored context artifact Blob does not match its content hash: ${reservation.content_hash}`);
        }
        continue;
      }
      if (!body) throw new Error(`Context artifact Blob is missing and cannot be repaired: ${reservation.content_hash}`);

      const repairMetadata = metadata.get(reservation.content_hash);
      if (!repairMetadata) {
        throw new Error(`Missing context artifact Blob metadata: ${reservation.content_hash}`);
      }
      const repair = await artifacts.reserveBlobWrites({
        owner_id: randomUUID(),
        lease_duration_ms: BLOB_WRITE_LEASE_MS,
        blobs: [repairMetadata],
        force_write_hashes: [reservation.content_hash],
      });
      const [claim] = repair;
      if (!claim || claim.mode !== "write") {
        throw new Error(`Missing context artifact Blob could not be claimed for repair: ${reservation.content_hash}`);
      }
      reservationsByHash.set(claim.content_hash, claim);
      await blobs.putFenced(claim.content_hash, body, CONTEXT_ARTIFACT_MEDIA_TYPE, claim.generation);
    }

    await artifacts.putArtifact(artifact, [...reservationsByHash.values()]);
  } catch (error) {
    await artifacts.releaseBlobReservations([...reservationsByHash.values()]);
    throw error;
  }
}
