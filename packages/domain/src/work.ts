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

export const RECIPE_TRIGGER_KINDS = ["push", "pull", "manual"] as const;

export type RecipeTriggerKind = (typeof RECIPE_TRIGGER_KINDS)[number];

export const PULL_INTERVAL_MS = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
} as const;

export const PULL_INTERVALS_MS = [
  PULL_INTERVAL_MS["15m"],
  PULL_INTERVAL_MS["1h"],
  PULL_INTERVAL_MS["1d"],
] as const;

export interface RecipeTrigger {
  kind: RecipeTriggerKind;
  /** Pull only. Period between occurrences. */
  interval_ms?: number;
  /** Push only. Default true: one follow-up on the latest head after the current run. */
  coalesce?: boolean;
}

export interface Recipe {
  id: string;
  org_id: string;
  name: string;
  match: RecipeMatch;
  trigger: RecipeTrigger;
  executor_type: string;
  executor_config: Record<string, JsonValue>;
  can_write_back: boolean;
  /** Kernel evidence: send visible thread history, not just the head. */
  include_context: boolean;
  enabled: boolean;
  /** Pull only. Next wall-clock fire. Survives sleep and restart. */
  next_run_at?: string;
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

export const WORK_DELIVERY_STATUSES = [
  "queued",
  "running",
  "write_back",
  "acked",
  "dead",
] as const;

export type WorkDeliveryStatus = (typeof WORK_DELIVERY_STATUSES)[number];

export const WORK_WRITE_BACK_STATES = [
  "pending",
  "sent",
  "skipped",
  "failed",
] as const;

export type WorkWriteBackState = (typeof WORK_WRITE_BACK_STATES)[number];

export interface WorkDelivery {
  id: string;
  org_id: string;
  work_item_id: string;
  recipe_id: string;
  kind: RecipeTriggerKind;
  unit_key: string;
  event_id?: string;
  status: WorkDeliveryStatus;
  write_back: WorkWriteBackState;
  attempts: number;
  payload?: {
    summary: string;
    content?: ContentPart[];
  };
  idempotency_key?: string;
  channel_receipt?: { accepted: boolean; rpc_id?: string };
  last_error?: string;
  next_retry_at?: string;
  lease_expires_at?: string;
  created_at: string;
  updated_at: string;
}

export interface WorkDeliveryFace {
  status: WorkDeliveryStatus;
  write_back: WorkWriteBackState;
  attempts: number;
  last_error?: string;
}

export interface WorkFace {
  id: string;
  status: WorkItemStatus;
  recipe_id?: string;
  executor_type?: string;
  agent_thread_id?: string;
  can_write_back?: boolean;
  has_result?: boolean;
  result_summary?: string;
  delivery?: WorkDeliveryFace;
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
  listWorkDeliveries(orgId: string): Promise<WorkDelivery[]>;
  getWorkDelivery(orgId: string, id: string): Promise<WorkDelivery | null>;
  getWorkDeliveryByItem(
    orgId: string,
    workItemId: string,
  ): Promise<WorkDelivery | null>;
  putWorkDelivery(delivery: WorkDelivery): Promise<WorkDelivery>;
  getUiPref(orgId: string, key: string): Promise<string | null>;
  putUiPref(
    orgId: string,
    key: string,
    value: string,
    updatedAt: string,
  ): Promise<void>;
}
