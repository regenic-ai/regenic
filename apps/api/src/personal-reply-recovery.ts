import { createHash } from "node:crypto";
import {
  validateIngestBatch,
  type BlobStore,
  type IngestBatch,
} from "@regenic/domain";

const RECOVERY_MEDIA_TYPE = "application/vnd.regenic.reply-recovery+json";

export async function saveReplyRecovery(
  blobs: BlobStore,
  batch: IngestBatch,
): Promise<string> {
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
  await blobs.put(hash, bytes, RECOVERY_MEDIA_TYPE);
  return hash;
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
