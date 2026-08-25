import type { ContentPart, JsonValue } from "./ingestion";
import type { RecordClass } from "./record-class";
import type { ThreadFacet } from "./thread-facet";

export const WORK_ITEM_STATUSES = [
  "open",
  "running",
  "waiting_human",
  "done",
  "failed",
  "skipped",
] as const;

export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const ACTIVE_WORK_STATUSES: readonly WorkItemStatus[] = [
  "open",
  "running",
  "waiting_human",
];

export function isActiveWorkStatus(status: WorkItemStatus): boolean {
  return ACTIVE_WORK_STATUSES.includes(status);
}

export interface RecipeMatch {
  record_class?: RecordClass;
  thread_facet?: ThreadFacet;
  source?: string;
  thread_id?: string;
}

export interface Recipe {
  id: string;
  org_id: string;
  name: string;
  match: RecipeMatch;
  executor_type: string;
  executor_config: Record<string, JsonValue>;
  can_write_back: boolean;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface WorkItem {
  id: string;
  org_id: string;
  thread_id: string;
  /** Work-unit identity. A session may have many jobs over time. */
  unit_key: string;
  head_event_id?: string;
  record_class: RecordClass;
  thread_facet: ThreadFacet;
  status: WorkItemStatus;
  recipe_id?: string;
  created_at: string;
  updated_at: string;
}

export type WorkRunStatus =
  | "running"
  | "waiting_human"
  | "completed"
  | "failed"
  | "cancelled";

export interface ResultEnvelope {
  summary: string;
  content?: ContentPart[];
  evidence_event_ids?: string[];
}

export interface WorkRun {
  id: string;
  org_id: string;
  work_item_id: string;
  recipe_id: string;
  executor_type: string;
  external_run_id?: string;
  agent_thread_id?: string;
  status: WorkRunStatus;
  result?: ResultEnvelope;
  created_at: string;
  updated_at: string;
}

export const INBOX_SORT_MODES = ["normal", "attention"] as const;

export type InboxSortMode = (typeof INBOX_SORT_MODES)[number];

export const INBOX_SORT_PREF_KEY = "inbox_sort";

export function normalizeInboxSort(value: unknown): InboxSortMode {
  return value === "attention" ? "attention" : "normal";
}

export interface WorkFace {
  id: string;
  status: WorkItemStatus;
  recipe_id?: string;
  executor_type?: string;
  agent_thread_id?: string;
  can_write_back?: boolean;
  has_result?: boolean;
  updated_at?: string;
}

export interface WorkStore {
  listRecipes(orgId: string): Promise<Recipe[]>;
  getRecipe(orgId: string, id: string): Promise<Recipe | null>;
  putRecipe(recipe: Recipe): Promise<Recipe>;
  deleteRecipe(orgId: string, id: string): Promise<boolean>;
  listWorkItems(orgId: string): Promise<WorkItem[]>;
  getWorkItem(orgId: string, id: string): Promise<WorkItem | null>;
  /** Foreground job on the session, not a unique thread identity. */
  getWorkItemByThread(
    orgId: string,
    threadId: string,
  ): Promise<WorkItem | null>;
  putWorkItem(item: WorkItem): Promise<WorkItem>;
  listWorkRuns(orgId: string, workItemId?: string): Promise<WorkRun[]>;
  getWorkRun(orgId: string, id: string): Promise<WorkRun | null>;
  getActiveWorkRun(
    orgId: string,
    workItemId: string,
  ): Promise<WorkRun | null>;
  putWorkRun(run: WorkRun): Promise<WorkRun>;
  getUiPref(orgId: string, key: string): Promise<string | null>;
  putUiPref(
    orgId: string,
    key: string,
    value: string,
    updatedAt: string,
  ): Promise<void>;
}
