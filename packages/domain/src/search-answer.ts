export type SearchAnswerOutcome = "timed_out" | "cancelled";
export type SearchAnswerIntent = "lookup" | "aggregate" | "list";
import type { AggregateSpec, AggregateSpecSummary } from "./aggregate-spec";

export type SearchAnswerIncompleteReason =
  | "missing_time_range"
  | "range_too_wide"
  | "scope_limit"
  | "unreadable_evidence"
  | "transcript_limit"
  | "planning_failed"
  | "schema_mismatch"
  | "map_failed"
  | "fact_conflict";

export interface SearchAnswerFact {
  dedupe_key: string;
  group: string;
  metric: string;
  value: number | string;
  event_ids: string[];
}

export const AGGREGATE_FACT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const AGGREGATE_FACT_CACHE_MAX_ROWS = 20_000;

export interface AggregateFactCacheRecord {
  org_id: string;
  spec_hash: string;
  extractor_version: string;
  event_id: string;
  content_hash: string;
  facts: SearchAnswerFact[];
  created_at: string;
  updated_at: string;
}

export type SearchAnswerMapBatchStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface SearchAnswerMapBatch {
  index: number;
  start_offset: number;
  end_offset: number;
  status: SearchAnswerMapBatchStatus;
  /** Zero-based attempt. One retry is allowed. */
  attempt: number;
  /** Deterministic for this batch and attempt. Never exposed by public APIs. */
  work_item_id?: string;
  /** Parsed facts only; message bodies remain in the authorized snapshot. */
  facts?: SearchAnswerFact[];
  /** Typed facts restored from content-addressed cache entries. */
  cached_facts?: SearchAnswerFact[];
  /** Authorized cache misses included in the current model execution. */
  map_event_ids?: string[];
  cache_hits?: number;
  cache_misses?: number;
}

export interface SearchAnswerMapReduce {
  strategy: "map_reduce";
  phase: "planning" | "mapping" | "reducing";
  snapshot_id: string;
  executor_type?: string;
  spec?: AggregateSpec;
  spec_hash?: string;
  cache_manifest?: {
    version: 1;
    extractor_version: string;
    spec_hash: string;
  };
  /** Zero-based attempt. Exactly one safe retry is allowed. */
  planning_attempt?: number;
  /** Records created before typed planning continue with their legacy parser. */
  legacy_untyped?: boolean;
  batch_offsets: number[];
  /** Retained for resumability of records created before adaptive batches. */
  batch_size?: number;
  total_batches: number;
  /** Durable per-batch state. Missing on records created by the serial implementation. */
  batches?: SearchAnswerMapBatch[];
  max_parallelism?: number;
  /** Legacy serial progress, retained only for migration. */
  completed_batches: number;
  /** Legacy serial attempt, retained only for migration. */
  batch_attempt: number;
  /** Legacy accumulated facts, retained only for migration. */
  facts: SearchAnswerFact[];
}

export interface SearchAnswerScope {
  intent: SearchAnswerIntent;
  complete: boolean;
  total_count: number | null;
  included_count: number;
  omitted_count: number | null;
  /** Number of conflicting canonical fact identities, capped by the reducer. */
  conflict_count?: number;
  spec_hash?: string;
  plan?: AggregateSpecSummary;
  occurred_after?: string;
  occurred_before?: string;
  incomplete_reason?: SearchAnswerIncompleteReason;
  map_reduce?: SearchAnswerMapReduce;
}

export interface SearchAnswerProgress {
  phase: "planning" | "mapping" | "reducing";
  completed_batches: number;
  total_batches: number;
  processed_messages: number;
  total_messages: number;
  current_attempt: number;
  max_attempts: number;
  active_batches: number;
  pending_batches: number;
  retrying_batches: number;
  max_parallelism: number;
  cache_hits?: number;
  cache_misses?: number;
  /** Number of conflicting canonical fact identities, capped by the reducer. */
  conflict_count?: number;
}

/**
 * Search-specific metadata that points at a normal persistent WorkItem/WorkRun.
 * Message bodies stay in the blob store; this record only keeps stable locators.
 */
export interface SearchAnswerRecord {
  id: string;
  org_id: string;
  work_item_id: string;
  query: string;
  event_ids: string[];
  scope?: SearchAnswerScope;
  outcome?: SearchAnswerOutcome;
  created_at: string;
  updated_at: string;
}

export interface SearchAnswerStore {
  getSearchAnswer(orgId: string, id: string): Promise<SearchAnswerRecord | null>;
  /** Existing identity and outcome are immutable here; historical inserts remain supported. */
  putSearchAnswer(record: SearchAnswerRecord): Promise<SearchAnswerRecord>;
  deleteSearchAnswer(orgId: string, id: string): Promise<boolean>;
  getAggregateFactCache(
    orgId: string,
    specHash: string,
    extractorVersion: string,
    eventIds: readonly string[],
  ): Promise<AggregateFactCacheRecord[]>;
  putAggregateFactCache(
    records: readonly AggregateFactCacheRecord[],
  ): Promise<void>;
}
