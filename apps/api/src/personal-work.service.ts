import { Inject, Injectable, OnModuleDestroy, forwardRef } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  ChannelDriverRegistry,
  resolveExecutorCatalog,
  INBOX_LIST_PREF_KEY,
  INBOX_MEMBERSHIP_PREF_KEY,
  INBOX_SORT_PREF_KEY,
  cancelWorkRun,
  foldThreadByPolicy,
  deliveryAbandoned,
  hiddenExecutorThreadIds,
  isActiveWorkStatus,
  isDeadLetter,
  normalizeInboxListView,
  normalizeInboxSort,
  parseConversationThread,
  recipeMatches,
  shouldFlushDelivery,
  shouldRefreshActiveRun,
  workSubjectFromEvent,
  type ConversationThread,
  type InboxListView,
  type InboxSortMode,
  type PromptAnswer,
  type Recipe,
  type ThreadPrompt,
  type WorkItem,
  type WorkRun,
  type WorkRunStatus,
} from "@regenic/domain";
import { PersonalConnectorError, storeBusyError } from "./personal-errors";
import { PersonalInboxService } from "./personal-inbox.service";
import { PersonalExecutorService } from "./personal-executor.service";
import { PersonalConnectorService } from "./personal-connector.service";
import { PersonalRuntimeService } from "./personal-runtime.service";
import { backgroundSyncReleased } from "./personal-interactive-gate";
import { PersonalWorkChannel } from "./personal-work-channel";
import { PersonalWorkDispatch } from "./personal-work-dispatch";
import { workInboxFaces, type WorkInboxFace } from "./personal-work-faces";
import { PersonalWorkFlush } from "./personal-work-flush";
import { normalizeRecipe, type RecipeInput } from "./personal-work-recipe";
import {
  delay,
  forceDisposition,
  isWorkTickShutdown,
} from "./personal-work-support";
import { PersonalWorkWait } from "./personal-work-wait";
import { PersonalWorkSupervise } from "./personal-work-supervise";

export type { RecipeInput } from "./personal-work-recipe";
export type { WorkInboxFace } from "./personal-work-faces";

const WORK_TICK_MS = 3_000;

export interface UiPrefsView {
  inbox_sort: InboxSortMode;
  inbox_list: InboxListView;
}

export interface WorkRunView {
  work_item: WorkItem;
  run?: WorkRun;
}

export interface RecipeLastRun {
  status: WorkRunStatus;
  at: string;
  summary?: string;
  thread_id?: string;
}

export interface RecipeView extends Recipe {
  last_run?: RecipeLastRun;
  /** Newest first; includes last_run when present. */
  recent_runs?: RecipeLastRun[];
}

