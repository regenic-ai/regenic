import type { BlobInventoryRecord, BlobStoreEntry } from "@regenic/domain";
import { withBlobMaintenanceHost } from "../host";
import {
  assertObjectKeys,
  optionString,
  optionPath,
  requirePath,
  requirePositiveInteger,
  writeJson,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 1000;
const INVENTORY_BATCH_SIZE = 400;

export async function blobGcDryRunCommand(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string = () => new Date().toISOString(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  assertObjectKeys(options, new Set([
    "database", "blob-root", "limit", "after-hash", "after-authority-hash",
  ]), "Blob GC dry-run option");
  if (options.database === true) throw new Error("--database requires a path value");
  const database = optionPath(options, "database");
  const blobRoot = requirePath(options, "blob-root");
  const limit = requirePositiveInteger(options, "limit", DEFAULT_PAGE_SIZE);
  if (limit > MAX_PAGE_SIZE) {
    throw new Error(`--limit must not exceed ${MAX_PAGE_SIZE}`);
  }
  const afterHash = optionString(options, "after-hash");
  if (afterHash !== undefined && !HASH_PATTERN.test(afterHash)) {
    throw new Error("--after-hash must be a lowercase SHA-256 hash");
  }
  const afterAuthorityHash = optionString(options, "after-authority-hash");
  if (afterAuthorityHash !== undefined && !HASH_PATTERN.test(afterAuthorityHash)) {
    throw new Error("--after-authority-hash must be a lowercase SHA-256 hash");
  }

  await withBlobMaintenanceHost({ database, blobRoot, env, readOnly: true }, async (host) => {
    const blobs = host.get("blobs");
    const authority = host.get("authority");
    const page: BlobStoreEntry[] = [];
    let hasMore = false;
    for await (const entry of blobs.enumerate()) {
      if (afterHash && entry.hash <= afterHash) continue;
      if (page.length === limit) {
        hasMore = true;
        break;
      }
      page.push(entry);
    }

    const inventory = new Map<string, BlobInventoryRecord>();
    for (let offset = 0; offset < page.length; offset += INVENTORY_BATCH_SIZE) {
      const batch = page.slice(offset, offset + INVENTORY_BATCH_SIZE);
      const records = await authority.inspectBlobInventory(batch.map((entry) => entry.hash));
      for (const [hash, record] of records) inventory.set(hash, record);
    }
    const authorityPage = await authority.listBlobInventoryPage({
      ...(afterAuthorityHash !== undefined ? { after_hash: afterAuthorityHash } : {}),
      limit,
    });
    const authorityEntries = await Promise.all(authorityPage.entries.map(async (record) => ({
      hash: record.content_hash,
      byte_size: record.byte_size,
      object_present: await blobs.exists(record.content_hash),
      authority: {
        state: record.state,
        generation: record.generation,
        unreferenced_at: record.unreferenced_at,
        write_lease_expires_at: record.write_lease_expires_at,
        reference_count: record.reference_count,
      },
    })));

    const observedAt = now();
    const observedAtMs = Date.parse(observedAt);
    if (!Number.isFinite(observedAtMs)) {
      throw new Error("Dry-run clock must return a valid timestamp");
    }
    const entries = page.map((entry) => classifyEntry(
      entry,
      inventory.get(entry.hash),
      observedAtMs,
    ));
    writeJson(stdout, {
      observed_at: observedAt,
      read_only: true,
      deletion_performed: false,
      collection_enabled: false,
      reference_audit: "incomplete",
      retention_policy: "not_evaluated",
      entries,
      authority_entries: authorityEntries,
      next_after_hash: hasMore ? page.at(-1)?.hash ?? null : null,
      next_after_authority_hash: authorityPage.next_after_hash,
    });
  });
}

function classifyEntry(
  entry: { hash: string; byte_size: number },
  record: BlobInventoryRecord | undefined,
  observedAtMs: number,
) {
  const candidateReasons: string[] = [];
  const skipReasons = [
    "historical_reference_audit_incomplete",
    "retention_policy_not_evaluated",
  ];
  const leaseExpiresAt = record?.write_lease_expires_at === null
    ? null
    : record?.write_lease_expires_at === undefined
      ? undefined
      : Date.parse(record.write_lease_expires_at);
  const hasActiveWriteLease = leaseExpiresAt === undefined
    || (leaseExpiresAt !== null && (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt > observedAtMs));

  if (!record) {
    skipReasons.push("authority_record_missing");
  } else {
    if (record.reference_count > 0) skipReasons.push("authority_references_present");
    if (record.state !== "available") skipReasons.push(`authority_state_${record.state}`);
    if (hasActiveWriteLease) {
      skipReasons.push("active_write_lease");
    }
    if (record.unreferenced_at === null) {
      skipReasons.push("unreferenced_timestamp_missing");
    }
    if (
      record.state === "available"
      && record.reference_count === 0
      && !hasActiveWriteLease
      && record.unreferenced_at !== null
    ) {
      candidateReasons.push("available_without_known_references_or_write_lease");
    }
  }

  return {
    hash: entry.hash,
    byte_size: entry.byte_size,
    authority: record
      ? {
          state: record.state,
          generation: record.generation,
          unreferenced_at: record.unreferenced_at,
          write_lease_expires_at: record.write_lease_expires_at,
          reference_count: record.reference_count,
        }
      : null,
    classification: candidateReasons.length > 0 ? "blocked_candidate" : "skipped",
    candidate_reasons: candidateReasons,
    skip_reasons: skipReasons,
  };
}
