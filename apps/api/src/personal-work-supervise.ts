import {
  cancelWorkRun,
  deliveryAbandoned,
  foldThreadByPolicy,
  isActiveWorkStatus,
  enqueueWriteBack,
  isAbandonedWorkItem,
  recipeTriggerOf,
  recipeWantsWriteBack,
  shouldWriteBackHandle,
  workStatusFromHandle,
  type ExecutorContext,
  type ExecutorRunHandle,
  type Recipe,
  type TaskExecutor,
  type WorkItem,
  type WorkRun,
} from "@regenic/domain";
import { PersonalWorkChannel } from "./personal-work-channel";
import { PersonalRuntimeService } from "./personal-runtime.service";
import type { PersonalWorkWait } from "./personal-work-wait";
import {
  handleFromInboxEnd,
  isStaleWork,
  shouldForceReap,
  workAgeMs,
  workReapStaleMs,
  WORK_REAP_FOLLOW_COOLDOWN_MS,
  WORK_REAP_LOG_EVERY_MS,
} from "./personal-work-reap";

export class PersonalWorkSupervise {
  private waits?: PersonalWorkWait;
  private readonly lastReapLog = new Map<string, number>();
  private readonly lastFollow = new Map<string, number>();
  /** Per-work-item override for try-once / dry write-back. */
  private readonly writeBackOverride = new Map<string, boolean>();

  constructor(
    private readonly runtime: PersonalRuntimeService,
    private readonly channel: PersonalWorkChannel,
    private readonly touchInboxDigest?: () => void,
  ) {}

  bindWaits(waits: PersonalWorkWait): void {
    this.waits = waits;
  }

  setWriteBackOverride(workItemId: string, value: boolean): void {
    this.writeBackOverride.set(workItemId, value);
  }

  clearWriteBackOverride(workItemId: string): void {
    this.writeBackOverride.delete(workItemId);
  }

  /** Respect try-once keep-here when deciding whether to flush a queued delivery. */
  allowsWriteBack(itemId: string, recipe: Recipe): boolean {
    return this.wantsWriteBack(itemId, recipe);
  }

  private wantsWriteBack(itemId: string, recipe: Recipe): boolean {
    if (this.writeBackOverride.has(itemId)) {
      return this.writeBackOverride.get(itemId) === true;
    }
    return recipeWantsWriteBack(recipe);
  }

