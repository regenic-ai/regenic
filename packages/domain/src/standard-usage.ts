export const STANDARD_USAGE_SCHEMA_VERSION = "1.0" as const;

export type StandardUsageSourceKind = "decision" | "agent_run";

export interface StandardUsageRecord {
  schema_version: typeof STANDARD_USAGE_SCHEMA_VERSION;
  id: string;
  org_id: string;
  standard_id: string;
  version_id: string;
  source_kind: StandardUsageSourceKind;
  source_id: string;
  context_snapshot_id: string;
  cited_at: string;
}

export interface StandardUsageStore {
  projectStandardUsage(input: {
    org_id: string;
    source_kind: StandardUsageSourceKind;
    source_id: string;
  }): Promise<StandardUsageRecord[]>;
  listStandardUsage(input: {
    org_id: string;
    standard_id?: string;
    version_id?: string;
    source_kind?: StandardUsageSourceKind;
    limit?: number;
  }): Promise<StandardUsageRecord[]>;
}

export function validateStandardUsage(input: StandardUsageRecord): StandardUsageRecord {
  if (!input || input.schema_version !== STANDARD_USAGE_SCHEMA_VERSION
    || !nonBlank(input.id) || !nonBlank(input.org_id)
    || !nonBlank(input.standard_id) || !nonBlank(input.version_id)
    || !["decision", "agent_run"].includes(input.source_kind)
    || !nonBlank(input.source_id) || !nonBlank(input.context_snapshot_id)
    || !validTimestamp(input.cited_at)) {
    throw new Error("Invalid StandardUsage");
  }
  return structuredClone(input);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
