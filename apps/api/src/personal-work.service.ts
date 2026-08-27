import { Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  ChannelDriverRegistry,
  INBOX_SORT_PREF_KEY,
  cancelWorkRun,
  deliveryAbandoned,
  hiddenExecutorThreadIds,
  isActiveWorkStatus,
  isDeadLetter,
  normalizeInboxSort,
  parseConversationThread,
  shouldFlushDelivery,
  shouldRefreshActiveRun,
  type ConversationThread,
  type InboxSortMode,
  type PromptAnswer,
  type Recipe,
  type ThreadPrompt,
  type WorkItem,
  type WorkRun,
} from "@regenic/domain";
import { PersonalConnectorError, storeBusyError } from "./personal-errors";
import { PersonalExecutorService } from "./personal-executor.service";
import { PersonalRuntimeService } from "./personal-runtime.service";
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
import { PersonalWorkSupervise } from "./personal-work-supervise";

export type { RecipeInput } from "./personal-work-recipe";
export type { WorkInboxFace } from "./personal-work-faces";

const WORK_TICK_MS = 3_000;

export interface UiPrefsView {
  inbox_sort: InboxSortMode;
}

export interface WorkRunView {
  work_item: WorkItem;
  run?: WorkRun;
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

  constructor(
    private readonly runtime: PersonalRuntimeService,
    drivers: ChannelDriverRegistry,
    private readonly executors: PersonalExecutorService,
  ) {
    this.channel = new PersonalWorkChannel(runtime, drivers);
    this.supervise = new PersonalWorkSupervise(runtime, this.channel);
    this.dispatch = new PersonalWorkDispatch(runtime, this.channel, this.supervise);
    this.flush = new PersonalWorkFlush(runtime, this.channel);
  }

  startAfterListen(): void {
    if (this.backgroundStarted) {
      return;
    }
    this.backgroundStarted = true;
    void this.executors.ensureMounted().catch((error) => {
      if (!isWorkTickShutdown(error)) {
        console.error("executor mount failed", error);
      }
    });
    this.timer = setInterval(() => {
      void this.afterConnectorTick();
    }, WORK_TICK_MS);
    void this.afterConnectorTick();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
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

  async listRecipes(): Promise<Recipe[]> {
    const host = this.runtime.requireHost();
    return host.get("authority").listRecipes(this.runtime.orgId());
  }

  async listExecutors() {
    return this.executors.listCatalog();
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
    const recipe = normalizeRecipe(input, orgId, now, existing ?? undefined);
    const executor = host.get("executors").get(recipe.executor_type);
    if (!executor) {
      throw new PersonalConnectorError(
        "invalid_config",
        `Unknown executor: ${recipe.executor_type}`,
        400,
      );
    }
    void executor;
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

  async getPrefs(): Promise<UiPrefsView> {
    const host = this.runtime.requireHost();
    const raw = await host
      .get("authority")
      .getUiPref(this.runtime.orgId(), INBOX_SORT_PREF_KEY);
    return { inbox_sort: normalizeInboxSort(raw) };
  }

  async putPrefs(input: { inbox_sort?: string }): Promise<UiPrefsView> {
    const host = this.runtime.requireHost();
    const inbox_sort = normalizeInboxSort(input.inbox_sort);
    await host.get("authority").putUiPref(
      this.runtime.orgId(),
      INBOX_SORT_PREF_KEY,
      inbox_sort,
      new Date().toISOString(),
    );
    return { inbox_sort };
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
    await forceDisposition(
      host.get("authority"),
      event,
      "outside_current_work",
      "work_acked",
      new Date().toISOString(),
    );
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
    const cancelled = run
      ? await host.get("authority").putWorkRun(cancelWorkRun(run, now))
      : undefined;
    const delivery = await host.get("authority").getWorkDeliveryByItem(orgId, item.id);
    if (delivery && delivery.status !== "acked") {
      await host.get("authority").putWorkDelivery(deliveryAbandoned(delivery, now));
    }
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