@Injectable()
export class PersonalWorkService implements OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | undefined;
  private dispatching = false;
  private supervising = false;
  private flushing = false;
  private backgroundStarted = false;
  private maintenanceHold = false;
  private readonly channel: PersonalWorkChannel;
  private readonly dispatch: PersonalWorkDispatch;
  private readonly supervise: PersonalWorkSupervise;
  private readonly flush: PersonalWorkFlush;
  private readonly waits: PersonalWorkWait;

  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
    @Inject(ChannelDriverRegistry)
    drivers: ChannelDriverRegistry,
    @Inject(forwardRef(() => PersonalExecutorService))
    private readonly executors: PersonalExecutorService,
    @Inject(forwardRef(() => PersonalInboxService))
    private readonly inbox: PersonalInboxService,
    @Inject(forwardRef(() => PersonalConnectorService))
    connectors: PersonalConnectorService,
  ) {
    this.channel = new PersonalWorkChannel(runtime, drivers);
    this.supervise = new PersonalWorkSupervise(runtime, this.channel, () => {
      this.inbox.touchInboxDigest();
    });
    this.waits = new PersonalWorkWait(runtime, drivers, connectors, this.supervise);
    this.supervise.bindWaits(this.waits);
    this.dispatch = new PersonalWorkDispatch(runtime, this.channel, this.supervise, this.waits);
    this.flush = new PersonalWorkFlush(runtime, this.channel);
  }

  startAfterListen(): void {
    if (this.backgroundStarted) {
      return;
    }
    this.backgroundStarted = true;
    void this.executors?.ensureMounted().catch((error) => {
      if (!isWorkTickShutdown(error)) {
        console.error("executor mount failed", error);
      }
    });
    this.timer = setInterval(() => {
      void this.afterConnectorTick();
    }, WORK_TICK_MS);
    void this.waits.attachActive().catch((error) => {
      if (!isWorkTickShutdown(error)) {
        console.error("personal work wait attach failed", error);
      }
    });
    void this.afterConnectorTick();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.waits.dropAll();
  }

  async pauseForMaintenance(): Promise<void> {
    this.maintenanceHold = true;
    try {
      await this.waitForQuiet();
    } catch (error) {
      this.maintenanceHold = false;
      throw error;
    }
  }

  resumeAfterMaintenance(): void {
    this.maintenanceHold = false;
  }

  private async waitForQuiet(timeoutMs = 10_000): Promise<void> {
    const started = Date.now();
    while (this.dispatching || this.supervising || this.flushing) {
      if (Date.now() - started > timeoutMs) {
        throw storeBusyError();
      }
      await delay(50);
    }
  }

  async afterConnectorTick(): Promise<void> {
    if (this.maintenanceHold || !this.runtime.isReady()) {
      return;
    }
    if (!backgroundSyncReleased()) {
      return;
    }
    await Promise.all([
      this.tickDispatch(),
      this.tickSupervise(),
      this.tickFlush(),
    ]);
  }

  private async tickDispatch(): Promise<void> {
    if (this.maintenanceHold || this.dispatching || !this.runtime.isReady()) {
      return;
    }
    this.dispatching = true;
    try {
      await this.executors.ensureMounted();
      if (!this.runtime.isReady()) {
        return;
      }
      await this.dispatch.reconcileInbox();
      await this.dispatch.dispatchPullRecipes();
    } catch (error) {
      if (!isWorkTickShutdown(error)) {
        console.error("personal work dispatch failed", error);
      }
    } finally {
      this.dispatching = false;
    }
  }

  private async tickSupervise(): Promise<void> {
    if (this.maintenanceHold || this.supervising || !this.runtime.isReady()) {
      return;
    }
    this.supervising = true;
    try {
      await this.executors.ensureMounted();
      if (!this.runtime.isReady()) {
        return;
      }
      await this.supervise.refreshRuns();
    } catch (error) {
      if (!isWorkTickShutdown(error)) {
        console.error("personal work supervise failed", error);
      }
    } finally {
      this.supervising = false;
    }
  }

  private async tickFlush(): Promise<void> {
    if (this.maintenanceHold || this.flushing || !this.runtime.isReady()) {
      return;
    }
    this.flushing = true;
    try {
      await this.executors.ensureMounted();
      if (!this.runtime.isReady()) {
        return;
      }
      await this.flush.flushDeliveries();
    } catch (error) {
      if (!isWorkTickShutdown(error)) {
        console.error("personal work flush failed", error);
      }
    } finally {
      this.flushing = false;
    }
  }

  async listRecipes(): Promise<RecipeView[]> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const authority = host.get("authority");
    const [recipes, runs, items] = await Promise.all([
      authority.listRecipes(orgId),
      authority.listWorkRuns(orgId),
      authority.listWorkItems(orgId),
    ]);
    const threadByWorkItem = new Map(
      items.map((item) => [item.id, item.thread_id] as const),
    );
    return recipes.map((recipe) => {
      const recent_runs = recentRunsForRecipe(
        runs,
        recipe.id,
        threadByWorkItem,
      );
      return {
        ...recipe,
        ...(recent_runs[0] ? { last_run: recent_runs[0] } : {}),
        ...(recent_runs.length ? { recent_runs } : {}),
      };
    });
  }

  async listExecutors(locale?: import("@regenic/domain").CopyLocale) {
    return this.executors.listCatalog(locale);
  }

  async putRecipe(input: RecipeInput, id?: string): Promise<Recipe> {
    await this.executors.ensureMounted();
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const now = new Date().toISOString();
    const existing = id
      ? await host.get("authority").getRecipe(orgId, id)
      : null;
    if (id && !existing) {
      throw new PersonalConnectorError("not_found", "Recipe not found", 404);
    }
    let recipe = normalizeRecipe(input, orgId, now, existing ?? undefined);
    const executor = host.get("executors").get(recipe.executor_type);
    if (!executor) {
      throw new PersonalConnectorError(
        "invalid_config",
        `Unknown executor: ${recipe.executor_type}`,
        400,
      );
    }
    const missing = missingCatalogFields(
      resolveExecutorCatalog(executor.catalog(), executor.locales?.() ?? [])
        .fields,
      recipe.executor_config,
    );
    if (missing) {
      throw new PersonalConnectorError(
        "invalid_config",
        `${missing} is required`,
        400,
      );
    }
    const threadId = recipe.match.thread_id?.trim();
    if (recipe.can_write_back && threadId) {
      const canReply = await this.channel.canReplyThread(threadId);
      if (canReply === false) {
        recipe = { ...recipe, can_write_back: false };
      }
    }
    const saved = await host.get("authority").putRecipe(recipe);
    void this.afterConnectorTick();
    return saved;
  }

  async deleteRecipe(id: string): Promise<{ id: string; removed: true }> {
    const host = this.runtime.requireHost();
    const removed = await host.get("authority").deleteRecipe(this.runtime.orgId(), id);
    if (!removed) {
      throw new PersonalConnectorError("not_found", "Recipe not found", 404);
    }
    return { id, removed: true };
  }

  /**
   * Manual one-shot: open/rebind a work item on a chat and start this recipe.
   * Pass write_back: false to keep the result in Current work (default for try).
   */
  async tryRecipe(
    id: string,
    input?: { thread_id?: string; write_back?: boolean },
  ): Promise<WorkRunView & { thread_id: string }> {
    await this.executors.ensureMounted();
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const recipe = await host.get("authority").getRecipe(orgId, id);
    if (!recipe) {
      throw new PersonalConnectorError("not_found", "Recipe not found", 404);
    }
    if (!recipe.enabled) {
      throw new PersonalConnectorError(
        "invalid_config",
        "Turn the rule on before trying it",
        400,
      );
    }
    const threadId =
      input?.thread_id?.trim() || recipe.match.thread_id?.trim() || "";
    if (!threadId) {
      throw new PersonalConnectorError(
        "invalid_config",
        "Pick one chat to try this rule",
        400,
      );
    }
    try {
      parseConversationThread(threadId);
    } catch {
      throw new PersonalConnectorError("invalid_config", "Invalid chat id", 400);
    }
    const authority = host.get("authority");
    const existing = await authority.getWorkItemByThread(orgId, threadId);
    if (
      existing &&
      isActiveWorkStatus(existing.status) &&
      existing.recipe_id &&
      existing.recipe_id !== recipe.id
    ) {
      throw new PersonalConnectorError(
        "conflict",
        "Another rule is already running on this chat",
        409,
      );
    }
    const subject = workSubjectFromEvent({
      type: recipe.match.record_class === "task" ? "task" : "message",
      source: recipe.match.source ?? threadId.split(":")[0] ?? "",
      thread_id: threadId,
      unit_kind: recipe.match.unit_kind,
      hint: recipe.match.thread_facet ?? existing?.thread_facet,
      prior_facet: existing?.thread_facet,
    });
    if (!subject) {
      throw new PersonalConnectorError(
        "invalid_config",
        "This chat cannot start work",
        400,
      );
    }
    if (!recipeMatches(recipe.match, subject)) {
      throw new PersonalConnectorError(
        "invalid_config",
        "This rule does not match that chat",
        400,
      );
    }
    const now = new Date().toISOString();
    const item =
      existing &&
      (existing.status === "open" ||
        existing.status === "failed" ||
        existing.status === "done" ||
        existing.status === "skipped")
        ? await authority.putWorkItem({
            ...existing,
            status: "open",
            recipe_id: recipe.id,
            record_class: subject.record_class,
            thread_facet: subject.thread_facet,
            updated_at: now,
          })
        : existing && isActiveWorkStatus(existing.status)
          ? await authority.putWorkItem({
              ...existing,
              recipe_id: recipe.id,
              updated_at: now,
            })
          : await authority.putWorkItem({
              id: `work-${randomUUID()}`,
              org_id: orgId,
              thread_id: threadId,
              unit_key: `try:${recipe.id}:${now}`,
              record_class: subject.record_class,
              thread_facet: subject.thread_facet,
              status: "open",
              recipe_id: recipe.id,
              created_at: now,
              updated_at: now,
            });
    const allowWriteBack =
      input?.write_back === true && Boolean(recipe.can_write_back);
    this.supervise.setWriteBackOverride(item.id, allowWriteBack);
    try {
      const result = await this.runWorkItem(item.id);
      this.inbox.touchInboxDigest();
      return { ...result, thread_id: threadId };
    } catch (error) {
      this.supervise.clearWriteBackOverride(item.id);
      throw error;
    }
  }

  async getPrefs(): Promise<UiPrefsView> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const [sort, list, legacy] = await Promise.all([
      host.get("authority").getUiPref(orgId, INBOX_SORT_PREF_KEY),
      host.get("authority").getUiPref(orgId, INBOX_LIST_PREF_KEY),
      host.get("authority").getUiPref(orgId, INBOX_MEMBERSHIP_PREF_KEY),
    ]);
    return {
      inbox_sort: normalizeInboxSort(sort),
      inbox_list: normalizeInboxListView(list ?? legacy),
    };
  }

  async putPrefs(input: {
    inbox_sort?: string;
    inbox_list?: string;
    inbox_membership?: string;
  }): Promise<UiPrefsView> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const now = new Date().toISOString();
    if (input.inbox_sort !== undefined) {
      await host.get("authority").putUiPref(
        orgId,
        INBOX_SORT_PREF_KEY,
        normalizeInboxSort(input.inbox_sort),
        now,
      );
    }
    const list = input.inbox_list ?? input.inbox_membership;
    if (list !== undefined) {
      await host.get("authority").putUiPref(
        orgId,
        INBOX_LIST_PREF_KEY,
        normalizeInboxListView(list),
        now,
      );
    }
    return this.getPrefs();
  }

  async inboxFaces(
    threadIds: string[],
    extraPrompts: ReadonlyMap<string, ThreadPrompt[]> = new Map(),
  ): Promise<Map<string, WorkInboxFace>> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const authority = host.get("authority");
    const [items, runs, recipes, deliveries] = await Promise.all([
      authority.listWorkItems(orgId),
      authority.listWorkRuns(orgId),
      authority.listRecipes(orgId),
      authority.listWorkDeliveries(orgId),
    ]);
    return workInboxFaces({
      threadIds,
      items,
      runs,
      recipes,
      deliveries,
      extraPrompts,
    });
  }

  async activeSessionIds(): Promise<Set<string>> {
    if (!this.runtime.isReady()) {
      return new Set();
    }
    const items = await this.runtime
      .requireHost()
      .get("authority")
      .listWorkItems(this.runtime.orgId());
    return new Set(
      items
        .filter((item) => isActiveWorkStatus(item.status))
        .map((item) => item.thread_id),
    );
  }

  async hiddenThreadIds(): Promise<Set<string>> {
    if (!this.runtime.isReady()) {
      return new Set();
    }
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const [items, runs] = await Promise.all([
      host.get("authority").listWorkItems(orgId),
      host.get("authority").listWorkRuns(orgId),
    ]);
    return hiddenExecutorThreadIds(items, runs);
  }

  async boundPromptThreads(): Promise<Map<string, string>> {
    const hidden = await this.hiddenThreadIds();
    if (hidden.size === 0) {
      return new Map();
    }
    const host = this.runtime.requireHost();
    const runs = await host.get("authority").listWorkRuns(this.runtime.orgId());
    const items = await host.get("authority").listWorkItems(this.runtime.orgId());
    const itemById = new Map(items.map((item) => [item.id, item]));
    const bound = new Map<string, string>();
    for (const run of runs) {
      if (!run.agent_thread_id || !hidden.has(run.agent_thread_id)) {
        continue;
      }
      const item = itemById.get(run.work_item_id);
      if (item) {
        bound.set(item.thread_id, run.agent_thread_id);
      }
    }
    return bound;
  }

  async promptTargetThread(
    threadId: string,
    promptId: string,
    sourceHasPrompt: boolean,
  ): Promise<ConversationThread> {
    if (sourceHasPrompt) {
      return parseConversationThread(threadId);
    }
    const faces = await this.inboxFaces([threadId]);
    const agentId = faces.get(threadId)?.agent_thread_id;
    return parseConversationThread(agentId || threadId);
  }

  async afterPrompt(threadId: string, answer?: PromptAnswer): Promise<void> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const item = await host.get("authority").getWorkItemByThread(orgId, threadId);
    if (!item) {
      return;
    }
    const run = await host.get("authority").getActiveWorkRun(orgId, item.id);
    if (!run) {
      return;
    }
    const recipe = item.recipe_id
      ? await host.get("authority").getRecipe(orgId, item.recipe_id)
      : null;
    const executor = host.get("executors").get(run.executor_type);
    if (!recipe || !executor) {
      return;
    }
    const handle = await executor.resume(
      { run, work_item: item, recipe, answer },
      this.channel.contextFor(executor),
    );
    await this.supervise.applyHandle(item, recipe, run, handle);
    const latestItem = await host.get("authority").getWorkItem(orgId, item.id);
    const latestRun = await host.get("authority").getActiveWorkRun(orgId, item.id);
    if (
      latestItem &&
      latestRun &&
      isActiveWorkStatus(latestItem.status)
    ) {
      this.waits.attach(latestItem, latestRun, executor);
    }
  }

  async ackDoneThread(threadId: string): Promise<void> {
    const host = this.runtime.requireHost();
    const item = await host
      .get("authority")
      .getWorkItemByThread(this.runtime.orgId(), threadId);
    if (!item || isActiveWorkStatus(item.status) || !item.head_event_id) {
      return;
    }
    const event = await host.get("authority").getEvent(item.org_id, item.head_event_id);
    if (!event) {
      return;
    }
    const now = new Date().toISOString();
    await forceDisposition(
      host.get("authority"),
      event,
      "outside_current_work",
      "work_acked",
      now,
    );
    await foldThreadByPolicy(
      host.get("authority"),
      item.org_id,
      threadId,
      now,
    );
    this.inbox.touchInboxDigest();
  }

  async runWorkItem(id: string): Promise<WorkRunView> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const item = await host.get("authority").getWorkItem(orgId, id);
    if (!item) {
      throw new PersonalConnectorError("not_found", "Work item not found", 404);
    }
    const recipe = item.recipe_id
      ? await host.get("authority").getRecipe(orgId, item.recipe_id)
      : null;
    if (!recipe) {
      throw new PersonalConnectorError(
        "invalid_config",
        "This work item has no recipe",
        400,
      );
    }
    const delivery = await host.get("authority").getWorkDeliveryByItem(orgId, item.id);
    if (
      delivery &&
      (delivery.write_back === "failed" || isDeadLetter(delivery)) &&
      item.status === "done"
    ) {
      await this.flush.flushOne(item, recipe, delivery, true);
      return {
        work_item: (await host.get("authority").getWorkItem(orgId, item.id)) ?? item,
        run: (await host.get("authority").getActiveWorkRun(orgId, item.id)) ?? undefined,
      };
    }
    const active = await host.get("authority").getActiveWorkRun(orgId, item.id);
    if (active && shouldRefreshActiveRun(item.status)) {
      await this.supervise.refreshOne(item, recipe, active);
      return {
        work_item: (await host.get("authority").getWorkItem(orgId, item.id)) ?? item,
        run: (await host.get("authority").getActiveWorkRun(orgId, item.id)) ?? active,
      };
    }
    if (active) {
      await host.get("authority").putWorkRun(
        cancelWorkRun(active, new Date().toISOString()),
      );
    }
    const opened =
      item.status === "open"
        ? item
        : await host.get("authority").putWorkItem({
            ...item,
            status: "open",
            updated_at: new Date().toISOString(),
          });
    const run = await this.dispatch.startItem(opened, recipe, undefined, "manual");
    const latest =
      (await host.get("authority").getWorkItem(orgId, opened.id)) ?? opened;
    const queued = await host.get("authority").getWorkDeliveryByItem(orgId, opened.id);
    if (queued && shouldFlushDelivery(queued, new Date().toISOString())) {
      await this.flush.flushOne(latest, recipe, queued);
    }
    return {
      work_item: (await host.get("authority").getWorkItem(orgId, opened.id)) ?? latest,
      run,
    };
  }

  async dismissWorkItem(id: string): Promise<WorkRunView> {
    const host = this.runtime.requireHost();
    const orgId = this.runtime.orgId();
    const item = await host.get("authority").getWorkItem(orgId, id);
    if (!item) {
      throw new PersonalConnectorError("not_found", "Work item not found", 404);
    }
    const now = new Date().toISOString();
    const next =
      item.status === "skipped"
        ? item
        : await host.get("authority").putWorkItem({
            ...item,
            status: "skipped",
            updated_at: now,
          });
    const run = await host.get("authority").getActiveWorkRun(orgId, item.id);
    if (run) {
      const executor = host.get("executors").get(run.executor_type);
      if (executor?.cancel) {
        try {
          await executor.cancel(run, this.channel.contextFor(executor));
        } catch {
          // Ledger unfollow still stands if the inferior ignores cancel.
        }
      }
    }
    const cancelled = run
      ? await host.get("authority").putWorkRun(cancelWorkRun(run, now))
      : undefined;
    const delivery = await host.get("authority").getWorkDeliveryByItem(orgId, item.id);
    if (delivery && delivery.status !== "acked") {
      await host.get("authority").putWorkDelivery(deliveryAbandoned(delivery, now));
    }
    await foldThreadByPolicy(host.get("authority"), orgId, next.thread_id, now);
    this.supervise.clearWriteBackOverride(item.id);
    this.inbox.touchInboxDigest();
    return {
      work_item: next,
      run: cancelled,
    };
  }

  /** @deprecated Human dismiss. Does not fake an executor exit or write back. */
  async completeWorkItem(id: string): Promise<WorkRunView> {
    return this.dismissWorkItem(id);
  }
}

const RECIPE_RECENT_RUN_LIMIT = 5;

function recentRunsForRecipe(
  runs: WorkRun[],
  recipeId: string,
  threadByWorkItem: Map<string, string>,
  limit = RECIPE_RECENT_RUN_LIMIT,
): RecipeLastRun[] {
  return runs
    .filter((run) => run.recipe_id === recipeId)
    .sort((left, right) =>
      left.updated_at < right.updated_at
        ? 1
        : left.updated_at > right.updated_at
          ? -1
          : 0,
    )
    .slice(0, limit)
    .map((run) => {
      const summary = run.result?.summary?.trim();
      const thread_id = threadByWorkItem.get(run.work_item_id)?.trim();
      return {
        status: run.status,
        at: run.updated_at,
        ...(summary ? { summary } : {}),
        ...(thread_id ? { thread_id } : {}),
      };
    });
}

function missingCatalogFields(
  fields: Array<{ key: string; label: unknown; required?: boolean }>,
  config: Record<string, unknown>,
): string | undefined {
  for (const field of fields) {
    if (!field.required) {
      continue;
    }
    const value = config[field.key];
    if (typeof value !== "string" || !value.trim()) {
      return typeof field.label === "string" ? field.label : field.key;
    }
  }
  return undefined;
}
