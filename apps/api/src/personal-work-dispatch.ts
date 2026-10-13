import { randomUUID } from "node:crypto";
import {
  advancePullNextRun,
  WORK_FILE_FETCH_LIMIT,
  composeWorkConversation,
  conversationId,
  deliveryErrorMessage,
  failedWorkStart,
  formatWorkEvidence,
  isActiveWorkStatus,
  isPullDue,
  openOrUpdateWorkItem,
  parseConversationThread,
  pullUnitKey,
  ACTIVE_WORK_STATUSES,
  OCCUPIED_RECIPE_STATUSES,
  WORK_OBSERVE_AGAIN_STATUSES,
  recipeAllowsPullDispatch,
  recipeAllowsPushDispatch,
  recipeHasStartCapacity,
  recipeStartInflight,
  recipeWantsContext,
  isOccupiedRecipeSlot,
  isTaskInboxItem,
  selectRecipeForSubject,
  shouldAcceptPushRecord,
  shouldRetryFailedPush,
  workSubjectFromEvent,
  type ConnectorInstallation,
  type EventRecord,
  type InboxItem,
  type Recipe,
  type TaskExecutor,
  type WorkItem,
  type WorkRun,
} from "@regenic/domain";
import { resolveInboxBodies, type InboxBody } from "./inbox-body";
import { PersonalConnectorError } from "./personal-errors";
import { PersonalWorkChannel } from "./personal-work-channel";
import { PersonalWorkWait } from "./personal-work-wait";
import { PersonalWorkSupervise } from "./personal-work-supervise";
import { PersonalRuntimeService } from "./personal-runtime.service";
import { shouldDeferWorkForThread } from "./personal-sync-phase";

export class PersonalWorkDispatch {
  private readonly starting = new Map<string, string>();
  /** Per-recipe claim order so parallel starts reserve slots one at a time. */
  private readonly startLanes = new Map<string, Promise<void>>();
  private autoWork: Promise<void>[] = [];

  constructor(
    private readonly runtime: PersonalRuntimeService,
    private readonly channel: PersonalWorkChannel,
    private readonly supervise: PersonalWorkSupervise,
    private readonly waits: PersonalWorkWait,
  ) {}

  async reconcileInbox(): Promise<void> {
    try {
      await this.observeInbox();
    } finally {
      await this.drainAutoWork();
    }
  }

