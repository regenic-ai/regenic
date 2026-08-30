import type { EvidenceReference } from "./context-consumer";
import type { JsonValue } from "./ingestion";

export const CONTEXT_ARTIFACT_KINDS = [
  "thread_summary",
  "daily_digest",
  "claim_extraction",
  "identity_link",
  "topic_assignment",
  "query_interpretation",
] as const;

export type ContextArtifactKind = (typeof CONTEXT_ARTIFACT_KINDS)[number];

export const CONTEXT_ARTIFACT_STATUSES = [
  "proposed",
  "accepted",
  "rejected",
  "needs_clarify",
  "superseded",
] as const;

export type ContextArtifactStatus = (typeof CONTEXT_ARTIFACT_STATUSES)[number];

export interface ContextArtifact {
  id: string;
  org_id: string;
  kind: ContextArtifactKind;
  schema_version: string;
  algorithm_version: string;
  generation: string;
  input_refs: EvidenceReference[];
  input_hash: string;
  body_hash?: string;
  status: ContextArtifactStatus;
  required_scope_ids: string[];
  recorded_at: string;
  supersedes_id?: string;
  attrs?: JsonValue;
}