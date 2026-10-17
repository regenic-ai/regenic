import type { ContextBudgetLedger } from "./context-budget";
import type { ContextCandidateKind } from "./context-candidate";
import type { ActorRef } from "./actor";
import type { ContextAllowedUse } from "./context-request";

export const CONTEXT_SNAPSHOT_SCHEMA_VERSION = "1.0" as const;

export interface ContextRetrievalTrace {
  retriever_id: string;
  profile: string;
  mode: "lexical" | "hybrid";
  generation?: string;
  model_revision?: string;
  authorized_count: number;
  covered_count: number;
  routes: Array<{
    event_id: string;
    lexical_rank?: number;
    vector_rank?: number;
    vector_score?: number;
    chunk_ordinal?: number;
    start?: number;
    end?: number;
  }>;
}

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
  retrieval_trace?: ContextRetrievalTrace[];
  assembly_profile_version: string;
  bundle_payload_hash: string;
  selected: ContextSelectedReference[];
  budget_ledger: ContextBudgetLedger;
  degradation_flags: string[];
  content_hash: string;
  created_at: string;
}

/** Stable thread-to-snapshot association; does not alter immutable snapshot content. */
export interface ContextSnapshotIndexEntry {
  org_id: string;
  thread_id: string;
  snapshot_id: string;
  principal: ActorRef;
  consumer_id: string;
  purpose: string;
  allowed_uses: ContextAllowedUse[];
  created_at: string;
}

export interface ContextSnapshotIndexQuery {
  org_id: string;
  thread_id: string;
  principal: ActorRef;
  consumer_id: string;
  purpose?: string;
  limit?: number;
  before_created_at?: string;
  before_snapshot_id?: string;
}