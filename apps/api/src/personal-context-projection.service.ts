import { randomUUID } from "node:crypto";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  searchInProgress,
  yieldToEventLoop,
  type ContextProjectionJob,
  type ContextProjectionOutboxStore,
  type ContextProjectionRunner,
  type EventRecord,
} from "@regenic/domain";
import { PersonalRuntimeService } from "./personal-runtime.service";
import { KernelRuntimeService } from "./kernel-runtime.service";
import {
  loadOrgSyncPhaseIndex,
  shouldDeferProjectionForPhase,
  syncPhaseFromIndex,
} from "./personal-sync-phase";
import { backgroundSyncReleased } from "./personal-interactive-gate";

const PROJECTION_TICK_MS = 2_000;
const PROJECTION_LEASE_MS = 30_000;
/** Store claim cap. A full claim means the queue still has more. */
const PROJECTION_CLAIM_LIMIT = 100;
/**
 * Do not start another claim after this. Jobs already claimed are indexed in
 * small chunks that yield, and their lease is renewed until they settle.
 * The idle timer still waits PROJECTION_TICK_MS once a claim comes back short.
 */
const PROJECTION_SLICE_MS = 80;
/** Bound a search's wait for messages that are committed but not yet indexed. */
const SEARCH_CATCHUP_MS = 1_000;
/** Let the event loop run between lexical writes of one claimed batch. */
const PROJECTION_LEXICAL_CHUNK = 8;
const PROJECTION_HEARTBEAT_MS = 10_000;
const PROJECTION_GENERATION = "continuous-v2";
const MAX_RETRY_MS = 5 * 60_000;

