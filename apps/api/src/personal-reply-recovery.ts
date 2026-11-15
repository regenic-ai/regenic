import { createHash, randomUUID } from "node:crypto";
import {
  type AuthorityStore,
  type BlobReservation,
  type BlobStore,
  type FencedBlobStore,
  validateIngestBatch,
  type IngestBatch,
} from "@regenic/domain";

const RECOVERY_MEDIA_TYPE = "application/vnd.regenic.reply-recovery+json";
const BLOB_WRITE_LEASE_MS = 120_000;

export interface SavedReplyRecovery {
  hash: string;
  reservation: BlobReservation;
}

export async function saveReplyRecovery(
  blobs: FencedBlobStore,
  authority: Pick<AuthorityStore, "reserveBlobWrites" | "releaseBlobReservations">,
  batch: IngestBatch,
): Promise<SavedReplyRecovery> {
  const bytes = Buffer.from(JSON.stringify({
    ...batch,
    records: batch.records.map((record) => ({
      ...record,
      content: record.content?.map((part) => part.bytes
        ? {
            ...part,
            bytes: { reply_bytes_base64: Buffer.from(part.bytes).toString("base64") },
          }
        : part),
    })),
  }), "utf8");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const [reservation] = await authority.reserveBlobWrites({
    owner_id: randomUUID(),
    lease_duration_ms: BLOB_WRITE_LEASE_MS,
    blobs: [{
      content_hash: hash,
      media_type: RECOVERY_MEDIA_TYPE,
      byte_size: bytes.byteLength,
    }],
  });
  if (!reservation) throw new Error("Reply recovery Blob reservation was not created");
  let activeReservation = reservation;
  try {
    if (reservation.mode === "write") {
      await blobs.putFenced(hash, bytes, RECOVERY_MEDIA_TYPE, reservation.generation);
    } else if (await blobs.exists(hash)) {
      if (!Buffer.from(await blobs.get(hash)).equals(bytes)) {
        throw new Error(`Stored reply recovery Blob does not match its content hash: ${hash}`);
      }
    } else {
      const [repair] = await authority.reserveBlobWrites({
        owner_id: randomUUID(),
        lease_duration_ms: BLOB_WRITE_LEASE_MS,
        blobs: [{
          content_hash: hash,
          media_type: RECOVERY_MEDIA_TYPE,
          byte_size: bytes.byteLength,
        }],
        force_write_hashes: [hash],
      });
      if (!repair || repair.mode !== "write") {
        throw new Error(`Missing reply recovery Blob could not be claimed for repair: ${hash}`);
      }
      activeReservation = repair;
      await authority.releaseBlobReservations([reservation]);
      await blobs.putFenced(hash, bytes, RECOVERY_MEDIA_TYPE, repair.generation);
      return { hash, reservation: repair };
    }
    return { hash, reservation };
  } catch (error) {
    await authority.releaseBlobReservations([activeReservation]);
    throw error;
  }
}

export async function loadReplyRecovery(
  blobs: BlobStore,
  hash: string,
  orgId: string,
): Promise<IngestBatch> {
  const bytes = await blobs.get(hash);
  if (createHash("sha256").update(bytes).digest("hex") !== hash) {
    throw new Error("Stored reply recovery payload hash mismatch");
  }
  const input: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"), (key, value: unknown) => {
    if (
      key === "bytes" && value && typeof value === "object" &&
      "reply_bytes_base64" in value && typeof value.reply_bytes_base64 === "string"
    ) {
      return new Uint8Array(Buffer.from(value.reply_bytes_base64, "base64"));
    }
    return value;
  });
  const result = validateIngestBatch(input);
  if (!result.success || result.data.org_id !== orgId || result.data.records.length !== 1) {
    throw new Error("Stored reply recovery payload is invalid");
  }
  return result.data;
}
