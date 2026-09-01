import { randomUUID } from "node:crypto";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import type {
  ContextProjectionJob,
  ContextProjectionOutboxStore,
  ContextProjectionRunner,
} from "@regenic/domain";
import { PersonalRuntimeService } from "./personal-runtime.service";

const PROJECTION_TICK_MS = 2_000;
const PROJECTION_LEASE_MS = 30_000;
const PROJECTION_BATCH_SIZE = 50;
const PROJECTION_GENERATION = "continuous-v1";
const MAX_RETRY_MS = 5 * 60_000;

@Injectable()
export class PersonalContextProjectionService implements OnModuleDestroy {
  private readonly owner = `context-projection-worker:${randomUUID()}`;
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private running = false;
  private stopping = false;

  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
  ) {}

  startAfterListen(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.timer = setInterval(() => void this.runOnce(), PROJECTION_TICK_MS);
    void this.runOnce();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running || this.stopping || !this.runtime.isReady()) {
      return;
    }
    this.running = true;
    try {
      const host = this.runtime.requireHost();
      const outbox = host.get("context-projection-outbox") as ContextProjectionOutboxStore;
      const runner = host.get("context-projections") as ContextProjectionRunner;
      const claimed = await outbox.claimContextProjectionJobs({
        owner: this.owner,
        now: now.toISOString(),
        lease_ms: PROJECTION_LEASE_MS,
        limit: PROJECTION_BATCH_SIZE,
      });
      for (const jobs of groupByOrganization(claimed)) {
        try {
          await runner.project(jobs[0].org_id, PROJECTION_GENERATION);
          const completedAt = new Date().toISOString();
          for (const job of jobs) {
            await outbox.completeContextProjectionJob({
              id: job.id,
              owner: this.owner,
              completed_at: completedAt,
            });
          }
        } catch {
          const failedAt = new Date();
          for (const job of jobs) {
            await outbox.failContextProjectionJob({
              id: job.id,
              owner: this.owner,
              failed_at: failedAt.toISOString(),
              next_retry_at: new Date(failedAt.getTime() + retryDelay(job.attempts)).toISOString(),
              error_code: "projection_failed",
            });
          }
        }
      }
    } catch (error) {
      if (!this.stopping) {
        console.error("context projection worker failed", safeErrorCode(error));
      }
    } finally {
      this.running = false;
    }
  }
}

function groupByOrganization(jobs: ContextProjectionJob[]): ContextProjectionJob[][] {
  const grouped = new Map<string, ContextProjectionJob[]>();
  for (const job of jobs) {
    const values = grouped.get(job.org_id) ?? [];
    values.push(job);
    grouped.set(job.org_id, values);
  }
  return [...grouped.values()];
}

export function retryDelay(attempts: number): number {
  return Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 8));
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return "Error";
}
