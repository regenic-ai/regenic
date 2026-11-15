import { createHash } from "node:crypto";
import {
  CONTENT_PARTS_MEDIA_TYPE,
  attachmentHashesFromStoredParts,
  parseStoredContentParts,
  type EventRecord,
} from "@regenic/domain";
import { withBlobMaintenanceHost } from "../host";
import {
  assertObjectKeys,
  optionPath,
  optionString,
  requirePath,
  requirePositiveInteger,
  writeJson,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";

const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGE_SIZE = 1000;

export async function blobReferenceBackfillCommand(
  options: CommandOptions,
  stdout: CliOutput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  assertObjectKeys(options, new Set([
    "database", "blob-root", "org", "limit", "after-ingested-at", "after-id",
  ]), "Blob reference backfill option");
  if (options.database === true) throw new Error("--database requires a path value");
  const database = optionPath(options, "database");
  const blobRoot = requirePath(options, "blob-root");
  const orgId = optionString(options, "org");
  if (!orgId?.trim()) throw new Error("--org is required");
  const limit = requirePositiveInteger(options, "limit", DEFAULT_PAGE_SIZE);
  if (limit > MAX_PAGE_SIZE) throw new Error(`--limit must not exceed ${MAX_PAGE_SIZE}`);
  const afterAt = optionString(options, "after-ingested-at");
  const afterId = optionString(options, "after-id");
  if ((afterAt === undefined) !== (afterId === undefined)) {
    throw new Error("--after-ingested-at and --after-id must be provided together");
  }
  if (afterAt !== undefined && !Number.isFinite(Date.parse(afterAt))) {
    throw new Error("--after-ingested-at must be a valid timestamp");
  }

  await withBlobMaintenanceHost({ database, blobRoot, env, readOnly: false }, async (host) => {
    const authority = host.get("authority");
    const blobs = host.get("blobs");
    const page = await authority.listEvents(orgId, {
      ...(afterAt !== undefined ? { since: afterAt, since_id: afterId } : {}),
      limit: limit + 1,
      order: "ingested",
    });
    const hasMore = page.length > limit;
    const events = page.slice(0, limit);
    const hashes = [...new Set(events.flatMap((event) =>
      event.content_hash ? [event.content_hash] : []))];
    const metadata = await authority.findBlobs(hashes);
    let scanned = 0;
    let referencesAddedFor = 0;
    let attachmentReferences = 0;
    let blocked: { event_id: string; reason: string } | null = null;
    let cursor: { ingested_at: string; id: string } | null =
      afterAt !== undefined && afterId !== undefined
        ? { ingested_at: afterAt, id: afterId }
        : null;

    for (const event of events) {
      scanned += 1;
      cursor = { ingested_at: event.ingested_at, id: event.id };
      if (!event.content_hash) continue;
      const meta = metadata.get(event.content_hash);
      if (!meta) {
        blocked = { event_id: event.id, reason: "event_blob_metadata_missing" };
        cursor = previousCursor(events, event, afterAt, afterId);
        break;
      }
      if (meta.media_type !== CONTENT_PARTS_MEDIA_TYPE) continue;

      let bytes: Uint8Array;
      try {
        bytes = await blobs.get(event.content_hash);
      } catch {
        blocked = { event_id: event.id, reason: "event_blob_unavailable" };
        cursor = previousCursor(events, event, afterAt, afterId);
        break;
      }
      const actualHash = createHash("sha256").update(bytes).digest("hex");
      if (actualHash !== event.content_hash) {
        blocked = { event_id: event.id, reason: "event_blob_hash_mismatch" };
        cursor = previousCursor(events, event, afterAt, afterId);
        break;
      }
      const parts = parseStoredContentParts(bytes);
      if (!parts) {
        blocked = { event_id: event.id, reason: "event_content_parts_invalid" };
        cursor = previousCursor(events, event, afterAt, afterId);
        break;
      }
      const attachmentHashes = attachmentHashesFromStoredParts(parts);
      if (attachmentHashes.length === 0) continue;
      await authority.backfillEventAttachmentReferences({
        org_id: orgId,
        event_id: event.id,
        expected_content_hash: event.content_hash,
        attachment_hashes: attachmentHashes,
      });
      referencesAddedFor += 1;
      attachmentReferences += attachmentHashes.length;
    }

    const nextCursor = blocked
      ? cursor
      : hasMore && events.length > 0
        ? cursor
        : null;
    writeJson(stdout, {
      read_only: false,
      deletion_performed: false,
      org_id: orgId,
      scanned,
      events_with_attachments: referencesAddedFor,
      attachment_references: attachmentReferences,
      blocked,
      next_cursor: nextCursor,
    });
  });
}

function previousCursor(
  events: readonly EventRecord[],
  event: EventRecord,
  afterAt?: string,
  afterId?: string,
): { ingested_at: string; id: string } | null {
  const index = events.findIndex((item) => item.id === event.id);
  const previous = index > 0 ? events[index - 1] : undefined;
  return previous
    ? { ingested_at: previous.ingested_at, id: previous.id }
    : afterAt !== undefined && afterId !== undefined
      ? { ingested_at: afterAt, id: afterId }
      : null;
}
