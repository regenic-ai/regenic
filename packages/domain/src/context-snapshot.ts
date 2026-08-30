import type { ContextBudgetLedger } from "./context-budget";
import type { ContextCandidateKind } from "./context-candidate";

export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = "1.0" as const;

interface ContextSelectedReferenceBase {
  candidate_id: string;
  resource_id: string;
}

export type ContextSelectedReference = ContextSelectedReferenceBase &
  (
    | {
        kind: "event";
        content_hash: string;
        projection_generation?: never;
      }
    | {
        kind: Exclude<ContextCandidateKind, "event">;
        content_hash?: string;
        projection_generation: string;
      }
  );

export interface ContextSnapshot {
  schema_version: typeof CONTEXT_SNAPSHOT_SCHEMA_VERSION;
  id: string;
  org_id: string;
  request_hash: string;
  principal_policy_hash: string;
  read_epoch: string;
  retrieval_profile_version: string;
  assembly_profile_version: string;
  selected: ContextSelectedReference[];
  budget_ledger: ContextBudgetLedger;
  degradation_flags: string[];
  content_hash: string;
  created_at: string;
}