  async refreshRuns(): Promise<void> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const items = await host.get("authority").listWorkItems(orgId);
    const active = items
      .filter((item) => item.status === "running" || item.status === "waiting_human")
      .sort((left, right) => left.created_at.localeCompare(right.created_at));
    for (const item of active) {
      const recipe = item.recipe_id
        ? await host.get("authority").getRecipe(orgId, item.recipe_id)
        : null;
      const run = await host.get("authority").getActiveWorkRun(orgId, item.id);
      if (!recipe || !run) {
        continue;
      }
      await this.refreshOne(item, recipe, run);
    }
  }

  async refreshOne(
    item: WorkItem,
    recipe: Recipe,
    run: WorkRun,
  ): Promise<void> {
    const host = this.runtime.requireHost();
    const executor = host.get("executors").get(run.executor_type);
    if (!executor) {
      return;
    }
    const ctx = this.channel.contextFor(executor);
    let handle = await executor.status(run, ctx);
    const now = Date.now();
    if (isStaleWork(item.created_at, now, workReapStaleMs()) && handle.status === "running") {
      handle = await this.reapIfInboxEnded(item, run, handle, executor, ctx, now);
    }
    await this.applyHandle(item, recipe, run, handle);
  }

  private async reapIfInboxEnded(
    item: WorkItem,
    run: WorkRun,
    handle: ExecutorRunHandle,
    executor: TaskExecutor,
    ctx: ExecutorContext,
    now: number,
  ): Promise<ExecutorRunHandle> {
    const sysoutId = run.agent_thread_id ?? run.external_run_id;
    const waitAttached = this.waits?.attached(run.id) ?? false;
    if (!waitAttached) {
      this.waits?.attach(item, run, executor);
    }
    let followed = false;
    const dueFollow =
      !this.lastFollow.has(item.id) ||
      now - (this.lastFollow.get(item.id) ?? 0) >= WORK_REAP_FOLLOW_COOLDOWN_MS;
    if (sysoutId && dueFollow) {
      this.lastFollow.set(item.id, now);
      try {
        followed = (await this.waits?.followSysout(item, run)) ?? false;
      } catch (error) {
        console.error("personal work follow-before-reap failed", error);
      }
      if (followed) {
        handle = await executor.status(run, ctx);
      }
    }
    if (handle.status !== "running" || !sysoutId) {
      this.logReapProbe(item, run, handle, {
        waitAttached,
        followed,
        sysoutId,
        now,
      });
      return handle;
    }
    let scan;
    let transcript;
    try {
      const inspected = await this.channel.inspectSysout(sysoutId);
      scan = inspected.scan;
      transcript = inspected.transcript;
    } catch (error) {
      console.error("personal work transcript inspect failed", error);
      this.logReapProbe(item, run, handle, {
        waitAttached,
        followed,
        sysoutId,
        now,
      });
      return handle;
    }
    const force = shouldForceReap({
      handleStatus: handle.status,
      inboxEnded: scan.inboxEnded,
    });
    this.logReapProbe(item, run, handle, {
      waitAttached,
      followed,
      sysoutId,
      now,
      liveTurn: scan.liveTurn,
      liveActivity: scan.liveActivity,
      inboxEnded: scan.inboxEnded,
      transcriptTurn: transcript?.turn?.state,
      transcriptActivity: transcript?.activity,
      forced: force,
    });
    if (!force) {
      return handle;
    }
    const latest = await executor.status(run, ctx);
    if (latest.status !== "running") {
      return latest;
    }
    return handleFromInboxEnd(run, scan, transcript);
  }

  private logReapProbe(
    item: WorkItem,
    _run: WorkRun,
    handle: ExecutorRunHandle,
    extra: {
      now: number;
      waitAttached: boolean;
      followed: boolean;
      sysoutId?: string;
      liveTurn?: string;
      liveActivity?: string;
      inboxEnded?: boolean;
      transcriptTurn?: string;
      transcriptActivity?: string;
      forced?: boolean;
    },
  ): void {
    const previous = this.lastReapLog.get(item.id) ?? 0;
    if (extra.now - previous < WORK_REAP_LOG_EVERY_MS && extra.forced !== true) {
      return;
    }
    this.lastReapLog.set(item.id, extra.now);
    console.warn("personal work reap probe", {
      work_item_id: item.id,
      status: item.status,
      handle: handle.status,
      age_ms: workAgeMs(item.created_at, extra.now),
      wait_attached: extra.waitAttached,
      followed: extra.followed,
      sysout: extra.sysoutId,
      live_turn: extra.liveTurn,
      live_activity: extra.liveActivity,
      inbox_ended: extra.inboxEnded,
      transcript_turn: extra.transcriptTurn,
      transcript_activity: extra.transcriptActivity,
      forced: extra.forced === true,
    });
  }

  async applyHandle(
    item: WorkItem,
    recipe: Recipe,
    run: WorkRun,
    handle: ExecutorRunHandle,
  ): Promise<void> {
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    if (await this.abandonIfSkipped(item, run)) {
      return;
    }
    const now = new Date().toISOString();
    const nextRun: WorkRun = {
      ...run,
      external_run_id: handle.external_run_id,
      agent_thread_id: handle.agent_thread_id ?? run.agent_thread_id,
      status:
        handle.status === "completed"
          ? "completed"
          : handle.status === "failed"
            ? "failed"
            : handle.status === "waiting_human"
              ? "waiting_human"
              : "running",
      result: handle.result ?? run.result,
      updated_at: now,
    };
    if (await this.abandonIfSkipped(item, nextRun)) {
      return;
    }
    await authority.putWorkRun(nextRun);
    if (await this.abandonIfSkipped(item, nextRun)) {
      return;
    }
    const status = workStatusFromHandle(handle);
    const delivery = await authority.getWorkDeliveryByItem(item.org_id, item.id);
    if (shouldWriteBackHandle(handle, this.wantsWriteBack(item.id, recipe))) {
      if (await this.abandonIfSkipped(item, nextRun)) {
        return;
      }
      await authority.putWorkDelivery(
        enqueueWriteBack({
          org_id: item.org_id,
          work_item_id: item.id,
          recipe_id: recipe.id,
          kind: recipeTriggerOf(recipe).kind,
          unit_key: item.unit_key,
          event_id: item.head_event_id,
          payload: {
            summary: handle.result?.summary ?? "",
            content: handle.result?.content,
          },
          now,
          existing: delivery,
        }),
      );
    } else if (handle.status === "completed" && delivery && delivery.status !== "acked") {
      await authority.putWorkDelivery(deliveryAbandoned(delivery, now));
    }
    if (await this.abandonIfSkipped(item, nextRun)) {
      return;
    }
    if (item.status !== status) {
      await authority.putWorkItem({
        ...item,
        status,
        updated_at: now,
      });
      if (!isActiveWorkStatus(status)) {
        this.writeBackOverride.delete(item.id);
        this.waits?.drop(run.id);
        await foldThreadByPolicy(authority, item.org_id, item.thread_id, now);
        this.touchInboxDigest?.();
      }
    }
  }

  async abandonIfSkipped(item: WorkItem, run: WorkRun): Promise<boolean> {
    const latest = await this.runtime
      .requireHost()
      .get("authority")
      .getWorkItem(item.org_id, item.id);
    if (!isAbandonedWorkItem(latest?.status)) {
      return false;
    }
    if (run.status !== "cancelled") {
      await this.runtime
        .requireHost()
        .get("authority")
        .putWorkRun(cancelWorkRun(run, new Date().toISOString()));
    }
    this.waits?.drop(run.id);
    return true;
  }
}
