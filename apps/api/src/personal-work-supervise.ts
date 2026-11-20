import {
  recipeTriggerOf,
  recipeWantsWriteBack,
  workRunHandleMatchesExecution,
  type ExecutorContext,
  type ExecutorRunHandle,
  type Recipe,
  type TaskExecutor,
  type WorkItem,
  type WorkRun,
} from "@regenic/domain";
import { PersonalWorkChannel } from "./personal-work-channel";
import { releaseFinishedAgentThread } from "./personal-work-lifecycle";
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
    this.retainSupervision(new Set(active.map((item) => item.id)));
  }

  async refreshOne(
    item: WorkItem,
    recipe: Recipe | null,
    run: WorkRun,
  ): Promise<void> {
    if (run.start_state === "pending") {
      return;
    }
    if (run.start_state === "uncertain") {
      if (item.status === "skipped") return;
      await this.reconcileUncertainStart(item, recipe, run);
      return;
    }
    if ((!run.external_run_id && !run.agent_thread_id)
      || (item.status === "skipped" && !run.external_run_id)) {
      console.error("personal work execution requires identity reconciliation", {
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
    this.requireMatchingHandle(run, handle);
    const now = Date.now();
    if (item.status !== "skipped" && isStaleWork(item.created_at, now, workReapStaleMs()) && handle.status === "running") {
      handle = await this.reapIfInboxEnded(item, run, handle, executor, ctx, now);
    }
    await this.applyFreshHandle(item, recipe, run, handle);
  }

  /**
   * Follow and the wait loop can commit thread state after this run was read.
   * Reload the same run before observing it, and once more if that commit loses the race.
   */
  private async applyFreshHandle(
    item: WorkItem,
    recipe: Recipe | null,
    run: WorkRun,
    handle: ExecutorRunHandle,
  ): Promise<void> {
    const target = await this.loadObservationTarget(item, run);
    try {
      await this.applyHandle(target.item, recipe, target.run, handle);
    } catch (error) {
      if (!isStaleObservation(error)) throw error;
      const latest = await this.loadObservationTarget(item, run);
      await this.applyHandle(latest.item, recipe, latest.run, handle);
    }
  }

  private async loadObservationTarget(
    item: WorkItem,
    run: WorkRun,
  ): Promise<{ item: WorkItem; run: WorkRun }> {
    const authority = this.runtime.requireHost().get("authority");
    const freshItem = await authority.getWorkItem(item.org_id, item.id);
    const freshRun = freshItem
      ? await authority.getWorkRun(item.org_id, run.id)
      : null;
    if (!freshItem || !freshRun
      || freshItem.current_run_id !== run.id
      || freshRun.work_item_id !== item.id) {
      throw new PersonalConnectorError(
        "execution_observation_conflict",
        "Work changed while its executor was being observed. Refresh the work item before applying another observation.",
        409,
      );
    }
    return { item: freshItem, run: freshRun };
  }

  private async reconcileUncertainStart(
    item: WorkItem,
    recipe: Recipe | null,
    run: WorkRun,
  ): Promise<void> {
    if (!run.external_run_id && !run.agent_thread_id) return;
    const host = this.runtime.requireHost();
    const executor = host.get("executors").get(run.executor_type);
    if (!executor) return;
    const handle = await executor.status(run, this.channel.contextFor(executor));
    if (!hasPositiveStartEvidence(handle)
      || !handle.external_run_id?.trim()
      || !workRunHandleMatchesExecution(run, handle)) return;
    const authority = host.get("authority");
    const confirmed = await authority.checkpointWorkRunStart({
      expected_item: item,
      expected_run: run,
      kind: "submitted",
      external_run_id: handle.external_run_id,
      ...(run.agent_thread_id ? { agent_thread_id: run.agent_thread_id } : {}),
      ...(handle.result ? { result: handle.result } : {}),
      now: new Date().toISOString(),
    });
    if (confirmed.outcome === "conflict") {
      throw new PersonalConnectorError(
        "execution_start_conflict",
        `Work start confirmation rejected: ${confirmed.reason}. Refresh the work item.`,
        409,
      );
    }
    await this.applyHandle(confirmed.item, recipe, confirmed.run, handle);
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
        this.requireMatchingHandle(run, handle);
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
    this.requireMatchingHandle(run, latest);
    if (latest.status !== "running") {
      return latest;
    }
    return handleFromInboxEnd(run, scan, transcript);
  }

  private requireMatchingHandle(run: WorkRun, handle: ExecutorRunHandle): void {
    if (!workRunHandleMatchesExecution(run, handle)) {
      throw new PersonalConnectorError(
        "execution_observation_conflict",
        "Executor observation does not match the bound run identity.",
        409,
      );
    }
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
      this.forgetWork(item.id);
      return;
    }
    if (result.outcome === "conflict") {
      throw new PersonalConnectorError(
        "execution_observation_conflict",
        result.reason === "completed_result_changed"
          ? "Completed work results are immutable. Start a new attempt to change the result."
          : result.reason === "execution_identity_mismatch"
          ? "Executor observation does not match the bound run identity."
          : result.reason === "execution_start_unconfirmed"
          ? "Executor start must be confirmed before applying an observation."
          : result.reason === "execution_identity_unknown"
          ? "Executor identity could not be verified. Reconcile this run before applying an observation."
          : "Work changed while its executor was being observed. Refresh the work item before applying another observation.",
        409,
      );
    }
    const { transition } = result;
    const nextRun = transition.run;
    if (transition.item.status === "skipped" && item.status === "skipped") {
      this.waits?.drop(run.id);
      this.writeBackOverride.delete(item.id);
      this.forgetWork(item.id);
      if (transition.changed) this.workUpdated?.(item.id);
      return;
    }
    if (transition.settled) {
      this.writeBackOverride.delete(item.id);
      this.waits?.drop(run.id);
      this.forgetWork(item.id);
      if (!isSystemRecipeId(run.recipe_id)) {
        releaseFinishedAgentThread(nextRun.agent_thread_id);
        if (transition.item.status !== item.status) {
          this.touchInboxDigest?.();
        }
      }
    }
    if (transition.changed) {
      this.workUpdated?.(item.id);
    }
  }

  private forgetWork(workItemId: string): void {
    this.lastFollow.delete(workItemId);
    this.lastReapLog.delete(workItemId);
  }

  private retainSupervision(activeIds: ReadonlySet<string>): void {
    for (const id of this.lastFollow.keys()) {
      if (!activeIds.has(id)) this.lastFollow.delete(id);
    }
    for (const id of this.lastReapLog.keys()) {
      if (!activeIds.has(id)) this.lastReapLog.delete(id);
    }
  }
}

function isStaleObservation(error: unknown): boolean {
  return error instanceof PersonalConnectorError
    && error.code === "execution_observation_conflict"
    && error.message.startsWith("Work changed while its executor was being observed.");
}

function hasPositiveStartEvidence(handle: ExecutorRunHandle): boolean {
  if (handle.status === "completed" || handle.status === "cancelled") return true;
  if (handle.status === "running") {
    return handle.transcript?.turn?.state === "open"
      || handle.transcript?.activity === "working";
  }
  if (handle.status === "waiting_human") {
    return (handle.prompts?.length ?? 0) > 0
      || handle.transcript?.activity === "awaiting_user";
  }
  return false;
}