  /**
   * Start work already opened, up to each recipe cap, before the inbox walk.
   * The walk decides new rows. It does not have to finish before slots fill.
   */
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
      for (const item of items) {
        if (hidden.has(item.thread_id) || !item.recipe_id) {
          continue;
        }
        const recipe = recipes.find((row) => row.id === item.recipe_id);
        if (
          !recipe ||
          (!recipeAllowsPushDispatch(recipe) && !recipeAllowsPullDispatch(recipe))
        ) {
          continue;
        }
        await this.retryOrResume(
          item,
          recipe,
          undefined,
          recipe.max_concurrent !== undefined,
        );
      }
    } finally {
      await this.drainAutoWork();
    }
  }

  private async observeInbox(): Promise<void> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const authority = host.get("authority");
    const [recipes, items, hiddenIds, heads, taskRows] = await Promise.all([
      authority.listRecipes(orgId),
      authority.listWorkItems(orgId, { statuses: [...ACTIVE_WORK_STATUSES] }),
      authority.listHiddenExecutorThreadIds(orgId),
      authority.listInbox(orgId, { heads: true, needs_work: true }),
      authority.listInbox(orgId, { tasks: true, needs_work: true }),
    ]);
    if (heads.length === 0 && taskRows.length === 0 && items.length === 0) {
      return;
    }
    const hidden = new Set(hiddenIds);
    const observeRows = uniqueInboxItems([...taskRows, ...heads]);
    const bodies = await resolveInboxBodies(
      authority,
      host.get("blobs"),
      observeRows.map((row) => row.event.content_hash),
      "meta",
    );
    const installations = await authority.listInstallations(orgId);
    const seenEvents = new Set<string>();
    for (const row of observeRows) {
      const threadId = conversationId(row.event.source, row.event.external_id, row.event.id);
      if (hidden.has(threadId) || seenEvents.has(row.event.id)) {
        continue;
      }
      seenEvents.add(row.event.id);
      const body = row.event.content_hash
        ? (bodies.get(row.event.content_hash) ?? {})
        : {};
      await this.observeHead({
        event: row.event,
        threadId,
        body,
        recipes,
        installations,
        fallbackType: isTaskInboxItem(row) ? "task" : undefined,
      });
    }
    for (const item of items) {
      if (
        hidden.has(item.thread_id) ||
        (item.head_event_id && seenEvents.has(item.head_event_id))
      ) {
        continue;
      }
      if (isOccupiedRecipeSlot(item.status) || !item.head_event_id) {
        continue;
      }
      const event = await authority.getEvent(orgId, item.head_event_id);
      if (!event) {
        continue;
      }
      const body = await resolveInboxBodies(
        authority,
        host.get("blobs"),
        [event.content_hash],
        "meta",
      );
      await this.observeHead({
        event,
        threadId: item.thread_id,
        body: event.content_hash ? (body.get(event.content_hash) ?? {}) : {},
        recipes,
        installations,
      });
    }
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
    const [recipes, items] = await Promise.all([
      authority.listRecipes(orgId),
      authority.listWorkItems(orgId, { statuses: [...ACTIVE_WORK_STATUSES] }),
    ]);
    const now = new Date();
    for (const recipe of recipes) {
      if (!recipeAllowsPullDispatch(recipe)) {
        continue;
      }
      const threadId = recipe.match.thread_id?.trim();
      const interval = recipe.trigger.interval_ms;
      if (!threadId || !interval) {
        continue;
      }
      try {
        parseConversationThread(threadId);
      } catch {
        continue;
      }
      if (items.some((item) => item.recipe_id === recipe.id && isActiveWorkStatus(item.status))) {
        continue;
      }
      const nowIso = now.toISOString();
      if (!isPullDue(recipe, nowIso)) {
        continue;
      }
      if (recipeWantsContext(recipe)) {
        if (
          await shouldDeferWorkForThread(authority, orgId, threadId)
        ) {
          continue;
        }
      }
      const fireAt = recipe.next_run_at ?? nowIso;
      const unit_key = pullUnitKey(recipe.id, fireAt);
      const existing = await authority.getWorkItemByUnitKey(
        orgId,
        threadId,
        unit_key,
      );
      if (existing) {
        await this.retryOrResume(
          existing,
          recipe,
          undefined,
          recipe.max_concurrent !== undefined,
        );
      } else {
        const subject = workSubjectFromEvent({
          type: recipe.match.record_class === "task" ? "task" : "message",
          source: recipe.match.source ?? threadId.split(":")[0] ?? "",
          thread_id: threadId,
          unit_kind: recipe.match.unit_kind,
          hint: recipe.match.thread_facet,
        });
        if (!subject) {
          continue;
        }
        const opened = await authority.putWorkItem({
          id: `work-${randomUUID()}`,
          org_id: orgId,
          thread_id: threadId,
          unit_key,
          record_class: subject.record_class,
          thread_facet: subject.thread_facet,
          status: "open",
          recipe_id: recipe.id,
          created_at: nowIso,
          updated_at: nowIso,
        });
        items.push(opened);
        await this.beginStart(
          opened,
          recipe,
          undefined,
          recipe.max_concurrent !== undefined,
        );
      }
      await authority.putRecipe({
        ...recipe,
        next_run_at: advancePullNextRun(fireAt, interval, nowIso),
      });
    }
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
    const opened = await authority.putWorkItem({
      ...item,
      status: "open",
      recipe_id: recipe.id,
      updated_at: new Date().toISOString(),
    });
    await this.beginStart(opened, recipe, evidenceText, schedule);
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
    mode: "auto" | "manual" = "auto",
  ): Promise<WorkRun | undefined> {
    const host = this.runtime.requireHost();
    const executor = host.get("executors").get(recipe.executor_type);
    if (!executor) {
      await this.noteStartFailed(item, recipe, "Unknown executor", mode);
      return undefined;
    }
    if (recipeWantsContext(recipe)) {
      const deferred = await shouldDeferWorkForThread(
        host.get("authority"),
        this.runtime.orgId(),
        item.thread_id,
      );
      if (deferred) {
        if (mode === "manual") {
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
      );
    } finally {
      this.starting.delete(item.id);
    }
  }

  private async acquireStart(
    recipe: Recipe,
    itemId: string,
    mode: "auto" | "manual",
  ): Promise<boolean> {
    if (mode !== "auto") {
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
    mode: "auto" | "manual",
  ): Promise<WorkRun | undefined> {
    const host = this.runtime.requireHost();
    const now = new Date().toISOString();
    const includeContext = recipeWantsContext(recipe);
    const workspace = Boolean(executor.capabilities().local_workspace);
    const thread = includeContext
      ? await this.channel.threadContextLines(item.thread_id, {
          fetchLimit: workspace ? WORK_FILE_FETCH_LIMIT : undefined,
        })
      : { lines: [], overflow: false };
    const composed = composeWorkConversation({
      include_context: includeContext,
      trigger_text: evidenceText,
      head_text:
        evidenceText || !item.head_event_id
          ? undefined
          : await this.channel.evidenceText(item.thread_id, item.head_event_id),
      thread_lines: thread.lines,
      thread_overflow: thread.overflow,
    });
    let handle;
    try {
      handle = await executor.start(
        {
          work_item: item,
          recipe,
          evidence_text: formatWorkEvidence({
            thread_id: item.thread_id,
            record_class: item.record_class,
            thread_facet: item.thread_facet,
            source: item.thread_id.split(":")[0] ?? "",
            text: composed.inline_text,
          }),
          conversation: includeContext
            ? {
                current: composed.current,
                current_line: composed.current_line,
                background: composed.background,
                omitted: composed.omitted,
              }
            : undefined,
        },
        this.channel.contextFor(executor),
      );
    } catch (error) {
      await this.noteStartFailed(item, recipe, deliveryErrorMessage(error), mode);
      if (mode === "manual") {
        throw error;
      }
      return undefined;
    }
    const run: WorkRun = {
      id: `run-${randomUUID()}`,
      org_id: item.org_id,
      work_item_id: item.id,
      recipe_id: recipe.id,
      executor_type: executor.executor_type,
      external_run_id: handle.external_run_id,
      agent_thread_id: handle.agent_thread_id,
      status: handle.status === "completed" ? "completed" : handle.status === "failed" ? "failed" : handle.status === "waiting_human" ? "waiting_human" : "running",
      result: handle.result,
      created_at: now,
      updated_at: now,
    };
    await this.supervise.applyHandle(item, recipe, run, handle);
    const latest = await host.get("authority").getActiveWorkRun(item.org_id, item.id);
    const latestItem = await host.get("authority").getWorkItem(item.org_id, item.id);
    if (latest && latestItem && isActiveWorkStatus(latestItem.status)) {
      this.waits.attach(latestItem, latest, executor);
    }
    return (
      latest ?? run
    );
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

  private async observeHead(input: {
    event: EventRecord;
    threadId: string;
    body: InboxBody;
    recipes: Recipe[];
    installations: ConnectorInstallation[];
    fallbackType?: string;
  }): Promise<void> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const authority = host.get("authority");
    try {
      parseConversationThread(input.threadId);
    } catch {
      return;
    }
    const surface = input.body.surface;
    if (
      !shouldAcceptPushRecord({
        kind: surface?.kind,
        direction: surface?.direction,
        external_id: input.event.external_id,
        type: surface?.type ?? input.fallbackType,
      })
    ) {
      return;
    }
    const existing = await authority.getWorkItemByThread(orgId, input.threadId);
    const subject = workSubjectFromEvent({
      type: surface?.type ?? input.fallbackType,
      source: input.event.source,
      thread_id: input.threadId,
      unit_kind: surface?.unit_kind,
      prompts: false,
      hint: surface?.thread_facet,
      prior_facet:
        existing && isActiveWorkStatus(existing.status)
          ? existing.thread_facet
          : undefined,
    });
    if (!subject) {
      return;
    }
    const recipe = selectRecipeForSubject(input.recipes, subject);
    const byUnit = await authority.getWorkItemByUnitKey(
      orgId,
      input.threadId,
      input.event.id,
    );
      if (byUnit) {
      if (recipe && recipeAllowsPushDispatch(recipe)) {
        await this.retryOrResume(
          byUnit,
          recipe,
          input.body.body_text,
          recipe.max_concurrent !== undefined,
        );
      }
      return;
    }
    const next = openOrUpdateWorkItem({
      existing,
      org_id: orgId,
      subject,
      head_event_id: input.event.id,
      recipe,
      now: new Date().toISOString(),
    });
    if (!next) {
      return;
    }
    const saved = await authority.putWorkItem(next);
    if (saved.status === "open" && recipe && recipeAllowsPushDispatch(recipe)) {
      await this.retryOrResume(
        saved,
        recipe,
        input.body.body_text,
        recipe.max_concurrent !== undefined,
      );
    }
  }

  private async noteStartFailed(
    item: WorkItem,
    recipe: Recipe,
    error: string,
    mode: "auto" | "manual",
  ): Promise<void> {
    const now = new Date().toISOString();
    const host = this.runtime.requireHost();
    await host.get("authority").putWorkRun(
      failedWorkStart({ item, recipe, error, now }),
    );
    if (mode === "auto") {
      await host.get("authority").putWorkItem({
        ...item,
        status: "failed",
        updated_at: now,
      });
      console.error("personal work start failed", error);
    }
  }
}

function failedRunCount(runs: WorkRun[]): number {
  return runs.filter((run) => run.status === "failed").length;
}

function uniqueInboxItems(rows: InboxItem[]): InboxItem[] {
  const seen = new Set<string>();
  const unique: InboxItem[] = [];
  for (const row of rows) {
    if (seen.has(row.event.id)) {
      continue;
    }
    seen.add(row.event.id);
    unique.push(row);
  }
  return unique;
}
