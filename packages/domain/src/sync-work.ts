import type { JsonValue } from "./ingestion";
import type { SyncLane } from "./sync-contracts";

export type SyncRunMode = "quick_start" | "continuous" | "archive";
export type SyncRunStatus =
  | "queued"
  | "running"
  | "paused"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface SyncRunOptions {
  max_pages?: number;
  stream_keys?: string[];
  archive_from?: string;
  archive_to?: string;
  run_window?: { start_hour: number; end_hour: number; timezone?: string };
  [key: string]: JsonValue | undefined;
}

export interface SyncRun {
  id: string;
  org_id: string;
  installation_id: string;
  mode: SyncRunMode;
  status: SyncRunStatus;
  options: SyncRunOptions;
  total_work: number;
  completed_work: number;
  failed_work: number;
  accepted_count: number;
  started_at?: string;
  finished_at?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface NewSyncRun {
  id: string;
  org_id: string;
  installation_id: string;
  mode: SyncRunMode;
  options?: SyncRunOptions;
  now: string;
}

export interface ListSyncRunsQuery {
  org_id: string;
  installation_id?: string;
  limit?: number;
}

export type SyncRunCommand = "pause" | "resume" | "cancel";

export interface CommandSyncRun {
  id: string;
  org_id: string;
  command: SyncRunCommand;
  now: string;
}

export type SyncWorkStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface SyncWorkRecord {
  id: string;
  run_id?: string;
  installation_id: string;
  stream_key: string;
  lane: SyncLane;
  priority: number;
  next_due_at: string;
  status: SyncWorkStatus;
  attempts: number;
  generation: number;
  lease_owner?: string;
  lease_expires_at?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface EnqueueSyncWork {
  id: string;
  run_id?: string;
  installation_id: string;
  stream_key: string;
  lane: SyncLane;
  priority?: number;
  next_due_at: string;
  generation: number;
  now: string;
}

export interface ClaimSyncWork {
  owner: string;
  now: string;
  lease_ms: number;
  limit: number;
  work_id?: string;
  installation_id?: string;
  lanes?: SyncLane[];
  /** Background planner rows only; never steal a user-visible sync run. */
  unassigned?: boolean;
}

export interface RenewSyncWork {
  id: string;
  owner: string;
  now: string;
  lease_ms: number;
}

export type SyncWorkOutcome = "succeeded" | "retry" | "failed" | "cancelled";

export interface SettleSyncWork {
  id: string;
  owner: string;
  now: string;
  outcome: SyncWorkOutcome;
  accepted_count?: number;
  next_due_at?: string;
  error_code?: string;
}

export interface UnassignedSyncWorkQuery {
  installation_id?: string;
  lanes?: SyncLane[];
}

export interface SyncWorkIdentity {
  stream_key: string;
  lane: SyncLane;
  generation: number;
}

export interface WakeUnassignedSyncWork {
  installation_id: string;
  stream_keys: readonly string[];
  now: string;
}

export interface SyncWorkStore {
  createSyncRun(input: NewSyncRun): Promise<SyncRun>;
  getSyncRun(id: string, orgId: string): Promise<SyncRun | null>;
  listSyncRuns(query: ListSyncRunsQuery): Promise<SyncRun[]>;
  commandSyncRun(input: CommandSyncRun): Promise<SyncRun | null>;
  enqueueSyncWork(input: EnqueueSyncWork): Promise<SyncWorkRecord>;
  enqueueSyncWorkMany(inputs: readonly EnqueueSyncWork[]): Promise<number>;
  claimSyncWork(input: ClaimSyncWork): Promise<SyncWorkRecord[]>;
  renewSyncWork(input: RenewSyncWork): Promise<boolean>;
  settleSyncWork(input: SettleSyncWork): Promise<SyncWorkRecord | null>;
  hasUnassignedSyncWork(query?: UnassignedSyncWorkQuery): Promise<boolean>;
  listUnassignedSyncWorkIdentities(
    query: Pick<UnassignedSyncWorkQuery, "installation_id"> & {
      installation_id: string;
    },
  ): Promise<SyncWorkIdentity[]>;
  wakeUnassignedSyncWork(input: WakeUnassignedSyncWork): Promise<number>;
}

export function isUnassignedSyncWork(work: SyncWorkRecord): boolean {
  return (
    !work.run_id && (work.status === "pending" || work.status === "running")
  );
}

export function syncRunIsClaimable(status: SyncRunStatus): boolean {
  return status === "queued" || status === "running";
}

export function syncWorkPriority(lane: SyncLane): number {
  switch (lane) {
    case "interactive":
      return 600;
    case "live":
      return 500;
    case "catalog":
      return 400;
    case "history":
      return 200;
    case "media":
      return 100;
  }
}

export function validateSyncRunOptions(options: SyncRunOptions): void {
  if (
    options.max_pages !== undefined &&
    (!Number.isInteger(options.max_pages) || options.max_pages < 1)
  ) {
    throw new Error("sync run max_pages must be a positive integer");
  }
  if (
    options.stream_keys !== undefined &&
    (!Array.isArray(options.stream_keys) ||
      options.stream_keys.some(
        (streamKey) => typeof streamKey !== "string" || !streamKey.trim(),
      ))
  ) {
    throw new Error("sync run stream_keys must contain non-empty strings");
  }
  if (options.run_window) {
    const { start_hour: start, end_hour: end } = options.run_window;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      start > 23 ||
      end < 0 ||
      end > 23
    ) {
      throw new Error("sync run window hours must be between 0 and 23");
    }
  }
}
