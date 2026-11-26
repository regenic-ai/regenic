import { randomUUID } from "node:crypto";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import type {
  ContextProjectionJob,
  ContextProjectionOutboxStore,
  ContextProjectionRunner,
  EventRecord,
} from "@regenic/domain";
import { WorkerRuntimeService } from "./worker-runtime.service";

const PROJECTION_TICK_MS = 2_000;
const PROJECTION_LEASE_MS = 30_000;
/** Store claim cap. A full claim means the queue still has more. */
const PROJECTION_CLAIM_LIMIT = 100;
/** Stay under a typical event-loop yield. Idle waits PROJECTION_TICK_MS once caught up. */
const PROJECTION_SLICE_MS = 80;
const PROJECTION_HEARTBEAT_MS = 10_000;
const PROJECTION_GENERATION = "continuous-v2";
const MAX_RETRY_MS = 5 * 60_000;

@Injectable()
export class ContextProjectionService implements OnModuleDestroy {
  private readonly owner = `context-projection-worker:${randomUUID()}`;
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private running = false;
  private stopping = false;
  private bootstrapped = false;
  private resumeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    @Inject(WorkerRuntimeService)
    private readonly runtime: WorkerRuntimeService,
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
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = undefined;
    }
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running || this.stopping || !this.runtime.isReady()) {
      return;
    }
    this.running = true;
    try {
      const host = this.runtime.requireHost();
      const authority = host.get("authority");
      const outbox = host.get("context-projection-outbox") as ContextProjectionOutboxStore;
      const runner = host.get("context-projections") as ContextProjectionRunner;
      if (!this.bootstrapped) {
        await this.advanceLexicalMaintenance(runner);
      }
      const held: ContextProjectionJobGroup[] = [];
      const deadline = Date.now() + PROJECTION_SLICE_MS;
      let more = !this.bootstrapped;
      while (!this.stopping && Date.now() < deadline) {
        const claimed = await outbox.claimContextProjectionJobs({
          owner: this.owner,
          now: now.toISOString(),
          lease_ms: PROJECTION_LEASE_MS,
          limit: PROJECTION_CLAIM_LIMIT,
        });
        if (claimed.length === 0) {
          if (!this.bootstrapped && Date.now() < deadline) {
            await this.advanceLexicalMaintenance(runner);
            if (!this.bootstrapped) {
              more = true;
              continue;
            }
          }
          more = false;
          break;
        }
        const groups = await groupProjectionJobs(claimed, (orgId, eventId) =>
          authority.getEvent(orgId, eventId),
        );
        for (const group of groups) {
          if (!group.thread_id) {
            held.push(group);
            continue;
          }
          try {
            await runner.syncLexicalIndex(
              group.org_id,
              PROJECTION_GENERATION,
              group.jobs.map((job) => job.event_id),
              group.thread_id,
            );
            held.push(group);
          } catch {
            await failProjectionJobs(outbox, group.jobs, this.owner);
          }
        }
        if (claimed.length < PROJECTION_CLAIM_LIMIT) {
          if (!this.bootstrapped) {
            more = true;
            continue;
          }
          more = false;
          break;
        }
        more = true;
      }
      if (!this.bootstrapped) {
        more = true;
      }
      await this.settleThreads(outbox, runner, held);
      if (more && !this.stopping) {
        this.continueSoon();
      }
    } catch (error) {
      if (!this.stopping) {
        console.error("context projection worker failed", describeProjectionFailure(error));
      }
    } finally {
      this.running = false;
    }
  }

  private continueSoon(): void {
    if (this.stopping || this.resumeTimer) {
      return;
    }
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = undefined;
      void this.runOnce();
    }, 0);
  }

  private async advanceLexicalMaintenance(runner: ContextProjectionRunner): Promise<void> {
    await runner.syncLexicalIndex(this.runtime.orgId(), PROJECTION_GENERATION);
    this.bootstrapped = runner.lexicalMaintenanceIdle
      ? await runner.lexicalMaintenanceIdle(this.runtime.orgId(), PROJECTION_GENERATION)
      : true;
  }

  private async settleThreads(
    outbox: ContextProjectionOutboxStore,
    runner: ContextProjectionRunner,
    held: ContextProjectionJobGroup[],
  ): Promise<void> {
    for (const group of coalesceProjectionGroups(held)) {
      if (this.stopping) {
        return;
      }
      try {
        if (group.thread_id) {
          await withProjectionLease(outbox, group.jobs, this.owner, async () => {
            await runner.projectThread(
              group.org_id,
              PROJECTION_GENERATION,
              group.thread_id!,
            );
          });
        }
        const completedAt = new Date().toISOString();
        for (const job of group.jobs) {
          const completed = await outbox.completeContextProjectionJob({
            id: job.id,
            owner: this.owner,
            completed_at: completedAt,
          });
          if (!completed) {
            throw new ProjectionLeaseLostError();
          }
        }
      } catch (error) {
        if (error instanceof ProjectionLeaseLostError) {
          continue;
        }
        await failProjectionJobs(outbox, group.jobs, this.owner);
      }
    }
  }
}

