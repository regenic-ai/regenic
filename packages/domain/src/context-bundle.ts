import type { ActorRef } from "./actor";
import type { ContextBudgetLedger, ContextSectionKind } from "./context-budget";
import type { ContextCandidateKind } from "./context-candidate";
import type { EvidenceReference } from "./context-consumer";

export const CONTEXT_BUNDLE_SCHEMA_VERSION = "2.0" as const;

export interface ContextBundleItem {
  candidate_id: string;
  resource_id: string;
  kind: ContextCandidateKind;
  status?: "current" | "superseded" | "retracted";
  text?: string;
  content_hash?: string;
  evidence: EvidenceReference[];
  estimated_tokens: number;
}

export interface ContextBundleSection {
  kind: ContextSectionKind;
  items: ContextBundleItem[];
  tokens: number;
}

export interface ContextConflict {
  code: string;
  candidate_ids: string[];
  message?: string;
}

export interface ContextRedaction {
  section: ContextSectionKind;
  category: string;
  count: number;
}

export interface ContextBundle {
  schema_version: typeof CONTEXT_BUNDLE_SCHEMA_VERSION;
  snapshot_id: string;
  org_id: string;
  principal: ActorRef;
  consumer_id: string;
  purpose: string;
  sections: ContextBundleSection[];
  citations: EvidenceReference[];
  conflicts: ContextConflict[];
  redactions: ContextRedaction[];
  budget_ledger: ContextBudgetLedger;
  degradation_flags: string[];
  content_hash: string;
}