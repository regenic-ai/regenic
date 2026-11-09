export type SearchAnswerOutcome = "timed_out";
export type SearchAnswerIntent = "lookup" | "aggregate" | "list";
export type SearchAnswerIncompleteReason =
  | "missing_time_range"
  | "range_too_wide"
  | "scope_limit"
  | "unreadable_evidence"
  | "transcript_limit";

export interface SearchAnswerScope {
  intent: SearchAnswerIntent;
  complete: boolean;
  total_count: number | null;
  included_count: number;
  omitted_count: number | null;
  occurred_after?: string;
  occurred_before?: string;
  incomplete_reason?: SearchAnswerIncompleteReason;
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