class ProjectionLeaseLostError extends Error {}

async function withProjectionLease<T>(
  outbox: ContextProjectionOutboxStore,
  jobs: ContextProjectionJob[],
  owner: string,
  run: () => Promise<T>,
): Promise<T> {
  let leaseLost = false;
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat
      .then(async () => {
        const now = new Date().toISOString();
        const renewed = await Promise.all(
          jobs.map((job) =>
            outbox.renewContextProjectionJob({
              id: job.id,
              owner,
              now,
              lease_ms: PROJECTION_LEASE_MS,
            }),
          ),
        );
        leaseLost = leaseLost || renewed.some((value) => !value);
      })
      .catch(() => {
        leaseLost = true;
      });
  }, PROJECTION_HEARTBEAT_MS);
  try {
    const value = await run();
    await heartbeat;
    if (leaseLost) {
      throw new ProjectionLeaseLostError();
    }
    return value;
  } finally {
    clearInterval(timer);
  }
}

function coalesceProjectionGroups(
  groups: ContextProjectionJobGroup[],
): ContextProjectionJobGroup[] {
  const merged = new Map<string, ContextProjectionJobGroup>();
  for (const group of groups) {
    const key = group.thread_id
      ? `${group.org_id}\u0000${group.thread_id}`
      : `${group.org_id}\u0000${group.jobs.map((job) => job.id).join("\u0000")}`;
    const current = merged.get(key);
    if (current) {
      current.jobs.push(...group.jobs);
      continue;
    }
    merged.set(key, {
      org_id: group.org_id,
      thread_id: group.thread_id,
      jobs: [...group.jobs],
    });
  }
  return [...merged.values()];
}

async function failProjectionJobs(
  outbox: ContextProjectionOutboxStore,
  jobs: ContextProjectionJob[],
  owner: string,
): Promise<void> {
  const failedAt = new Date();
  for (const job of jobs) {
    await outbox.failContextProjectionJob({
      id: job.id,
      owner,
      failed_at: failedAt.toISOString(),
      next_retry_at: new Date(failedAt.getTime() + retryDelay(job.attempts)).toISOString(),
      error_code: "projection_failed",
    });
  }
}

interface ContextProjectionJobGroup {
  org_id: string;
  thread_id: string | null;
  jobs: ContextProjectionJob[];
}

async function groupProjectionJobs(
  jobs: ContextProjectionJob[],
  getEvent: (orgId: string, eventId: string) => Promise<EventRecord | null>,
): Promise<ContextProjectionJobGroup[]> {
  const grouped = new Map<string, ContextProjectionJobGroup>();
  for (const job of jobs) {
    const event = await getEvent(job.org_id, job.event_id);
    const threadId = event?.thread_id?.trim() || null;
    const key = `${job.org_id}\u0000${threadId ?? job.event_id}`;
    const current = grouped.get(key);
    if (current) {
      current.jobs.push(job);
      continue;
    }
    grouped.set(key, {
      org_id: job.org_id,
      thread_id: threadId,
      jobs: [job],
    });
  }
  return [...grouped.values()];
}

function retryDelay(attempts: number): number {
  return Math.min(MAX_RETRY_MS, 1_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 8));
}

function describeProjectionFailure(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Error";
  }
  const message = error.message.trim();
  if (!message || message === error.name) {
    return error.name || "Error";
  }
  return `${error.name}: ${message}`;
}
