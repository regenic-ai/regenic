import { createHash } from "node:crypto";
import { INGEST_SCHEMA_VERSION, type IngestBatch, type IngestRecord } from "./ingestion";
import { validateIngestBatch } from "./ingestion-schema";

export const DEFAULT_GENERIC_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_GENERIC_IMPORT_MAX_RECORDS_PER_BATCH = 1_000;

export type GenericImportFormat = "csv" | "jsonl";

export interface GenericImportMapping {
  external_id: string;
  occurred_at: string;
  text: string;
  actor_id?: string;
  actor_display_name?: string;
  scope_id?: string;
  scope_name?: string;
  type?: string;
}

export interface GenericImportDefaults {
  actor_id: string;
  scope_id: string;
  type: string;
}

export interface SourceImportProfile {
  id: string;
  connector_id: string;
  source: string;
  mapping: GenericImportMapping;
  defaults: GenericImportDefaults;
}

export interface GenericImportInput {
  format: GenericImportFormat;
  data: string | Uint8Array;
  connector_id: string;
  org_id: string;
  source: string;
  received_at: string;
  mapping: GenericImportMapping;
  defaults: GenericImportDefaults;
  max_bytes?: number;
  max_records_per_batch?: number;
}

export interface GenericImportRowError {
  line?: number;
  code:
    | "file_too_large"
    | "invalid_encoding"
    | "invalid_csv"
    | "invalid_json"
    | "invalid_row";
  message: string;
}

export interface GenericImportResult {
  file_hash: string;
  batches: IngestBatch[];
  errors: GenericImportRowError[];
}

interface ParsedRow {
  line: number;
  values: Record<string, unknown>;
}

export function createGenericImport(input: GenericImportInput): GenericImportResult {
  const bytes = toBytes(input.data);
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  const errors: GenericImportRowError[] = [];
  const maxBytes = input.max_bytes ?? DEFAULT_GENERIC_IMPORT_MAX_BYTES;
  if (bytes.byteLength > maxBytes) {
    return {
      file_hash: fileHash,
      batches: [],
      errors: [{ code: "file_too_large", message: `File exceeds ${maxBytes} byte limit` }],
    };
  }
  let text: string;
  try {
    text = decodeUtf8(bytes);
  } catch {
    return {
      file_hash: fileHash,
      batches: [],
      errors: [{ code: "invalid_encoding", message: "File must be valid UTF-8" }],
    };
  }
  const rows = parseRows(input.format, text, errors);
  const records: IngestRecord[] = [];

  for (const row of rows) {
    const record = mapRecord(row, input, errors);
    if (record) {
      records.push(record);
    }
  }

  const maxRecords =
    input.max_records_per_batch ?? DEFAULT_GENERIC_IMPORT_MAX_RECORDS_PER_BATCH;
  if (!Number.isInteger(maxRecords) || maxRecords < 1) {
    throw new Error("max_records_per_batch must be a positive integer");
  }
  const batches = chunk(records, maxRecords).map((batchRecords, index) => ({
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: input.connector_id,
    org_id: input.org_id,
    delivery_id: `generic-import:${fileHash}:${index + 1}`,
    received_at: input.received_at,
    records: batchRecords,
  }));
  return {
    file_hash: fileHash,
    batches,
    errors,
  };
}

export function createGenericImportFromProfile(input: {
  profile: SourceImportProfile;
  format: GenericImportFormat;
  data: string | Uint8Array;
  org_id: string;
  received_at: string;
  max_bytes?: number;
  max_records_per_batch?: number;
}): GenericImportResult {
  return createGenericImport({
    format: input.format,
    data: input.data,
    connector_id: input.profile.connector_id,
    org_id: input.org_id,
    source: input.profile.source,
    received_at: input.received_at,
    mapping: input.profile.mapping,
    defaults: input.profile.defaults,
    max_bytes: input.max_bytes,
    max_records_per_batch: input.max_records_per_batch,
  });
}

