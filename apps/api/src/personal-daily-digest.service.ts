import { randomUUID } from "node:crypto";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  CONTEXT_DAILY_DIGEST_ALGORITHM_VERSION,
  DEFAULT_DAILY_DIGEST_POLICY,
  localDateAt,
  type DailyDigestPolicyStore,
  type DailyDigestJobStore,
  type DailyDigestProjectionRunner,
} from "@regenic/domain";
import { PersonalRuntimeService } from "./personal-runtime.service";
import { backgroundSyncReleased } from "./personal-interactive-gate";

const TICK_MS = 60_000;
const LEASE_MS = 30_000;
const HEARTBEAT_MS = 10_000;
const BATCH_SIZE = 5;
const CATCH_UP_DAYS = 7;
const MAX_RETRY_MS = 5 * 60_000;

@Injectable()
export class PersonalDailyDigestService implements OnModuleDestroy {
  private readonly owner = `daily-digest-worker:${randomUUID()}`;
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private running = false;
  private stopping = false;

  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
  ) {}

  startAfterListen(): void {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => void this.runOnce(), TICK_MS);
    void this.runOnce();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running || this.stopping || !this.runtime.isReady() || !backgroundSyncReleased()) return;
    this.running = true;
    try {
      const host = this.runtime.requireHost();
      const jobs = host.get("daily-digest-jobs") as DailyDigestJobStore;
      const policy = await (host.get("daily-digest-policy") as DailyDigestPolicyStore)
        .getDailyDigestPolicy(this.runtime.orgId()) ?? DEFAULT_DAILY_DIGEST_POLICY;
      const at = now.toISOString();
      await jobs.enqueueDailyDigestCatchUp({
        org_id: this.runtime.orgId(),
        through_utc_date: localDateAt(now, policy.time_zone),
        generation: CONTEXT_DAILY_DIGEST_ALGORITHM_VERSION,
        created_at: at,
        max_days: CATCH_UP_DAYS,
      });
      const claimed = await jobs.claimDailyDigestJobs({
        owner: this.owner, now: at, lease_ms: LEASE_MS, limit: BATCH_SIZE,
      });
      const runner = host.get("context-daily-digests") as DailyDigestProjectionRunner;
      for (const job of claimed) {
        try {
          await withDailyDigestLease(jobs, job.id, this.owner, async () => {
            await runner.projectDailyDigest({
              org_id: job.org_id, utc_date: job.utc_date, generation: job.generation,
            });
          });
          await jobs.completeDailyDigestJob({ id: job.id, owner: this.owner, completed_at: at });
        } catch (error) {
          if (error instanceof DailyDigestLeaseLostError) continue;
          await jobs.failDailyDigestJob({
            id: job.id,
            owner: this.owner,
            failed_at: at,
            next_retry_at: new Date(now.getTime() + retryDelay(job.attempts)).toISOString(),
            error_code: error instanceof Error && error.name ? error.name : "Error",
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}

class DailyDigestLeaseLostError extends Error {}

async function withDailyDigestLease<T>(
  jobs: DailyDigestJobStore,
  jobId: string,
  owner: string,
  run: () => Promise<T>,
): Promise<T> {
  let leaseLost = false;
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      const renewed = await jobs.renewDailyDigestJob({
        id: jobId,
        owner,
        now: new Date().toISOString(),
        lease_ms: LEASE_MS,
      });
      leaseLost = leaseLost || !renewed;
    }).catch(() => {
      leaseLost = true;
    });
  }, HEARTBEAT_MS);
  try {
    const value = await run();
    await heartbeat;
    if (leaseLost) throw new DailyDigestLeaseLostError();
    return value;
  } finally {
    clearInterval(timer);
  }
}

export function retryDelay(attempts: number): number {
  return Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 8));
}