@Injectable()
export class PersonalContextProjectionService implements OnModuleDestroy {
  private readonly owner = `context-projection-worker:${randomUUID()}`;
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private running = false;
  private stopping = false;
  private bootstrapped = false;
  private resumeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
    @Inject(KernelRuntimeService)
    private readonly kernelRuntime: KernelRuntimeService,
  ) {}

  startAfterListen(): void {
    if (this.started) {
      return;
    }
    this.stopping = false;
    this.started = true;
    this.timer = setInterval(() => void this.runOnce(), PROJECTION_TICK_MS);
    void this.runOnce();
  }

  stopBackground(): void {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer);
      this.resumeTimer = undefined;
    }
    this.started = false;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopBackground();
  }

  /**
   * Index pending outbox jobs before a search reads them. The background
   * worker stays paused until the first UI read, so this is the only way a
   * search issued in that window can see a message that was just committed.
   * Text-version maintenance stays on the background worker.
   */
  async catchUpForSearch(now = new Date()): Promise<void> {
    const deadline = Date.now() + SEARCH_CATCHUP_MS;
    while (!this.stopping && Date.now() < deadline) {
      if (this.running) {
        await yieldToEventLoop();
        continue;
      }
      const more = await this.runOnce(now, { catchUp: true });
      if (!more) return;
    }
  }

  async runOnce(now = new Date(), options?: { catchUp?: boolean }): Promise<boolean> {
    const catchUp = options?.catchUp === true;
    if (this.running || this.stopping || !this.runtime.isReady()) {
      return false;
    }
    // Search and projection share one authority reader. Yield the slice
    // instead of waiting behind each other. The outbox keeps the jobs.
    // A search catch-up is that search, so it does not yield to itself.
    if (!catchUp && this.shouldYield()) {
      return false;
    }
    this.running = true;
    const deadline = Date.now() + (catchUp ? SEARCH_CATCHUP_MS : PROJECTION_SLICE_MS);
    const held: ContextProjectionJobGroup[] = [];
    const leased: ContextProjectionJob[] = [];
    let more = false;
    let yielded = false;
    let outbox: ContextProjectionOutboxStore | undefined;
    let heartbeat: ProjectionLeaseHeartbeat | undefined;
    try {
      const host = this.runtime.requireHost();
      const authority = host.get("authority");
      outbox = host.get("context-projection-outbox") as ContextProjectionOutboxStore;
      const runner = host.get("context-projections") as ContextProjectionRunner;
      heartbeat = startProjectionLeaseHeartbeat(outbox, () => leased, this.owner);
      if (!catchUp && !this.bootstrapped) {
        await this.advanceLexicalMaintenance(runner);
      }
      const phaseIndexByOrg = new Map<
        string,
        Awaited<ReturnType<typeof loadOrgSyncPhaseIndex>>
      >();
      while (!this.stopping && Date.now() < deadline) {
        if (!catchUp && this.shouldYield()) {
          yielded = true;
          break;
        }
        const claimed = await outbox.claimContextProjectionJobs({
          owner: this.owner,
          now: now.toISOString(),
          lease_ms: PROJECTION_LEASE_MS,
          limit: PROJECTION_CLAIM_LIMIT,
        });
        leased.push(...claimed);
        if (claimed.length === 0) {
          if (!catchUp && !this.bootstrapped && Date.now() < deadline) {
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
          if (group.thread_id && await this.deferUnseededThread(
            authority,
            outbox,
            phaseIndexByOrg,
            group,
            now,
          )) {
            continue;
          }
          try {
            await indexLexicalChunk(
              runner,
              group,
              PROJECTION_GENERATION,
            );
            held.push(group);
          } catch (error) {
            if (error instanceof ProjectionLeaseLostError) {
              continue;
            }
            await failProjectionJobs(outbox, group.jobs, this.owner);
          }
          await yieldToEventLoop();
        }
        if (claimed.length < PROJECTION_CLAIM_LIMIT) {
          // Caught up with ingest. Use the rest of the slice to publish a
          // text-version walk, then stop until the idle timer.
          if (!catchUp && !this.bootstrapped) {
            more = true;
            continue;
          }
          more = false;
          break;
        }
        more = true;
      }
      if (!catchUp && !yielded && !this.bootstrapped) {
        more = true;
      }
      if (outbox) {
        await this.settleThreads(outbox, runner, held);
      }
    } catch (error) {
      if (!this.stopping) {
        console.error("context projection worker failed", describeProjectionFailure(error));
      }
    } finally {
      await heartbeat?.stop();
      this.running = false;
      if (!catchUp && more && !yielded && !this.stopping) {
        this.continueSoon();
      }
    }
    return more && !yielded;
  }

  private shouldYield(): boolean {
    return !backgroundSyncReleased()
      || this.kernelRuntime.shouldDeferHistorySync()
      || searchInProgress();
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
    // A text-version walk commits one page per call. Search keeps using the
    // rows already written; the next slice continues the walk.
    this.bootstrapped = runner.lexicalMaintenanceIdle
      ? await runner.lexicalMaintenanceIdle(this.runtime.orgId(), PROJECTION_GENERATION)
      : true;
  }

  private async deferUnseededThread(
    authority: Parameters<typeof loadOrgSyncPhaseIndex>[0],
    outbox: ContextProjectionOutboxStore,
    phaseIndexByOrg: Map<string, Awaited<ReturnType<typeof loadOrgSyncPhaseIndex>>>,
    group: ContextProjectionJobGroup,
    now: Date,
  ): Promise<boolean> {
    let phaseIndex = phaseIndexByOrg.get(group.org_id);
    if (!phaseIndex) {
      phaseIndex = await loadOrgSyncPhaseIndex(authority, group.org_id);
      phaseIndexByOrg.set(group.org_id, phaseIndex);
    }
    const phase = syncPhaseFromIndex(phaseIndex, group.thread_id ?? "");
    // History backfill may still run; project whatever is already ingested.
    // Only unseeded streams have no durable face yet.
    if (!shouldDeferProjectionForPhase(phase)) {
      return false;
    }
    const retryAt = new Date(now.getTime() + 5_000).toISOString();
    for (const job of group.jobs) {
      await outbox.failContextProjectionJob({
        id: job.id,
        owner: this.owner,
        failed_at: now.toISOString(),
        next_retry_at: retryAt,
        error_code: "bootstrap_pending",
      });
    }
    return true;
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
        await withProjectionLease(outbox, group.jobs, this.owner, async () => {
          if (group.thread_id) {
            await runner.projectThread(
              group.org_id,
              PROJECTION_GENERATION,
              group.thread_id,
            );
          }
        });
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

interface ProjectionLeaseHeartbeat {
  stop(): Promise<void>;
}

function startProjectionLeaseHeartbeat(
  outbox: ContextProjectionOutboxStore,
  jobs: () => readonly ContextProjectionJob[],
  owner: string,
): ProjectionLeaseHeartbeat {
  let stopped = false;
  let chain = Promise.resolve();
  const timer = setInterval(() => {
    const current = jobs();
    if (current.length === 0 || stopped) {
      return;
    }
    const now = new Date().toISOString();
    chain = chain.then(async () => {
      if (stopped) {
        return;
      }
      await Promise.all(current.map((job) =>
        outbox.renewContextProjectionJob({
          id: job.id,
          owner,
          now,
          lease_ms: PROJECTION_LEASE_MS,
        }),
      ));
    }).catch(() => undefined);
  }, PROJECTION_HEARTBEAT_MS);
  timer.unref?.();
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await chain;
    },
  };
}

async function indexLexicalChunk(
  runner: ContextProjectionRunner,
  group: ContextProjectionJobGroup,
  generation: string,
): Promise<void> {
  const ids = group.jobs.map((job) => job.event_id);
  const threadId = group.thread_id ?? undefined;
  for (let offset = 0; offset < ids.length; offset += PROJECTION_LEXICAL_CHUNK) {
    await runner.syncLexicalIndex(
      group.org_id,
      generation,
      ids.slice(offset, offset + PROJECTION_LEXICAL_CHUNK),
      threadId,
    );
    if (offset + PROJECTION_LEXICAL_CHUNK < ids.length) {
      await yieldToEventLoop();
    }
  }
}

async function withProjectionLease<T>(
  outbox: ContextProjectionOutboxStore,
  jobs: ContextProjectionJob[],
  owner: string,
  run: () => Promise<T>,
): Promise<T> {
  let leaseLost = false;
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      const now = new Date().toISOString();
      const renewed = await Promise.all(jobs.map((job) =>
        outbox.renewContextProjectionJob({
          id: job.id,
          owner,
          now,
          lease_ms: PROJECTION_LEASE_MS,
        }),
      ));
      leaseLost = leaseLost || renewed.some((value) => !value);
    }).catch(() => {
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

export interface ContextProjectionJobGroup {
  org_id: string;
  thread_id: string | null;
  jobs: ContextProjectionJob[];
}

export function coalesceProjectionGroups(
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

export async function groupProjectionJobs(
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

export function retryDelay(attempts: number): number {
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
