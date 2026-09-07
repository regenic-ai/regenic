export type DailyDigestJobStatus = "pending" | "running" | "succeeded" | "failed";

export interface DailyDigestJob {
  id: string;
  org_id: string;
  utc_date: string;
  generation: string;
  status: DailyDigestJobStatus;
  attempts: number;
  lease_owner?: string;
  lease_expires_at?: string;
  next_retry_at?: string;
  last_error?: string;
  created_at: string;
  updated_at: string;
}

export interface DailyDigestJobStore {
  enqueueDailyDigestJob(input: {
    org_id: string;
    utc_date: string;
    generation: string;
    created_at: string;
  }): Promise<DailyDigestJob>;
  claimDailyDigestJobs(input: {
    owner: string;
    now: string;
    lease_ms: number;
    limit: number;
  }): Promise<DailyDigestJob[]>;
  completeDailyDigestJob(input: {
    id: string;
    owner: string;
    completed_at: string;
  }): Promise<boolean>;
  renewDailyDigestJob(input: {
    id: string;
    owner: string;
    now: string;
    lease_ms: number;
  }): Promise<boolean>;
  failDailyDigestJob(input: {
    id: string;
    owner: string;
    failed_at: string;
    next_retry_at: string;
    error_code: string;
  }): Promise<boolean>;
  listDailyDigestJobs(orgId: string): Promise<DailyDigestJob[]>;
}