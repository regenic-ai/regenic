import type { EvidenceReference } from "./context-consumer";

export const CONTEXT_CANDIDATE_KINDS = [
  "event",
  "digest",
  "claim",
  "entity",
  "edge",
  "artifact",
] as const;

export type ContextCandidateKind = (typeof CONTEXT_CANDIDATE_KINDS)[number];

export interface ContextProjectionReference {
  projector_id: string;
  algorithm_version: string;
  generation: string;
}

export interface ContextCandidate {
  candidate_id: string;
  kind: ContextCandidateKind;
  resource_id: string;
  evidence: EvidenceReference[];
  required_scope_ids: string[];
  valid_from?: string;
  valid_to?: string;
  recorded_at: string;
  status?: "current" | "superseded" | "retracted";
  content_hash?: string;
  scores: Record<string, number>;
  estimated_tokens: number;
  conflicts?: string[];
  projection?: ContextProjectionReference;
}