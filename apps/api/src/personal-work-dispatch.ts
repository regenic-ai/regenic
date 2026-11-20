import { randomUUID } from "node:crypto";
import {
  advanceRecipePull,
  WORK_FILE_FETCH_LIMIT,
  composeWorkConversation,
  conversationId,
  deliveryErrorMessage,
  failedWorkStart,
  formatWorkEvidence,
  formatWorkRunHistory,
  currentJobOnSession,
  isActiveWorkStatus,
  isPullDue,
  parseConversationThread,
  pullUnitKey,
  ACTIVE_WORK_STATUSES,
  OCCUPIED_RECIPE_STATUSES,
  WORK_OBSERVE_AGAIN_STATUSES,
  failedStartRetriesRemain,
  recipeAllowsPullDispatch,
  recipeAllowsPushDispatch,
  recipeHasStartCapacity,
  recipeStartInflight,
  recipeWantsContext,
  recipeConversationTitle,
  recipeCoversConversation,
  recipeMatches,
  recipeTextMatches,
  recipeTitleMatches,
  recipeTriggerOf,
  isPushInboxDecision,
  shouldRetryFailedPush,
  taskInstructionOf,
  workSubjectFromEvent,
  type ExecutorContext,
  type Recipe,
  type TaskExecutor,
  type WorkItem,
  type WorkRun,
  type WorkRunStartCheckpoint,
  type WorkRunStartCheckpointResult,
  type WorkContextAccess,
} from "@regenic/domain";
import { resolveInboxBodies, resolveInboxBody } from "./inbox-body";
import { PersonalConnectorError } from "./personal-errors";
import { PersonalWorkChannel } from "./personal-work-channel";
import { PersonalWorkWait } from "./personal-work-wait";
import { PersonalWorkSupervise } from "./personal-work-supervise";
import { PersonalRuntimeService } from "./personal-runtime.service";
import { shouldDeferWorkForThread } from "./personal-sync-phase";
import { isSystemRecipeId } from "./personal-system-work";

/** Failed retries are a second pass so open work is not stuck behind them. */
const FAILED_RETRY_PAGE = 20;

export class PersonalWorkDispatch {
  private readonly starting = new Map<string, string>();
  /** Per-recipe claim order so parallel starts reserve slots one at a time. */
  private readonly startLanes = new Map<string, Promise<void>>();
  private autoWork: Promise<void>[] = [];
  private failedScan = 0;

  constructor(
    private readonly runtime: PersonalRuntimeService,
    private readonly channel: PersonalWorkChannel,
    private readonly supervise: PersonalWorkSupervise,
    private readonly waits: PersonalWorkWait,
    private readonly contextAccess?: {
      accessFor(runId: string, options?: { agent_key?: boolean }): WorkContextAccess;
    },
    private readonly onCommittedWorkUpdate?: (workItemId: string) => void,
    private readonly completionPolicyVersion?: () => 1 | undefined,
  ) {}

  /** Start atomically observed open work up to each recipe's concurrency cap. */
  async fillOpenSlots(): Promise<void> {
    try {
      const host = this.runtime.requireHost();
      const orgId = this.runtime.orgId();
      const authority = host.get("authority");
      const [recipes, items, hiddenIds] = await Promise.all([
        authority.listRecipes(orgId),
        authority.listWorkItems(orgId, {
          statuses: [...WORK_OBSERVE_AGAIN_STATUSES],
        }),
        authority.listHiddenExecutorThreadIds(orgId),
      ]);
      const hidden = new Set(hiddenIds);
      const open: WorkItem[] = [];
      const failed: WorkItem[] = [];
      for (const item of items) {
        if (item.status === "open") {
          open.push(item);
        } else if (item.status === "failed"
          && !(item.current_run_id && item.acknowledged_run_id === item.current_run_id)) {
          failed.push(item);
        }
      }
      for (const item of interleaveByRecipe(open)) {
        await this.resumeListedItem(item, recipes, hidden);
      }
      const failedPage = takeRingPage(failed, this.failedScan, FAILED_RETRY_PAGE);
      this.failedScan = failedPage.next;
      for (const item of failedPage.page) {
        await this.resumeListedItem(item, recipes, hidden);
      }
    } finally {
      await this.drainAutoWork();
    }
  }

  private async resumeListedItem(
    item: WorkItem,
    recipes: Recipe[],
    hidden: Set<string>,
  ): Promise<void> {
    if (hidden.has(item.thread_id) || !item.recipe_id) {
      return;
    }
    const recipe = recipes.find((row) => row.id === item.recipe_id);
    if (
      !recipe ||
      (!recipeAllowsPushDispatch(recipe) && !recipeAllowsPullDispatch(recipe))
    ) {
      return;
    }
    if (!(await this.hasCurrentWorkTrigger(item))) {
      return;
    }
    await this.retryOrResume(
      item,
      recipe,
      undefined,
      recipe.max_concurrent !== undefined,
    );
  }

