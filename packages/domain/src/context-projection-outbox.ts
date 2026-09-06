export type ContextProjectionJobStatus = "pending" | "running" | "succeeded" | "failed";

export interface ContextProjectionJob {
  id: string;
  org_id: string;
  event_id: string;
  status: ContextProjectionJobStatus;
  attempts: number;
  lease_owner?: string;
  lease_expires_at?: string;
  next_retry_at?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface ClaimContextProjectionJobs {
  owner: string;
  now: string;
  lease_ms: number;
  limit: number;
}

export interface CompleteContextProjectionJob {
  id: string;
  owner: string;
  completed_at: string;
}

export interface RenewContextProjectionJob {
  id: string;
  owner: string;
  now: string;
  lease_ms: number;
}

export interface FailContextProjectionJob {
  id: string;
  owner: string;
  failed_at: string;
  next_retry_at: string;
  error_code: string;
}

export interface ContextProjectionOutboxStore {
  claimContextProjectionJobs(input: ClaimContextProjectionJobs): Promise<ContextProjectionJob[]>;
  completeContextProjectionJob(input: CompleteContextProjectionJob): Promise<boolean>;
  renewContextProjectionJob(input: RenewContextProjectionJob): Promise<boolean>;
  failContextProjectionJob(input: FailContextProjectionJob): Promise<boolean>;
  listContextProjectionJobs(orgId: string): Promise<ContextProjectionJob[]>;
  renewContextProjectionJob(input: RenewContextProjectionJob): Promise<boolean>;
}