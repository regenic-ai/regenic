import type {
  ResultEnvelope,
  ExecutorRunHandle,
  WorkRun,
  WorkRunStatus,
  WorkWriteBackTarget,
} from "@regenic/connector-contract";
import type { ContentPart, JsonValue } from "./ingestion";
import type { RecordClass } from "./record-class";
import type { ThreadFacet } from "./thread-facet";
import type { SearchAnswerRecord } from "./search-answer";
import type {
  CommitWorkObservation, CommitWorkObservationResult,
  WorkRunStartCheckpoint, WorkRunStartCheckpointResult,
  WorkRunStartFailure, WorkRunStartFailureResult,
  WorkDismissal, WorkDismissalResult,
  WorkAcknowledgment, WorkAcknowledgmentResult,
  WorkItemCreation, WorkItemCreationResult,
  WorkItemObservation, WorkItemObservationResult,
  WorkItemCreationAbort, WorkItemCreationAbortResult,
} from "./work-transition";

export type { ResultEnvelope, WorkRun, WorkRunStatus };
export type { WorkWriteBackTarget } from "@regenic/connector-contract";

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

/** Statuses a background observe pass may still retry. Settled rows stay in the table. */
export const WORK_OBSERVE_AGAIN_STATUSES: readonly WorkItemStatus[] = [
  "open",
  "failed",
];

export function isActiveWorkStatus(status: WorkItemStatus): boolean {
  return ACTIVE_WORK_STATUSES.includes(status);
}

export interface RecipeMatch {
  record_class?: RecordClass;
  thread_facet?: ThreadFacet;
  source?: string;
  thread_id?: string;
  /** Opaque connector stamp. Equality only. Not conversation_kind. */
  unit_kind?: string;
  /** Push only: literal, case-insensitive substrings of the triggering body. Both must pass. */
  text_contains?: string;
  text_excludes?: string;
  /**
   * Literal, case-insensitive substrings of the conversation title.
   * Used when a rule watches one app. Both must pass. A missing title does not pass.
   */
  title_contains?: string;
  title_excludes?: string;
}

export const RECIPE_TRIGGER_KINDS = ["push", "pull", "manual"] as const;

export type RecipeTriggerKind = (typeof RECIPE_TRIGGER_KINDS)[number];

export const PULL_INTERVAL_MIN_MS = 60 * 1000;
/** Pure intervals stop at a week. Longer cadences use a clock time. */
export const PULL_INTERVAL_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export const PULL_INTERVAL_MS = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
} as const;

/** Common choices. Any whole minute inside the min/max range is valid. */
export const PULL_INTERVALS_MS = [
  PULL_INTERVAL_MS["15m"],
  PULL_INTERVAL_MS["1h"],
  PULL_INTERVAL_MS["1d"],
] as const;

export interface RecipeTrigger {
  kind: RecipeTriggerKind;
  /**
   * Pull only. Period between occurrences when no clock time is set.
   * Whole minutes, from 1 minute through 7 days.
   */
  interval_ms?: number;
  /**
   * Pull only. Minute of day in `timezone` (0–1439).
   * With `timezone`, runs align to that clock instead of repeating `interval_ms`.
   */
  at_minute?: number;
  /** Pull only. ISO weekdays, Monday = 1. Omit to run every day. */
  weekdays?: number[];
  /** Pull only. IANA zone for `at_minute`. */
  timezone?: string;
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
  /** Optional fixed destination; omitted means the conversation that triggered the work. */
  write_back_thread_id?: string;
  /** Hide source and executor conversations after a successful run. */
  hide_on_success: boolean;
  /** Kernel evidence: send visible thread history, not just the head. */
  include_context: boolean;
  /**
   * Auto-start cap for this recipe. Counts `running` + `waiting_human`.
   * Omit for unlimited. Does not gate ingest or opening WorkItems.
   */
  max_concurrent?: number;
  enabled: boolean;
  /** Pull only. Next wall-clock fire. Survives sleep and restart. */
  next_run_at?: string;
  created_at: string;
  updated_at: string;
}

export interface RecipePullScheduleAdvance {
  expected_recipe: Recipe;
  next_run_at: string;
  updated_at: string;
}

