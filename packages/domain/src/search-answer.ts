export type SearchAnswerOutcome = "timed_out";

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
  outcome?: SearchAnswerOutcome;
  created_at: string;
  updated_at: string;
}

export interface SearchAnswerStore {
  getSearchAnswer(orgId: string, id: string): Promise<SearchAnswerRecord | null>;
  putSearchAnswer(record: SearchAnswerRecord): Promise<SearchAnswerRecord>;
  deleteSearchAnswer(orgId: string, id: string): Promise<boolean>;
}
