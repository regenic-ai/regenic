export type SearchAnswerOutcome = "timed_out";
export type SearchAnswerIntent = "lookup" | "aggregate" | "list";
export type SearchAnswerIncompleteReason =
  | "missing_time_range"
  | "range_too_wide"
  | "scope_limit"
  | "unreadable_evidence"
  | "transcript_limit"
  | "map_failed"
  | "fact_conflict";

export interface SearchAnswerFact {
  dedupe_key: string;
  group: string;
  metric: string;
  value: number | string;
  event_ids: string[];
}

export interface SearchAnswerMapReduce {
  strategy: "map_reduce";
  phase: "mapping" | "reducing";
  snapshot_id: string;
  executor_type?: string;
  batch_offsets: number[];
  /** Retained for resumability of records created before adaptive batches. */
  batch_size?: number;
  total_batches: number;
  completed_batches: number;
  /** Zero-based attempt for the current batch. One retry is allowed. */
  batch_attempt: number;
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
  occurred_after?: string;
  occurred_before?: string;
  incomplete_reason?: SearchAnswerIncompleteReason;
  map_reduce?: SearchAnswerMapReduce;
}

export interface SearchAnswerProgress {
  phase: "mapping" | "reducing";
  completed_batches: number;
  total_batches: number;
  processed_messages: number;
  total_messages: number;
  current_attempt: number;
  max_attempts: number;
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
  putSearchAnswer(record: SearchAnswerRecord): Promise<SearchAnswerRecord>;
  deleteSearchAnswer(orgId: string, id: string): Promise<boolean>;
}