export interface RecipeWrite {
  recipe: Recipe;
  expected_recipe: Recipe | null;
}

export type RecipeWriteResult =
  | { outcome: "applied"; recipe: Recipe }
  | { outcome: "conflict" };

export interface WorkItem {
  id: string;
  org_id: string;
  thread_id: string;
  /** Work-unit identity. A session may have many jobs over time. */
  unit_key: string;
  /** Persisted row version; omitted only by pre-migration callers and fixtures. */
  version?: number;
  /** Explicit current attempt. Historical rows with no pointer remain unknown. */
  current_run_id?: string;
  /** The exact completed or failed run a user acknowledged. */
  acknowledged_run_id?: string;
  /** Manual visibility version captured when this work attempt was reserved. */
  visibility_intent_version?: number;
  head_event_id?: string;
  record_class: RecordClass;
  thread_facet: ThreadFacet;
  status: WorkItemStatus;
  recipe_id?: string;
  created_at: string;
  updated_at: string;
}

export type WorkItemIdentityDiagnosticReason =
  | "missing_current_run"
  | "current_run_not_found"
  | "current_run_identity_mismatch"
  | "current_run_recipe_mismatch"
  | "current_run_not_active";

export interface WorkItemIdentityDiagnostic {
  work_item_id: string;
  thread_id: string;
  unit_key: string;
  item_status: WorkItemStatus;
  current_run_id?: string;
  reason: WorkItemIdentityDiagnosticReason;
  candidate_run_ids: string[];
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
  "uncertain",
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
  version?: number;
  run_id?: string;
  target?: WorkWriteBackTarget;
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
  lease_owner?: string;
  claim_token?: string;
  cancel_requested_at?: string;
  created_at: string;
  updated_at: string;
}

export interface WorkDeliveryFace {
  id: string;
  version: number;
  status: WorkDeliveryStatus;
  write_back: WorkWriteBackState;
  attempts: number;
  last_error?: string;
}

export type WorkDeliveryRetrySnapshot = Pick<
  WorkDelivery,
  "id" | "status" | "write_back" | "attempts"
> & { version: number };

export interface WorkFace {
  id: string;
  status: WorkItemStatus;
  version: number;
  start_state?: WorkRun["start_state"];
  recipe_id?: string;
  executor_type?: string;
  run_id?: string;
  run_version?: number;
  acknowledged_run_id?: string;
  agent_thread_id?: string;
  auto_completed?: boolean;
  head_event_id?: string;
  can_write_back?: boolean;
  has_result?: boolean;
  result_summary?: string;
  delivery?: WorkDeliveryFace;
  updated_at?: string;
}

export interface WorkRunStartClaim {
  run: WorkRun & { status: "running"; start_state: "pending" };
  /** Recipe configuration used to prepare the execution; validated in the reservation transaction. */
  expected_recipe?: Recipe;
  /** Required for retries; omitted only by legacy open-item callers. */
  expected_item?: WorkItem;
  /** Client-observed version for an explicit start command. */
  expected_version?: number;
  command_id?: string;
  issued_at?: string;
  /** Retry eligibility is applied inside the same transaction as the new run. */
  retry?: "automatic" | "manual";
  /** Bind the selected rule only when the expected item is atomically reserved. */
  rebind?: "automatic" | "manual";
  /** Auto-start limit; manual starts may omit it. */
  max_concurrent?: number;
  /** Recheck a message-triggered auto-start against durable disposition at reservation time. */
  require_current_work_trigger?: boolean;
  /** Conversation visibility version read before reservation; validated in the claim transaction. */
  visibility_intent_version?: number;
}

export interface WorkRunStartCommand {
  org_id: string;
  work_item_id: string;
  expected_version: number;
  command_id: string;
  issued_at: string;
}

export type WorkRunStartReplay =
  | { outcome: "not_found" }
  | { outcome: "replayed"; run: WorkRun }
  | { outcome: "conflict" };

export type CancellationJobStatus = "pending" | "running" | "succeeded" | "failed" | "dead";

