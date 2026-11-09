import {
  recipeTriggerOf,
  recipeWantsWriteBack,
  workRunNeedsStartConfirmation,
  type ExecutorContext,
  type ExecutorRunHandle,
  type Recipe,
  type TaskExecutor,
  type WorkItem,
  type WorkRun,
} from "@regenic/domain";
import { PersonalWorkChannel } from "./personal-work-channel";
import { foldFinishedWorkThreads } from "./personal-work-lifecycle";
import { PersonalRuntimeService } from "./personal-runtime.service";
import type { PersonalWorkWait } from "./personal-work-wait";
import { isWorkTickShutdown } from "./personal-work-support";
import {
  handleFromInboxEnd,
  isStaleWork,
  shouldForceReap,
  workAgeMs,
  workReapStaleMs,
  WORK_REAP_FOLLOW_COOLDOWN_MS,
  WORK_REAP_LOG_EVERY_MS,
} from "./personal-work-reap";
import { isSystemRecipeId } from "./personal-system-work";
import { PersonalConnectorError } from "./personal-errors";

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
    private readonly workUpdated?: (workItemId: string) => void,
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
    const items = await host.get("authority").listWorkItems(orgId, {
      statuses: ["running", "waiting_human", "skipped"],
    });
    const active = [...items].sort((left, right) =>
      left.created_at.localeCompare(right.created_at),
    );
    for (const item of active) {
      const recipe = item.recipe_id
        ? await host.get("authority").getRecipe(orgId, item.recipe_id)
        : null;
      const run = await host.get("authority").getActiveWorkRun(orgId, item.id);
      if (recipe && !run && !item.current_run_id) {
        console.error("personal work current run requires reconciliation", {
          org_id: orgId,
          work_item_id: item.id,
          code: "execution_identity_unknown",
        });
      }
      if (!run || (!recipe && run.write_back_required === undefined)) {
        continue;
      }
      try {
        await this.refreshOne(item, recipe, run);
      } catch (error) {
        if (isWorkTickShutdown(error)) {
          throw error;
        }
        console.error("personal work run refresh failed", {
          org_id: orgId,
          work_item_id: item.id,
          run_id: run.id,
          executor_type: run.executor_type,
        }, error);
      }
    }
  }

  async refreshOne(
    item: WorkItem,
    recipe: Recipe | null,
    run: WorkRun,
  ): Promise<void> {
    if (workRunNeedsStartConfirmation(run)) {
      return;
    }
    if (item.status === "skipped" && !run.external_run_id) {
      console.error("personal work ignored execution requires reconciliation", {
        org_id: item.org_id, work_item_id: item.id, run_id: run.id,
        code: "execution_identity_unknown",
      });
      return;
    }
    const host = this.runtime.requireHost();
    const executor = host.get("executors").get(run.executor_type);
    if (!executor) {
      return;
    }
    const ctx = this.channel.contextFor(executor);
    let handle = await executor.status(run, ctx);
    const now = Date.now();
    if (item.status !== "skipped" && isStaleWork(item.created_at, now, workReapStaleMs()) && handle.status === "running") {
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
    recipe: Recipe | null,
    run: WorkRun,
    handle: ExecutorRunHandle,
  ): Promise<void> {
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    const now = new Date().toISOString();
    const triggerKind = run.trigger_kind ?? (recipe ? recipeTriggerOf(recipe).kind : undefined);
    if (!triggerKind) throw new Error("Historical execution requires recipe reconciliation");
    const result = await authority.commitWorkObservation({
      expected_item: item,
      expected_run: run,
      handle,
      can_write_back: run.write_back_required ?? (recipe ? this.wantsWriteBack(item.id, recipe) : false),
      trigger_kind: triggerKind,
      now,
    });
    if (result.outcome === "ignored") {
      this.waits?.drop(run.id);
      return;
    }
    if (result.outcome === "conflict") {
      throw new PersonalConnectorError(
        "execution_observation_conflict",
        result.reason === "completed_result_changed"
          ? "Completed work results are immutable. Start a new attempt to change the result."
          : "Work changed while its executor was being observed. Refresh the work item before applying another observation.",
        409,
      );
    }
    const { transition } = result;
    const nextRun = transition.run;
    if (transition.item.status === "skipped" && item.status === "skipped") {
      this.waits?.drop(run.id);
      this.writeBackOverride.delete(item.id);
      if (transition.changed) this.workUpdated?.(item.id);
      return;
    }
    if (transition.settled) {
      this.writeBackOverride.delete(item.id);
      this.waits?.drop(run.id);
      if (!isSystemRecipeId(run.recipe_id)) {
        await foldFinishedWorkThreads(
          authority,
          item.org_id,
          item.thread_id,
          nextRun.agent_thread_id,
          now,
        );
        if (transition.item.status !== item.status) {
          this.touchInboxDigest?.();
        }
      }
    }
    if (transition.changed) {
      this.workUpdated?.(item.id);
    }
  }
}
