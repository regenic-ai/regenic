import { readFile, writeFile } from "node:fs/promises";
import {
  createGenericImport,
  type GenericImportDefaults,
  type GenericImportFormat,
  type GenericImportMapping,
} from "@regenic/domain";
import {
  isObject,
  optionalString,
  requireOption,
  requirePath,
  requireString,
  writeJson,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";
import { withLocalHost } from "../host";

export async function importFile(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
): Promise<void> {
  const database = requirePath(options, "database");
  const blobRoot = requirePath(options, "blob-root");
  const file = requirePath(options, "file");
  const mappingPath = requirePath(options, "mapping");
  const format = requireFormat(options);
  const mapping = await readImportMapping(mappingPath);
  const imported = createGenericImport({
    format,
    data: await readFile(file),
    connector_id: "generic-file-import",
    org_id: requireOption(options, "org"),
    source: requireOption(options, "source"),
    received_at: now(),
    mapping: mapping.mapping,
    defaults: mapping.defaults,
  });
  await withLocalHost({ database, blobRoot }, async (host) => {
    const batches = [];
    for (const batch of imported.batches) {
      const result = await host.get("ingest").ingest(batch);
      if (!result.valid) {
        throw new Error(`Generated import batch was rejected: ${result.error_code}`);
      }
      batches.push(result);
    }
    writeJson(stdout, {
      file_hash: imported.file_hash,
      batches,
      errors: imported.errors,
    });
  });
}

export async function exportJsonl(
  options: CommandOptions,
  stdout: CliOutput,
): Promise<void> {
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const events = await host.get("authority").listEvents(requireOption(options, "org"));
    const output = events
      .map((event) => JSON.stringify({ schema_version: "1.0", kind: "event", event }))
      .join("\n");
    await writeFile(requirePath(options, "output"), output ? `${output}\n` : "", "utf8");
    writeJson(stdout, { exported_event_count: events.length });
  });
}

export async function renderDigest(
  options: CommandOptions,
  stdout: CliOutput,
): Promise<void> {
  await withLocalHost({
    database: requirePath(options, "database"),
    blobRoot: requirePath(options, "blob-root"),
  }, async (host) => {
    const store = host.get("authority");
    const blobStore = host.get("blobs");
    const events = await store.listEvents(requireOption(options, "org"));
    const installations = await store.listInstallations(requireOption(options, "org"));
    const quarantines = (await Promise.all(
      installations.map((installation) => store.listQuarantines(installation.id)),
    )).flat();
    const entries = await Promise.all(events.map(async (event) => ({
      event,
      text: await readEventText(event.content_hash, store, blobStore),
    })));
    await writeFile(
      requirePath(options, "output"),
      renderMarkdownDigest(entries, quarantines),
      "utf8",
    );
    writeJson(stdout, {
      rendered_event_count: entries.length,
      open_quarantine_count: quarantines.length,
    });
  });
}

function requireFormat(options: CommandOptions): GenericImportFormat {
  const format = requireOption(options, "format");
  if (format !== "csv" && format !== "jsonl") {
    throw new Error("--format must be csv or jsonl");
  }
  return format;
}

async function readImportMapping(path: string): Promise<{
  mapping: GenericImportMapping;
  defaults: GenericImportDefaults;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Import mapping file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed) || !isObject(parsed.mapping) || !isObject(parsed.defaults)) {
    throw new Error("Import mapping file must contain mapping and defaults objects");
  }
  const mapping = parsed.mapping;
  const defaults = parsed.defaults;
  const requiredMapping = ["external_id", "occurred_at", "text"] as const;
  const requiredDefaults = ["actor_id", "scope_id", "type"] as const;
  if (
    requiredMapping.some((name) => typeof mapping[name] !== "string") ||
    requiredDefaults.some((name) => typeof defaults[name] !== "string")
  ) {
    throw new Error("Import mapping file is missing required string mapping/default fields");
  }
  return {
    mapping: {
      external_id: requireString(mapping.external_id),
      occurred_at: requireString(mapping.occurred_at),
      text: requireString(mapping.text),
      actor_id: optionalString(mapping.actor_id),
      actor_display_name: optionalString(mapping.actor_display_name),
      scope_id: optionalString(mapping.scope_id),
      scope_name: optionalString(mapping.scope_name),
      type: optionalString(mapping.type),
    },
    defaults: {
      actor_id: requireString(defaults.actor_id),
      scope_id: requireString(defaults.scope_id),
      type: requireString(defaults.type),
    },
  };
}

async function readEventText(
  contentHash: string | undefined,
  store: { findBlob(contentHash: string): Promise<{ media_type: string } | null> },
  blobStore: { get(hash: string): Promise<Uint8Array> },
): Promise<string | undefined> {
  if (!contentHash) {
    return undefined;
  }
  const blob = await store.findBlob(contentHash);
  if (!blob || blob.media_type !== "text/plain") {
    return undefined;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(await blobStore.get(contentHash));
}

function renderMarkdownDigest(entries: Array<{
  event: { id: string; source: string; external_id: string; operation: string; occurred_at: string; content_hash?: string };
  text?: string;
}>, quarantines: Array<{
  connector_installation_id: string;
  record_external_id: string;
  reason_code: string;
}>): string {
  const byDate = new Map<string, typeof entries>();
  for (const entry of entries) {
    const date = entry.event.occurred_at.slice(0, 10);
    const group = byDate.get(date) ?? [];
    group.push(entry);
    byDate.set(date, group);
  }
  const operations = entries.reduce(
    (counts, { event }) => ({ ...counts, [event.operation]: (counts[event.operation] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  const lines = [
    "# Regenic Digest",
    "",
    "## Processing Status",
    "",
    `- Events: ${entries.length}`,
    `- Creates: ${operations.create ?? 0}`,
    `- Revisions: ${operations.revise ?? 0}`,
    `- Tombstones: ${operations.tombstone ?? 0}`,
    `- Open quarantines: ${quarantines.length}`,
    "",
  ];
  if (quarantines.length > 0) {
    lines.push("## Quarantines", "");
    for (const quarantine of quarantines) {
      lines.push(
        `- **${quarantine.reason_code}** ${quarantine.record_external_id} (Installation: \`${quarantine.connector_installation_id}\`)`,
      );
    }
    lines.push("");
  }
  for (const [date, group] of byDate) {
    lines.push(`## ${date}`, "");
    for (const { event, text } of group) {
      const label = `${event.source}:${event.external_id}`;
      lines.push(`- **${event.operation}** ${label}`);
      if (text !== undefined) {
        lines.push(`  ${text.replace(/\r?\n/g, " ")}`);
      }
      const evidence = [`Event: \`${event.id}\``];
      if (event.content_hash) {
        evidence.push(`Blob: \`${event.content_hash}\``);
      }
      lines.push(`  Evidence: ${evidence.join("; ")}`, "");
    }
  }
  return `${lines.join("\n")}\n`;
}