export interface CancellationJob {
  id: string;
  org_id: string;
  event_id: string;
  job_type: "cancel_execution";
  run_id: string;
  schema_version: number;
  status: CancellationJobStatus;
  attempts: number;
  lease_owner?: string;
  claim_token?: string;
  lease_expires_at?: string;
  next_retry_at?: string;
  last_error_code?: string;
  last_error?: string;
  outcome_code?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
}

export interface RetryCancellationJob {
  org_id: string;
  id: string;
  expected_attempts: number;
  command_id: string;
  issued_at: string;
}

export type RetryCancellationJobResult =
  | { outcome: "applied"; job: CancellationJob }
  | { outcome: "replayed"; job: CancellationJob }
  | { outcome: "not_found" }
  | { outcome: "conflict" };

export interface ClaimCancellationJobs {
  org_id: string;
  owner: string;
  now: string;
  lease_ms: number;
  limit: number;
}

export interface RenewCancellationJob {
  org_id: string;
  id: string;
  owner: string;
  claim_token: string;
  now: string;
  lease_ms: number;
}

export type SettleCancellationJob =
  | {
      kind: "succeeded";
      org_id: string;
      id: string;
      owner: string;
      claim_token: string;
      now: string;
      outcome_code: string;
    }
  | {
      kind: "failed";
      org_id: string;
      id: string;
      owner: string;
      claim_token: string;
      now: string;
      next_retry_at: string;
      error_code: string;
      error: string;
    };

export interface CommitCancellationJobObservation {
  org_id: string;
  id: string;
  owner: string;
  claim_token: string;
  expected_run: WorkRun;
  handle: ExecutorRunHandle;
  now: string;
}

export type CommitCancellationJobObservationResult =
  | { outcome: "applied"; run: WorkRun }
  | { outcome: "already_terminal"; run: WorkRun }
  | { outcome: "conflict" };