  private async hasCurrentWorkTrigger(item: WorkItem): Promise<boolean> {
    if (!item.head_event_id) {
      return true;
    }
    const result = await this.runtime.requireHost().get("authority").observeWorkItem({
      expected_item: item,
      item,
    });
    return result.outcome !== "conflict";
  }

  async dispatchPullRecipes(): Promise<void> {
    try {
      await this.dispatchDuePulls();
    } finally {
      await this.drainAutoWork();
    }
  }

  private async dispatchDuePulls(): Promise<void> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const authority = host.get("authority");
    const [recipes, items, failedItems] = await Promise.all([
      authority.listRecipes(orgId),
      authority.listWorkItems(orgId, { statuses: [...ACTIVE_WORK_STATUSES] }),
      authority.listWorkItems(orgId, { statuses: ["failed"] }),
    ]);
    const now = new Date();
    for (const recipe of recipes) {
      if (!recipeAllowsPullDispatch(recipe)) {
        continue;
      }
      const nowIso = now.toISOString();
      if (!isPullDue(recipe, nowIso)) {
        continue;
      }
      const targets = await this.pullTargets(recipe);
      const explicitThread = Boolean(recipe.match.thread_id?.trim());
      if (explicitThread && targets.length === 0) {
        continue;
      }
      const fireAt = recipe.next_run_at ?? nowIso;
      const unit_key = pullUnitKey(recipe.id, fireAt);
      let conflict = false;
      for (const target of targets) {
        if (
          items.some(
            (item) =>
              item.recipe_id === recipe.id &&
              item.thread_id === target.threadId &&
              isActiveWorkStatus(item.status),
          ) ||
          (await this.pullFailureStillRetries(recipe.id, target.threadId, failedItems))
        ) {
          continue;
        }
        if (await this.pullReplyUnavailable(recipe, target.threadId)) {
          continue;
        }
        const existing = await authority.getWorkItemByUnitKey(
          orgId,
          target.threadId,
          unit_key,
        );
        if (existing) {
          await this.retryOrResume(existing, recipe, undefined, false);
          continue;
        }
        const created = await authority.createWorkItem({
          item: {
            id: `work-${randomUUID()}`,
            org_id: orgId,
            thread_id: target.threadId,
            unit_key,
            record_class: target.subject.record_class,
            thread_facet: target.subject.thread_facet,
            status: "open",
            recipe_id: recipe.id,
            created_at: nowIso,
            updated_at: nowIso,
          },
          recipe,
          expected_recipe: recipe,
        });
        if (created.outcome === "conflict") {
          conflict = true;
          break;
        }
        const opened = created.item;
        items.push(opened);
        if (
          recipeWantsContext(recipe) &&
          (await shouldDeferWorkForThread(authority, orgId, target.threadId))
        ) {
          // Keep this occurrence open. The clock still moves, and the item
          // starts from the open queue once history sync finishes.
          continue;
        }
        // Claim the start before the clock moves. A queued start would see a
        // stale recipe snapshot once next_run_at is advanced.
        await this.beginStart(opened, recipe, undefined, false);
      }
      if (conflict) {
        continue;
      }
      await authority.advanceRecipePullSchedule({
        expected_recipe: recipe,
        next_run_at: advanceRecipePull(recipe.trigger, fireAt, nowIso),
        updated_at: nowIso,
      });
    }
  }

  /**
   * A failed start on this rule still retries for a few minutes.
   * The next beat waits so the same conversation does not run twice.
   */
  private async pullFailureStillRetries(
    recipeId: string,
    threadId: string,
    failedItems: readonly WorkItem[],
  ): Promise<boolean> {
    const pending = failedItems.filter(
      (item) => item.recipe_id === recipeId && item.thread_id === threadId,
    );
    const authority = this.runtime.requireHost().get("authority");
    for (const item of pending) {
      const attempts = failedRunCount(await authority.listWorkRuns(item.org_id, item.id));
      if (failedStartRetriesRemain(attempts)) {
        return true;
      }
    }
    return false;
  }

  /**
   * A conversation that cannot take the reply is skipped for this occurrence.
   * No work item is opened, so a read-only chat does not leave a failure behind.
   */
  private async pullReplyUnavailable(recipe: Recipe, threadId: string): Promise<boolean> {
    if (!this.supervise.allowsWriteBack("", recipe)) {
      return false;
    }
    const destination = recipe.write_back_thread_id ?? threadId;
    try {
      await this.channel.freezeWriteBackTarget(destination);
      return false;
    } catch (error) {
      const definite = definiteLocalStartFailure(error);
      if (!definite) {
        throw error;
      }
      console.error("personal scheduled reply unavailable", {
        recipe_id: recipe.id,
        thread_id: destination,
        error: definite.message,
      });
      return true;
    }
  }

  /**
   * Conversations this tick should open. A saved thread stays one target.
   * A wider match uses inbox heads plus the current job. Inclusion is
   * recipeCoversConversation, the same rule the editor preview calls.
   */
  private async pullTargets(recipe: Recipe): Promise<Array<{
    threadId: string;
    subject: NonNullable<ReturnType<typeof workSubjectFromEvent>>;
  }>> {
    const threadId = recipe.match.thread_id?.trim();
    if (threadId) {
      try {
        parseConversationThread(threadId);
      } catch {
        return [];
      }
      const subject = workSubjectFromEvent({
        type: recipe.match.record_class === "task" ? "task" : "message",
        source: recipe.match.source ?? threadId.split(":")[0] ?? "",
        thread_id: threadId,
        unit_kind: recipe.match.unit_kind,
        hint: recipe.match.thread_facet,
      });
      return subject ? [{ threadId, subject }] : [];
    }
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const authority = host.get("authority");
    const [shown, hidden, prefs, hiddenExecutors] = await Promise.all([
      authority.listInbox(orgId, { heads: true, list: "shown" }),
      authority.listInbox(orgId, { heads: true, list: "hidden" }),
      authority.listConversationPrefs(orgId),
      authority.listHiddenExecutorThreadIds(orgId),
    ]);
    const hiddenExecutorIds = new Set(hiddenExecutors);
    const titleByThread = new Map(prefs.map((pref) => [pref.thread_id, pref.title]));
    const heads = new Map<string, (typeof shown)[number]>();
    for (const item of [...shown, ...hidden]) {
      const id = item.event.thread_id?.trim();
      if (!id || hiddenExecutorIds.has(id) || heads.has(id)) {
        continue;
      }
      heads.set(id, item);
    }
    const [bodies, jobs] = await Promise.all([
      resolveInboxBodies(
        authority,
        host.get("blobs"),
        [...heads.values()].map((item) => item.event.content_hash),
        "meta",
      ),
      authority.listWorkItems(orgId),
    ]);
    const jobsByThread = new Map<string, WorkItem[]>();
    for (const job of jobs) {
      if (isSystemRecipeId(job.recipe_id)) {
        continue;
      }
      const list = jobsByThread.get(job.thread_id);
      if (list) {
        list.push(job);
      } else {
        jobsByThread.set(job.thread_id, [job]);
      }
    }
    const faces = new Map<string, WorkItem>();
    for (const id of heads.keys()) {
      const job = currentJobOnSession(jobsByThread.get(id) ?? [], id);
      if (job) {
        faces.set(id, job);
      }
    }
    const targets: Array<{
      threadId: string;
      subject: NonNullable<ReturnType<typeof workSubjectFromEvent>>;
    }> = [];
    for (const [id, item] of heads) {
      const surface = item.event.content_hash
        ? bodies.get(item.event.content_hash)?.surface
        : undefined;
      const projected = workSubjectFromEvent({
        type: surface?.type,
        source: item.event.source,
        thread_id: id,
        unit_kind: surface?.unit_kind,
        title: recipeConversationTitle({
          customTitle: titleByThread.get(id),
          conversationLabel: surface?.conversation_label,
        }),
        hint: surface?.thread_facet,
      });
      const job = faces.get(id);
      // A later reply does not change what an open conversation is. The editor
      // preview reads the same audience rule.
      const subject = job
        ? {
            record_class: job.record_class,
            thread_facet: job.thread_facet,
            source: item.event.source,
            thread_id: id,
            ...(projected?.unit_kind ? { unit_kind: projected.unit_kind } : {}),
            ...(projected?.title ? { title: projected.title } : {}),
          }
        : projected;
      if (
        !subject ||
        !recipeCoversConversation({
          trigger: "pull",
          workStatus: job?.status,
          matched: recipeMatches(recipe.match, subject, "pull"),
        })
      ) {
        continue;
      }
      targets.push({ threadId: id, subject });
    }
    targets.sort((left, right) => (left.threadId < right.threadId ? -1 : 1));
    return targets;
  }

  async retryOrResume(
    item: WorkItem,
    recipe: Recipe,
    evidenceText?: string,
    schedule = false,
  ): Promise<void> {
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    if (item.status === "done" || item.status === "skipped") {
      return;
    }
    if (item.status === "running" || item.status === "waiting_human") {
      return;
    }
    if (item.status === "open") {
      const active = await authority.getActiveWorkRun(item.org_id, item.id);
      if (active) {
        return;
      }
      const attempts = failedRunCount(
        await authority.listWorkRuns(item.org_id, item.id),
      );
      if (
        attempts > 0 &&
        !shouldRetryFailedPush({
          status: "failed",
          updated_at: item.updated_at,
          attempts,
          now: new Date().toISOString(),
        })
      ) {
        return;
      }
      await this.beginStart(item, recipe, evidenceText, schedule);
      return;
    }
    if (
      !shouldRetryFailedPush({
        status: item.status,
        updated_at: item.updated_at,
        attempts: failedRunCount(
          await authority.listWorkRuns(item.org_id, item.id),
        ),
        now: new Date().toISOString(),
      })
    ) {
      return;
    }
    await this.beginStart(item, recipe, evidenceText, schedule);
  }

  private beginStart(
    item: WorkItem,
    recipe: Recipe,
    evidenceText: string | undefined,
    schedule: boolean,
  ): Promise<void> {
    if (schedule && recipe.max_concurrent !== undefined) {
      const job = this.startItem(item, recipe, evidenceText, "auto").then(
        () => undefined,
      );
      this.autoWork.push(job);
      return Promise.resolve();
    }
    return this.startItem(item, recipe, evidenceText, "auto").then(
      () => undefined,
    );
  }

  private async drainAutoWork(): Promise<void> {
    const pending = this.autoWork.splice(0);
    if (pending.length === 0) {
      return;
    }
    await Promise.all(pending);
  }

  private async withRecipeTurn<T>(
    recipeId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const previous = this.startLanes.get(recipeId) ?? Promise.resolve();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settled = previous.then(
      () => undefined,
      () => undefined,
    );
    this.startLanes.set(
      recipeId,
      settled.then(() => gate),
    );
    await settled;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async startItem(
    item: WorkItem,
    recipe: Recipe,
    evidenceText?: string,
    mode: "auto" | "manual" | "auxiliary" = "auto",
    options?: {
      write_back?: boolean;
      rebind?: boolean;
      command?: {
        org_id: string;
        work_item_id: string;
        expected_version: number;
        command_id: string;
        issued_at: string;
      };
      onReplay?: () => void;
      executor?: TaskExecutor;
    },
  ): Promise<WorkRun | undefined> {
    const host = this.runtime.requireHost();
    if (
      mode === "auto" &&
      recipe.trigger.kind === "push" &&
      item.record_class !== "task" &&
      !(await this.canAutoStartMessage(item))
    ) {
      return undefined;
    }
    if (
      recipe.trigger.kind === "push" &&
      (recipe.match.text_contains || recipe.match.text_excludes) &&
      !recipeTextMatches(
        recipe.match,
        await this.filterBodyText(item.thread_id, item.head_event_id),
      )
    ) {
      if (mode !== "auto") {
        throw new PersonalConnectorError(
          "invalid_config",
          "This message does not match the rule's text filters",
          400,
        );
      }
      return undefined;
    }
    if (
      (recipe.match.title_contains || recipe.match.title_excludes) &&
      !recipeTitleMatches(
        recipe.match,
        await this.conversationTitle(item.thread_id, item.head_event_id),
      )
    ) {
      if (mode !== "auto") {
        throw new PersonalConnectorError(
          "invalid_config",
          "This conversation title does not match the rule's title filters",
          400,
        );
      }
      return undefined;
    }
    const executor = options?.executor ?? host.get("executors").get(recipe.executor_type);
    if (!executor) {
      await this.noteStartFailed(item, recipe, "Unknown executor", mode, options?.rebind);
      if (mode !== "auto") {
        throw new PersonalConnectorError("invalid_config", `Unknown executor: ${recipe.executor_type}`, 400);
      }
      return undefined;
    }
    if (recipeWantsContext(recipe)) {
      const deferred = await shouldDeferWorkForThread(
        host.get("authority"),
        this.runtime.orgId(),
        item.thread_id,
      );
      if (deferred) {
        if (mode !== "auto") {
          throw new PersonalConnectorError(
            "bootstrap_pending",
            "Thread history sync is still in progress",
            409,
          );
        }
        return undefined;
      }
    }
    if (this.starting.has(item.id)) {
      if (mode !== "auto") {
        if (options?.command) {
          const replay = await host.get("authority").getWorkRunStartReplay(options.command);
          if (replay.outcome === "replayed") {
            options.onReplay?.();
            return replay.run;
          }
          if (replay.outcome === "conflict") {
            throw new PersonalConnectorError(
              "command_conflict",
              "This command id was already used for a different operation. Refresh and try again.",
              409,
            );
          }
        }
        throw new PersonalConnectorError("execution_start_conflict", "Work start is already in progress. Refresh the work item.", 409);
      }
      return undefined;
    }
    const acquired = await this.acquireStart(recipe, item.id, mode);
    if (!acquired) {
      return undefined;
    }
    try {
      return await this.startClaimedItem(
        item,
        recipe,
        executor,
        evidenceText,
        mode,
        options,
      );
    } finally {
      this.starting.delete(item.id);
    }
  }

  private async acquireStart(
    recipe: Recipe,
    itemId: string,
    mode: "auto" | "manual" | "auxiliary",
  ): Promise<boolean> {
    if (mode === "manual") {
      this.starting.set(itemId, recipe.id);
      return true;
    }
    if (recipe.max_concurrent === undefined) {
      if (!(await this.hasStartCapacity(recipe, itemId))) {
        return false;
      }
      if (this.starting.has(itemId)) {
        return false;
      }
      this.starting.set(itemId, recipe.id);
      return true;
    }
    return this.withRecipeTurn(recipe.id, async () => {
      if (this.starting.has(itemId)) {
        return false;
      }
      if (!(await this.hasStartCapacity(recipe, itemId))) {
        return false;
      }
      this.starting.set(itemId, recipe.id);
      return true;
    });
  }

  private async startClaimedItem(
    item: WorkItem,
    recipe: Recipe,
    executor: TaskExecutor,
    evidenceText: string | undefined,
    mode: "auto" | "manual" | "auxiliary",
    options?: {
      write_back?: boolean;
      rebind?: boolean;
      command?: {
        org_id: string;
        work_item_id: string;
        expected_version: number;
        command_id: string;
        issued_at: string;
      };
      onReplay?: () => void;
    },
  ): Promise<WorkRun | undefined> {
    const host = this.runtime.requireHost();
    const now = new Date().toISOString();
    const includeContext = recipeWantsContext(recipe);
    const workspace = Boolean(executor.capabilities().local_workspace);
    const thread = includeContext
      ? await this.channel.threadContextLines(item.thread_id, {
          fetchLimit: workspace ? WORK_FILE_FETCH_LIMIT : undefined,
          anchorEventId: item.head_event_id,
        })
      : { lines: [], overflow: false };
    const runId = `run-${randomUUID()}`;
    const history = formatWorkRunHistory(
      await host.get("authority").listWorkRuns(item.org_id, item.id),
      runId,
    );
    const composed = composeWorkConversation({
      include_context: includeContext,
      history,
      trigger_text: evidenceText,
      current_event_id: item.head_event_id,
      head_text:
        evidenceText || !item.head_event_id
          ? undefined
          : await this.channel.evidenceText(item.thread_id, item.head_event_id),
      thread_lines: thread.lines,
      thread_overflow: thread.overflow,
    });
    const authority = host.get("authority");
    const writeBackRequired = options?.write_back ?? this.supervise.allowsWriteBack(item.id, recipe);
    let writeBackTarget;
    if (writeBackRequired) {
      try {
        writeBackTarget = await this.channel.freezeWriteBackTarget(
          recipe.write_back_thread_id ?? item.thread_id,
        );
      } catch (error) {
        const definite = definiteLocalStartFailure(error);
        if (!definite || mode !== "auto") {
          throw error;
        }
        // One conversation that cannot take a reply fails only that item.
        // The rest of a sweep still starts, and the clock still advances.
        await this.noteStartFailed(item, recipe, definite.message, mode);
        return undefined;
      }
    }
    const visibilityIntentVersion =
      (await authority.getConversationPref(item.org_id, item.thread_id))
        ?.visibility_version ?? 0;
    const run: WorkRun & { status: "running"; start_state: "pending" } = {
      id: runId,
      org_id: item.org_id,
      work_item_id: item.id,
      recipe_id: recipe.id,
      executor_type: executor.executor_type,
      executor_config: recipe.executor_config,
      include_context: includeContext,
      status: "running",
      start_state: "pending",
      write_back_required: writeBackRequired,
      trigger_kind: recipeTriggerOf(recipe).kind,
      hide_on_success: recipe.hide_on_success !== false,
      ...(!isSystemRecipeId(recipe.id) && this.completionPolicyVersion?.() === 1
        ? { completion_policy_version: 1 as const } : {}),
      ...(writeBackTarget ? { write_back_target: writeBackTarget } : {}),
      created_at: now,
      updated_at: now,
    };
    const claimed = await authority.claimWorkRunStart({
      run,
      expected_recipe: recipe,
      expected_item: item,
      ...(options?.command ? {
        expected_version: options.command.expected_version,
        command_id: options.command.command_id,
        issued_at: options.command.issued_at,
      } : {}),
      retry: mode === "manual" ? "manual" : item.status === "failed" ? "automatic" : undefined,
      rebind: mode === "manual" && options?.rebind ? "manual"
        : mode === "auto" && recipe.trigger.kind === "push" && item.recipe_id !== recipe.id
          && (recipe.match.text_contains || recipe.match.text_excludes ||
            recipe.match.title_contains || recipe.match.title_excludes) ? "automatic" : undefined,
      max_concurrent: mode === "manual" ? undefined : recipe.max_concurrent,
      require_current_work_trigger:
        mode === "auto" &&
        recipe.trigger.kind === "push" &&
        Boolean(item.head_event_id),
      visibility_intent_version: visibilityIntentVersion,
    });
    if (!claimed) {
      if (mode !== "auto") {
        if (options?.command) {
          const replay = await authority.getWorkRunStartReplay(options.command);
          if (replay.outcome === "replayed") {
            options.onReplay?.();
            return replay.run;
          }
          if (replay.outcome === "conflict") {
            throw new PersonalConnectorError(
              "command_conflict",
              "This command id was already used for a different operation. Refresh and try again.",
              409,
            );
          }
        }
        throw new PersonalConnectorError("execution_start_conflict", "Work item changed before start could be reserved. Refresh the work item.", 409);
      }
      return undefined;
    }
    try {
      return await this.startReservedItem(item, recipe, executor, run, composed, workspace, mode);
    } catch (error) {
      if (mode === "auxiliary") {
        const [savedItem, savedRun] = await Promise.all([
          authority.getWorkItem(item.org_id, item.id),
          authority.getWorkRun(item.org_id, run.id),
        ]);
        if (savedItem?.current_run_id === run.id && savedRun &&
          (savedRun.status === "running" || savedRun.status === "waiting_human" || savedRun.status === "completed")) {
          console.error("personal auxiliary start recovering reserved execution", {
            work_item_id: item.id, run_id: run.id, error,
          });
          return savedRun;
        }
      }
      throw error;
    }
  }

  private async startReservedItem(
    item: WorkItem,
    recipe: Recipe,
    executor: TaskExecutor,
    run: WorkRun,
    composed: ReturnType<typeof composeWorkConversation>,
    workspace: boolean,
    mode: "auto" | "manual" | "auxiliary",
  ): Promise<WorkRun | undefined> {
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    const frozenRecipe = {
      ...recipe,
      executor_config: run.executor_config ?? recipe.executor_config,
      include_context: run.include_context ?? recipeWantsContext(recipe),
    };
    const runningItem = await authority.getWorkItem(item.org_id, item.id);
    if (!runningItem || runningItem.current_run_id !== run.id) {
      throw new Error(`Claimed work item identity disappeared: ${item.id}`);
    }
    if (!isActiveWorkStatus(runningItem.status)) throw new PersonalConnectorError(
      "work_abandoned", "Work start is no longer active", 409,
    );
    let handle;
    try {
      handle = await executor.start(
        {
          run_id: run.id,
          work_item: runningItem,
          recipe: frozenRecipe,
          task_instruction: taskInstructionOf(frozenRecipe.executor_config),
          evidence_text: formatWorkEvidence({
            thread_id: item.thread_id,
            record_class: item.record_class,
            thread_facet: item.thread_facet,
            source: item.thread_id.split(":")[0] ?? "",
            text: composed.inline_text,
          }),
          conversation: frozenRecipe.include_context
            ? {
                current: composed.current,
                current_line: composed.current_line,
                background: composed.background,
                omitted: composed.omitted,
                history: composed.history,
                task: {
                  thread_id: item.thread_id,
                  ...(item.head_event_id ? { event_id: item.head_event_id } : {}),
                },
                ...(workspace && this.contextAccess
                  ? { access: this.contextAccess.accessFor(run.id, { agent_key: true }) }
                  : {}),
              }
            : undefined,
        },
        this.startContext(run, this.channel.contextFor(executor)),
      );
    } catch (error) {
      const saved = await authority.getWorkRun(item.org_id, run.id);
      const latestItem = await authority.getWorkItem(item.org_id, item.id);
      const definite = definiteLocalStartFailure(error);
      if (
        definite &&
        saved?.start_state === "pending" &&
        !saved.external_run_id &&
        !saved.agent_thread_id &&
        latestItem &&
        latestItem.status !== "skipped"
      ) {
        const failedAt = new Date().toISOString();
        await this.checkpointStart({
          expected_item: latestItem, expected_run: saved,
          kind: "failed", error: definite.message, now: failedAt,
        });
        this.publishCommittedWorkUpdate(item.id);
        console.error("personal work start failed", {
          run_id: run.id,
          error: definite.message,
        });
        if (mode !== "auto") {
          throw definite;
        }
        return undefined;
      }
      console.error("personal work start could not be confirmed", {
        run_id: run.id,
        error,
      });
      if (saved && latestItem && saved.status !== "cancelled" && latestItem.status !== "skipped") {
        if (saved.start_state === "pending") {
          await this.checkpointStart({
            expected_item: latestItem, expected_run: saved, kind: "uncertain",
            error: `Executor start could not be confirmed: ${deliveryErrorMessage(error)}. Check the executor before dismissing this attempt and starting a new one.`,
            now: new Date().toISOString(),
          });
          this.publishCommittedWorkUpdate(item.id);
        }
      }
      if (mode !== "auto") {
        if (saved?.start_state === "submitted") {
          throw new PersonalConnectorError(
            "execution_recovery_pending",
            `Executor submission is recorded (run ${run.id}). Refresh to recover the existing execution.`,
            503,
          );
        }
        throw new PersonalConnectorError(
          "execution_start_uncertain",
          `Executor start could not be confirmed (run ${run.id}). Check the executor before starting another attempt.`,
          409,
        );
      }
      return undefined;
    }
    const saved = await authority.getWorkRun(item.org_id, run.id);
    if (!saved) {
      throw new Error(`Claimed work run disappeared: ${run.id}`);
    }
    if (saved.status === "cancelled" || saved.start_state === undefined) {
      if (saved.status === "running" || saved.status === "waiting_human") {
        const latestItem = await authority.getWorkItem(item.org_id, item.id);
        if (latestItem?.current_run_id === saved.id && isActiveWorkStatus(latestItem.status)) {
          this.waits.attach(latestItem, saved, executor);
        }
      }
      return saved;
    }
    const latestStartItem = await authority.getWorkItem(item.org_id, item.id);
    if (!latestStartItem) throw new Error(`Claimed work item disappeared: ${item.id}`);
    const acknowledged = await this.checkpointStart({
      expected_item: latestStartItem, expected_run: saved, kind: "submitted",
      external_run_id: handle.external_run_id,
      agent_thread_id: handle.agent_thread_id, result: handle.result,
      now: new Date().toISOString(),
    });
    await this.supervise.applyHandle(acknowledged.item, recipe, acknowledged.run, handle);
    const latest = await host.get("authority").getActiveWorkRun(item.org_id, item.id);
    const latestItem = await host.get("authority").getWorkItem(item.org_id, item.id);
    if (latest?.id === run.id && latestItem?.current_run_id === run.id
      && isActiveWorkStatus(latestItem.status)) {
      this.waits.attach(latestItem, latest, executor);
    }
    const finishedStart = await authority.getWorkRun(item.org_id, run.id);
    if (!finishedStart) throw new Error(`Claimed work run disappeared: ${run.id}`);
    return finishedStart;
  }

  private startContext(run: WorkRun, ctx: ExecutorContext): ExecutorContext {
    const authority = this.runtime.requireHost().get("authority");
    const current = async (): Promise<{ expected_run: WorkRun; expected_item: WorkItem }> => {
      const [saved, item] = await Promise.all([
        authority.getWorkRun(run.org_id, run.id),
        authority.getWorkItem(run.org_id, run.work_item_id),
      ]);
      if (
        !saved || !item || saved.start_state !== "pending" || !isActiveWorkStatus(item.status)
        || item.current_run_id !== saved.id ||
        saved.status === "cancelled" || saved.status === "completed" || saved.status === "failed"
      ) {
        throw new PersonalConnectorError("work_abandoned", "Work start is no longer active", 409);
      }
      return { expected_run: saved, expected_item: item };
    };
    return {
      ...ctx,
      spawnSysout: async (options) => {
        const expected = await current();
        const thread = await ctx.spawnSysout(options);
        const sysoutId = `${thread.source}:${thread.target}`;
        await this.checkpointStart({
          ...expected, kind: "bound",
          external_run_id: sysoutId,
          agent_thread_id: sysoutId,
          now: new Date().toISOString(),
        });
        return thread;
      },
      writeStdin: async (thread, text) => {
        const expected = await current();
        await ctx.writeStdin(thread, text);
        const sysoutId = `${thread.source}:${thread.target}`;
        await this.checkpointStart({
          ...expected, kind: "submitted",
          external_run_id: sysoutId,
          agent_thread_id: sysoutId,
          now: new Date().toISOString(),
        });
      },
    };
  }

  private async checkpointStart(
    input: WorkRunStartCheckpoint,
  ): Promise<Extract<WorkRunStartCheckpointResult, { outcome: "applied" }>> {
    const result = await this.runtime.requireHost().get("authority").checkpointWorkRunStart(input);
    if (result.outcome === "conflict") throw new PersonalConnectorError(
      "execution_start_conflict", `Work start checkpoint rejected: ${result.reason}. Refresh the work item.`, 409,
    );
    return result;
  }

  private async canAutoStartMessage(item: WorkItem): Promise<boolean> {
    if (!item.head_event_id) {
      return false;
    }
    const authority = this.runtime.requireHost().get("authority");
    const [decision, pref] = await Promise.all([
      authority.getDisposition(item.head_event_id),
      authority.getConversationPref(item.org_id, item.thread_id),
    ]);
    return Boolean(decision && isPushInboxDecision(decision) &&
      (!pref?.hidden || pref.hidden_reason === "policy"));
  }

  private async hasStartCapacity(recipe: Recipe, exceptItemId: string): Promise<boolean> {
    if (recipe.max_concurrent === undefined) {
      return true;
    }
    const items = await this.runtime
      .requireHost()
      .get("authority")
      .listWorkItems(this.runtime.orgId(), {
        statuses: [...OCCUPIED_RECIPE_STATUSES],
      });
    const inflight = recipeStartInflight({
      recipeId: recipe.id,
      starting: [...this.starting].map(([item_id, recipe_id]) => ({
        item_id,
        recipe_id,
      })),
      occupiedItemIds: items
        .filter((row) => row.recipe_id === recipe.id)
        .map((row) => row.id),
      exceptItemId,
    });
    return recipeHasStartCapacity({
      recipe,
      items,
      exceptItemId,
      inflight,
    });
  }

  private async filterBodyText(threadId: string, eventId?: string): Promise<string | undefined> {
    if (!eventId) return undefined;
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    const orgId = this.runtime.orgId();
    const event = await authority.getEvent(orgId, eventId);
    if (event && conversationId(event.source, event.external_id, event.id) !== threadId) {
      return undefined;
    }
    return (await resolveInboxBody(authority, host.get("blobs"), event?.content_hash, "meta")).body_text;
  }

  private async conversationTitle(threadId: string, eventId?: string): Promise<string | undefined> {
    const host = this.runtime.requireHost();
    const authority = host.get("authority");
    const orgId = this.runtime.orgId();
    const [pref, heads] = await Promise.all([
      authority.getConversationPref(orgId, threadId),
      authority.listInbox(orgId, { heads: true, thread_ids: [threadId] }),
    ]);
    const currentLabel = await this.eventConversationLabel(heads[0]?.event, threadId);
    if (pref?.title?.trim() || currentLabel) {
      return recipeConversationTitle({
        customTitle: pref?.title,
        conversationLabel: currentLabel,
      });
    }
    const event = eventId ? await authority.getEvent(orgId, eventId) : null;
    return recipeConversationTitle({
      conversationLabel: await this.eventConversationLabel(event, threadId),
    });
  }

  private async eventConversationLabel(
    event: { id: string; source: string; external_id: string; content_hash?: string } | null | undefined,
    threadId: string,
  ): Promise<string | undefined> {
    if (!event?.content_hash) {
      return undefined;
    }
    if (conversationId(event.source, event.external_id, event.id) !== threadId) {
      return undefined;
    }
    const host = this.runtime.requireHost();
    const body = await resolveInboxBody(
      host.get("authority"),
      host.get("blobs"),
      event.content_hash,
      "meta",
    );
    return body.surface?.conversation_label;
  }

  private async noteStartFailed(
    item: WorkItem,
    recipe: Recipe,
    error: string,
    mode: "auto" | "manual" | "auxiliary",
    rebind = false,
  ): Promise<void> {
    const now = new Date().toISOString();
    const host = this.runtime.requireHost();
    const result = await host.get("authority").recordWorkRunStartFailure({
      expected_item: item,
      run: {
        ...failedWorkStart({ item, recipe, error, now }),
        executor_config: recipe.executor_config,
        include_context: recipeWantsContext(recipe),
        status: "failed", write_back_required: false, trigger_kind: recipeTriggerOf(recipe).kind,
      },
      mode: mode === "auto" ? "automatic" : mode,
      rebind: mode === "manual" && rebind ? "manual" : undefined,
    });
    if (result.outcome === "conflict") {
      if (mode !== "auto") throw new PersonalConnectorError(
        "execution_start_conflict", `Work start failure rejected: ${result.reason}. Refresh the work item.`, 409,
      );
      console.error("personal work start failure rejected", result.reason, error);
      return;
    }
    this.publishCommittedWorkUpdate(item.id);
    if (mode === "auto") {
      console.error("personal work start failed", error);
    }
  }

  private publishCommittedWorkUpdate(workItemId: string): void {
    try {
      this.onCommittedWorkUpdate?.(workItemId);
    } catch (error) {
      console.error("personal work start lifecycle notification failed", {
        work_item_id: workItemId,
        error,
      });
    }
  }
}