function mapRecord(
  row: ParsedRow,
  input: GenericImportInput,
  errors: GenericImportRowError[],
): IngestRecord | null {
  const value = (field: keyof GenericImportMapping): string | undefined => {
    const column = input.mapping[field];
    if (!column) {
      return undefined;
    }
    const candidate = row.values[column];
    return typeof candidate === "string" && candidate.length > 0
      ? candidate
      : undefined;
  };
  const externalId = value("external_id");
  const occurredAt = value("occurred_at");
  const text = value("text");
  if (!externalId || !occurredAt || text === undefined) {
    errors.push({
      line: row.line,
      code: "invalid_row",
      message: "Mapped external_id, occurred_at, and text must be non-empty strings",
    });
    return null;
  }

  const actorId = value("actor_id") ?? input.defaults.actor_id;
  const scopeId = value("scope_id") ?? input.defaults.scope_id;
  const record: IngestRecord = {
    operation: "create",
    source: input.source,
    external_id: externalId,
    occurred_at: occurredAt,
    actor: {
      id: actorId,
      display_name: value("actor_display_name"),
    },
    scope: {
      id: scopeId,
      name: value("scope_name"),
    },
    type: value("type") ?? input.defaults.type,
    content: [{ role: "body", media_type: "text/plain", text }],
  };
  const validation = validateIngestBatch({
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: input.connector_id,
    org_id: input.org_id,
    delivery_id: "validation-only",
    received_at: input.received_at,
    records: [record],
  });
  if (!validation.success) {
    errors.push({
      line: row.line,
      code: "invalid_row",
      message: validation.issues.map((issue) => issue.message).join("; "),
    });
    return null;
  }
  return record;
}

function parseRows(
  format: GenericImportFormat,
  text: string,
  errors: GenericImportRowError[],
): ParsedRow[] {
  return format === "jsonl"
    ? parseJsonLines(text, errors)
    : parseCsv(text, errors);
}

function parseJsonLines(
  text: string,
  errors: GenericImportRowError[],
): ParsedRow[] {
  const rows: ParsedRow[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(line);
      if (!isObject(value)) {
        throw new Error("Each JSONL line must be an object");
      }
      rows.push({ line: index + 1, values: value });
    } catch (error) {
      errors.push({
        line: index + 1,
        code: "invalid_json",
        message: error instanceof Error ? error.message : "Invalid JSON",
      });
    }
  }
  return rows;
}

function parseCsv(text: string, errors: GenericImportRowError[]): ParsedRow[] {
  const parsed = parseCsvRecords(text, errors);
  const header = parsed.shift();
  if (!header) {
    return [];
  }
  const names = header.values;
  if (names.some((name) => name.length === 0) || new Set(names).size !== names.length) {
    errors.push({ line: header.line, code: "invalid_csv", message: "CSV header names must be unique and non-empty" });
    return [];
  }
  return parsed.map((row) => ({
    line: row.line,
    values: Object.fromEntries(names.map((name, index) => [name, row.values[index] ?? ""])),
  }));
}

function parseCsvRecords(text: string, errors: GenericImportRowError[]): Array<{ line: number; values: string[] }> {
  const rows: Array<{ line: number; values: string[] }> = [];
  let values: string[] = [];
  let field = "";
  let line = 1;
  let rowLine = 1;
  let quoted = false;
  let quoteClosed = false;
  let fieldStarted = false;
  const finishRow = () => {
    values.push(field);
    if (values.some((value) => value.length > 0)) {
      rows.push({ line: rowLine, values });
    }
    values = [];
    field = "";
    fieldStarted = false;
    quoteClosed = false;
    rowLine = line + 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        quoteClosed = true;
      } else {
        field += character;
        if (character === "\n") {
          line += 1;
        }
      }
      continue;
    }
    if (character === '"') {
      if (fieldStarted) {
        errors.push({ line, code: "invalid_csv", message: "Unexpected quote in unquoted field" });
        return [];
      }
      quoted = true;
      fieldStarted = true;
    } else if (character === ",") {
      values.push(field);
      field = "";
      fieldStarted = false;
      quoteClosed = false;
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      finishRow();
      line += 1;
    } else {
      if (quoteClosed) {
        errors.push({ line, code: "invalid_csv", message: "Unexpected data after closing quote" });
        return [];
      }
      field += character;
      fieldStarted = true;
    }
  }
  if (quoted) {
    errors.push({ line: rowLine, code: "invalid_csv", message: "Unterminated quoted field" });
    return [];
  }
  if (fieldStarted || values.length > 0) {
    finishRow();
  }
  return rows;
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}