export interface WorkStore {
  listRecipes(orgId: string): Promise<Recipe[]>;
  getRecipe(orgId: string, id: string): Promise<Recipe | null>;
  putRecipe(recipe: Recipe): Promise<Recipe>;
  putRecipeIfUnchanged(input: RecipeWrite): Promise<RecipeWriteResult>;
  advanceRecipePullSchedule(input: RecipePullScheduleAdvance): Promise<boolean>;
  deleteRecipe(orgId: string, id: string): Promise<boolean>;
  listWorkItems(
    orgId: string,
    options?: { statuses?: readonly WorkItemStatus[] },
  ): Promise<WorkItem[]>;
  getWorkItem(orgId: string, id: string): Promise<WorkItem | null>;
  /** Foreground job on the session, not a unique thread identity. */
  getWorkItemByThread(
    orgId: string,
    threadId: string,
  ): Promise<WorkItem | null>;
  getWorkItemByUnitKey(
    orgId: string,
    threadId: string,
    unitKey: string,
  ): Promise<WorkItem | null>;
  /** Create without overwriting existing work; compare-and-set its recipe in the same commit. */
  createWorkItem(input: WorkItemCreation): Promise<WorkItemCreationResult>;
  /** Atomically apply an ingested event's open-item creation or coalescing update. */
  observeWorkItem(input: WorkItemObservation): Promise<WorkItemObservationResult>;
  /** Remove only a fresh, unreserved preparation and its optional answer metadata. */
  abortWorkItemCreation(input: WorkItemCreationAbort): Promise<WorkItemCreationAbortResult>;
  listWorkRuns(orgId: string, workItemId?: string): Promise<WorkRun[]>;
  getWorkRun(orgId: string, id: string): Promise<WorkRun | null>;
  /** Resolves only current_run_id; NULL historical identity is never guessed from timestamps. */
  getActiveWorkRun(
    orgId: string,
    workItemId: string,
  ): Promise<WorkRun | null>;
  /** Executor sessions that are not themselves a work thread. */
  listHiddenExecutorThreadIds(orgId: string): Promise<string[]>;
  /** Finds an already-reserved manual start command without starting or refreshing its executor. */
  getWorkRunStartReplay(command: WorkRunStartCommand): Promise<WorkRunStartReplay>;
  claimCancellationJobs(input: ClaimCancellationJobs): Promise<CancellationJob[]>;
  renewCancellationJob(input: RenewCancellationJob): Promise<boolean>;
  settleCancellationJob(input: SettleCancellationJob): Promise<boolean>;
  commitCancellationJobObservation(
    input: CommitCancellationJobObservation,
  ): Promise<CommitCancellationJobObservationResult>;
  listCancellationJobs(
    orgId: string,
    limit?: number,
    statuses?: CancellationJobStatus[],
  ): Promise<CancellationJob[]>;
  retryCancellationJob(input: RetryCancellationJob): Promise<RetryCancellationJobResult>;
  /** Atomically reserve the expected eligible item and persist its run before external start. */
  claimWorkRunStart(input: WorkRunStartClaim): Promise<boolean>;
  /** Atomically checkpoint a current reserved start and its matching item status. */
  checkpointWorkRunStart(input: WorkRunStartCheckpoint): Promise<WorkRunStartCheckpointResult>;
  recordWorkRunStartFailure(input: WorkRunStartFailure): Promise<WorkRunStartFailureResult>;
  dismissWorkItem(input: WorkDismissal): Promise<WorkDismissalResult>;
  acknowledgeWorkResult(input: WorkAcknowledgment): Promise<WorkAcknowledgmentResult>;
  /** Atomically apply an observed run, work status and compatible delivery change. */
  commitWorkObservation(input: CommitWorkObservation): Promise<CommitWorkObservationResult>;
  listWorkDeliveries(orgId: string): Promise<WorkDelivery[]>;
  /** Sendable deliveries and expired claims to recover; unknown acceptance without a receipt stays out. */
  listDueWorkDeliveries(orgId: string, now: string): Promise<WorkDelivery[]>;
  getWorkDelivery(orgId: string, id: string): Promise<WorkDelivery | null>;
  getWorkDeliveryByItem(
    orgId: string,
    workItemId: string,
  ): Promise<WorkDelivery | null>;
  /** Atomic claim, fenced settlement, expiry recovery or cancellation of one delivery. */
  transitionWorkDelivery(input: WorkDeliveryCommand): Promise<WorkDeliveryCommandResult>;
  getUiPref(orgId: string, key: string): Promise<string | null>;
  putUiPref(
    orgId: string,
    key: string,
    value: string,
    updatedAt: string,
  ): Promise<void>;
  getSearchAnswer(
    orgId: string,
    id: string,
  ): Promise<SearchAnswerRecord | null>;
  putSearchAnswer(record: SearchAnswerRecord): Promise<SearchAnswerRecord>;
  deleteSearchAnswer(orgId: string, id: string): Promise<boolean>;
  getAggregateFactCache(
    orgId: string,
    specHash: string,
    extractorVersion: string,
    eventIds: readonly string[],
  ): Promise<import("./search-answer").AggregateFactCacheRecord[]>;
  putAggregateFactCache(
    records: readonly import("./search-answer").AggregateFactCacheRecord[],
  ): Promise<void>;
}

export type WorkDeliveryCommand = {
  org_id: string;
  delivery_id: string;
  now: string;
} & (
  | {
      kind: "retry";
      expected_delivery: WorkDeliveryRetrySnapshot;
      expected_item_version: number;
      command_id: string;
      issued_at: string;
    }
  | {
      kind: "reconcile";
      resolution: "sent" | "not_sent";
      expected_delivery: WorkDeliveryRetrySnapshot;
      expected_item_version: number;
      command_id: string;
      issued_at: string;
    }
  | { kind: "claim"; owner: string; force?: boolean }
  | { kind: "expire" }
  | { kind: "cancel" }
  | {
      kind: "receipt" | "sent" | "skipped" | "failed" | "uncertain" | "renew";
      owner: string;
      token: string;
      receipt?: { accepted: boolean; rpc_id?: string };
      error?: string;
    }
);

export type WorkDeliveryCommandResult =
  | { outcome: "applied"; delivery: WorkDelivery }
  | { outcome: "replayed"; delivery: WorkDelivery }
  | { outcome: "conflict"; reason: "missing_delivery" | "not_claimable" | "stale_claim" | "receipt_conflict" };
