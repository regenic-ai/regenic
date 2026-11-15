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

export async function contextArtifactReferenceBackfillCommand(
  options: CommandOptions,
  stdout: CliOutput,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  assertObjectKeys(options, new Set([
    "database", "blob-root", "org", "limit", "after-recorded-at", "after-id",
  ]), "Context artifact reference backfill option");
  if (options.database === true) throw new Error("--database requires a path value");
  const database = optionPath(options, "database");
  const blobRoot = requirePath(options, "blob-root");
  const orgId = optionString(options, "org");
  if (!orgId?.trim()) throw new Error("--org is required");
  const limit = requirePositiveInteger(options, "limit", DEFAULT_PAGE_SIZE);
  if (limit > MAX_PAGE_SIZE) throw new Error(`--limit must not exceed ${MAX_PAGE_SIZE}`);
  const afterAt = optionString(options, "after-recorded-at");
  const afterId = optionString(options, "after-id");
  if ((afterAt === undefined) !== (afterId === undefined)) {
    throw new Error("--after-recorded-at and --after-id must be provided together");
  }
  if (afterAt !== undefined && !Number.isFinite(Date.parse(afterAt))) {
    throw new Error("--after-recorded-at must be a valid timestamp");
  }

  await withBlobMaintenanceHost({ database, blobRoot, env, readOnly: false }, async (host) => {
    const artifacts = host.get("context-artifacts");
    const page = await artifacts.listArtifacts({
      org_id: orgId,
      limit: limit + 1,
      ...(afterAt !== undefined && afterId !== undefined
        ? { after_recorded_at: afterAt, after_id: afterId }
        : {}),
    });
    const hasMore = page.length > limit;
    const selected = page.slice(0, limit);
    let scanned = 0;
    let evidenceReferences = 0;
    let blocked: { artifact_id: string; reason: string } | null = null;
    let cursor: { recorded_at: string; id: string } | null =
      afterAt !== undefined && afterId !== undefined
        ? { recorded_at: afterAt, id: afterId }
        : null;

    for (const artifact of selected) {
      try {
        await artifacts.backfillArtifactEvidenceReferences({
          org_id: orgId,
          artifact_id: artifact.id,
          expected_input_hash: artifact.input_hash,
        });
      } catch (error) {
        blocked = {
          artifact_id: artifact.id,
          reason: error instanceof Error ? error.message : String(error),
        };
        break;
      }
      scanned += 1;
      evidenceReferences += new Set(artifact.input_refs.flatMap((reference) =>
        reference.content_hash ? [reference.content_hash] : [])).size;
      cursor = { recorded_at: artifact.recorded_at, id: artifact.id };
    }

    writeJson(stdout, {
      read_only: false,
      deletion_performed: false,
      org_id: orgId,
      scanned,
      evidence_references: evidenceReferences,
      blocked,
      next_cursor: blocked
        ? cursor
        : hasMore && selected.length > 0
          ? cursor
          : null,
    });
  });
}