function definiteLocalStartFailure(
  error: unknown,
): PersonalConnectorError | undefined {
  if (
    error instanceof PersonalConnectorError &&
    (error.code === "unsupported_channel" || error.code === "no_sender")
  ) {
    return error;
  }
  return undefined;
}

function failedRunCount(runs: WorkRun[]): number {
  return runs.filter((run) => run.status === "failed").length;
}

function interleaveByRecipe(items: WorkItem[]): WorkItem[] {
  const groups = new Map<string, WorkItem[]>();
  for (const item of items) {
    const key = item.recipe_id ?? "";
    const list = groups.get(key);
    if (list) {
      list.push(item);
    } else {
      groups.set(key, [item]);
    }
  }
  const queues = [...groups.values()];
  const mixed: WorkItem[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const queue of queues) {
      const next = queue.shift();
      if (!next) {
        continue;
      }
      mixed.push(next);
      added = true;
    }
  }
  return mixed;
}

function takeRingPage<T>(items: T[], start: number, limit: number): { page: T[]; next: number } {
  if (items.length === 0 || items.length <= limit) {
    return { page: items, next: 0 };
  }
  const index = start >= 0 && start < items.length ? start : 0;
  const page = items.slice(index, index + limit);
  const next = index + page.length;
  return { page, next: next >= items.length ? 0 : next };
}
