import type { ExecutorInstallation, ExecutorStore } from "./executor-installation";
import { currentJobOnSession } from "./job-control";
import type {
  Recipe,
  WorkDelivery,
  WorkItem,
  WorkRun,
  WorkRunStartClaim,
  WorkStore,
  WorkDeliveryCommand,
  WorkDeliveryCommandResult,
} from "./work";
import { isActiveWorkStatus } from "./work";
import type { WorkItemStatus } from "./work";
import { shouldFlushDelivery, isDeliveryLeaseExpired, assertWorkDeliveryWrite, planWorkDeliveryCommand } from "./work-delivery";
import type { SearchAnswerRecord } from "./search-answer";
import {
  prepareWorkObservation,
  assertWorkRunSnapshot,
  type CommitWorkObservation,
  type CommitWorkObservationResult,
} from "./work-transition";

export class MemoryWorkStore implements WorkStore, ExecutorStore {
  private readonly recipes = new Map<string, Recipe>();
  private readonly items = new Map<string, WorkItem>();
  private readonly runs = new Map<string, WorkRun>();
  private readonly deliveries = new Map<string, WorkDelivery>();
  private readonly uiPrefs = new Map<string, string>();
  private readonly searchAnswers = new Map<string, SearchAnswerRecord>();
  private readonly executors = new Map<string, ExecutorInstallation>();

  async listRecipes(orgId: string): Promise<Recipe[]> {
    return [...this.recipes.values()]
      .filter((recipe) => recipe.org_id === orgId)
      .map((recipe) => cloneRecipe(recipe));
  }

  async getRecipe(orgId: string, id: string): Promise<Recipe | null> {
    const recipe = this.recipes.get(id);
    return recipe && recipe.org_id === orgId ? cloneRecipe(recipe) : null;
  }

  async putRecipe(recipe: Recipe): Promise<Recipe> {
    this.recipes.set(recipe.id, cloneRecipe(recipe));
    return cloneRecipe(recipe);
  }

  async deleteRecipe(orgId: string, id: string): Promise<boolean> {
    const recipe = this.recipes.get(id);
    if (!recipe || recipe.org_id !== orgId) {
      return false;
    }
    this.recipes.delete(id);
    return true;
  }

  async listWorkItems(
    orgId: string,
    options?: { statuses?: readonly WorkItemStatus[] },
  ): Promise<WorkItem[]> {
    const allowed = options?.statuses ? new Set(options.statuses) : null;
    return [...this.items.values()]
      .filter(
        (item) =>
          item.org_id === orgId &&
          (allowed === null || allowed.has(item.status)),
      )
      .map((item) => ({ ...item }));
  }

  async getWorkItem(orgId: string, id: string): Promise<WorkItem | null> {
    const item = this.items.get(id);
    return item && item.org_id === orgId ? { ...item } : null;
  }

  async getWorkItemByThread(
    orgId: string,
    threadId: string,
  ): Promise<WorkItem | null> {
    const found = currentJobOnSession(
      [...this.items.values()].filter((item) => item.org_id === orgId),
      threadId,
    );
    return found ? { ...found } : null;
  }

  async getWorkItemByUnitKey(
    orgId: string,
    threadId: string,
    unitKey: string,
  ): Promise<WorkItem | null> {
    const found = [...this.items.values()].find(
      (item) =>
        item.org_id === orgId &&
        item.thread_id === threadId &&
        item.unit_key === unitKey,
    );
    return found ? { ...found } : null;
  }

  async putWorkItem(item: WorkItem): Promise<WorkItem> {
    const current = this.items.get(item.id);
    const saved = {
      ...item,
      ...(current ? { current_run_id: current.current_run_id } : { current_run_id: undefined }),
      version: current ? (current.version ?? 0) + 1 : item.version ?? 0,
    };
    this.items.set(item.id, saved);
    return { ...saved };
  }

  async listWorkRuns(orgId: string, workItemId?: string): Promise<WorkRun[]> {
    return [...this.runs.values()]
      .filter(
        (run) =>
          run.org_id === orgId &&
          (workItemId === undefined || run.work_item_id === workItemId),
      )
      .map((run) => cloneRun(run));
  }

  async getWorkRun(orgId: string, id: string): Promise<WorkRun | null> {
    const run = this.runs.get(id);
    return run && run.org_id === orgId ? cloneRun(run) : null;
  }

  async getActiveWorkRun(
    orgId: string,
    workItemId: string,
  ): Promise<WorkRun | null> {
    const item = this.items.get(workItemId);
    if (!item || item.org_id !== orgId || !item.current_run_id) return null;
    const current = this.runs.get(item.current_run_id);
    return current && current.org_id === orgId && current.work_item_id === workItemId
      && (current.status === "running" || current.status === "waiting_human")
      ? cloneRun(current)
      : null;
  }

  async putWorkRun(run: WorkRun): Promise<WorkRun> {
    const current = this.runs.get(run.id);
    assertWorkRunSnapshot(run, current);
    const saved = { ...cloneRun(run), version: current ? (current.version ?? 0) + 1 : run.version ?? 0 };
    this.runs.set(run.id, saved);
    return cloneRun(saved);
  }

  async commitWorkObservation(input: CommitWorkObservation): Promise<CommitWorkObservationResult> {
    const { expected_item: expectedItem, expected_run: expectedRun } = input;
    const item = this.items.get(expectedItem.id);
    const run = this.runs.get(expectedRun.id);
    const delivery = [...this.deliveries.values()].find(
      (row) => row.org_id === expectedItem.org_id && row.work_item_id === expectedItem.id
        && (expectedRun.write_back_required === undefined ? !row.run_id : row.run_id === expectedRun.id),
    );
    const prepared = prepareWorkObservation(input, {
      item: item?.org_id === expectedItem.org_id ? item : null,
      run: run?.org_id === expectedItem.org_id ? run : null,
      delivery: delivery ?? null,
    });
    if (prepared.outcome !== "applied") return prepared;
    const nextRun = structuredClone(prepared.transition.run);
    const nextItem = { ...prepared.transition.item };
    const nextDelivery = prepared.delivery ? structuredClone(prepared.delivery) : undefined;
    if (nextDelivery) assertWorkDeliveryWrite(
      nextDelivery, this.deliveries.get(nextDelivery.id), nextRun, true,
    );
    this.runs.set(nextRun.id, nextRun);
    this.items.set(nextItem.id, nextItem);
    if (nextDelivery) this.deliveries.set(nextDelivery.id, nextDelivery);
    return { outcome: "applied", transition: prepared.transition };
  }

  async claimWorkRunStart({ run, max_concurrent }: WorkRunStartClaim): Promise<boolean> {
    assertWorkRunSnapshot(run);
    const item = this.items.get(run.work_item_id);
    const recipe = this.recipes.get(run.recipe_id);
    if (
      !item || item.org_id !== run.org_id || item.status !== "open" ||
      item.recipe_id !== run.recipe_id || recipe?.org_id !== run.org_id ||
      [...this.deliveries.values()].some((delivery) =>
        delivery.org_id === run.org_id && delivery.work_item_id === item.id && delivery.status !== "acked") ||
      [...this.runs.values()].some((current) =>
        current.org_id === run.org_id && current.work_item_id === item.id &&
        (current.status === "running" || current.status === "waiting_human"))
    ) {
      return false;
    }
    const occupied = [...this.items.values()].filter((current) =>
      current.org_id === run.org_id && current.recipe_id === run.recipe_id &&
      (current.status === "running" || current.status === "waiting_human")).length;
    if (max_concurrent !== undefined && occupied >= max_concurrent) {
      return false;
    }
    if (this.runs.has(run.id)) {
      throw new Error(`Work run already exists: ${run.id}`);
    }
    this.runs.set(run.id, { ...cloneRun(run), version: run.version ?? 0 });
    this.items.set(item.id, {
      ...item,
      status: "running",
      current_run_id: run.id,
      version: (item.version ?? 0) + 1,
      updated_at: run.updated_at,
    });
    return true;
  }

  async listHiddenExecutorThreadIds(orgId: string): Promise<string[]> {
    const sources = new Set(
      [...this.items.values()]
        .filter((item) => item.org_id === orgId)
        .map((item) => item.thread_id),
    );
    const hidden = new Set<string>();
    for (const run of this.runs.values()) {
      if (
        run.org_id === orgId &&
        run.agent_thread_id &&
        !sources.has(run.agent_thread_id)
      ) {
        hidden.add(run.agent_thread_id);
      }
    }
    return [...hidden];
  }

  async listWorkDeliveries(orgId: string): Promise<WorkDelivery[]> {
    return [...this.deliveries.values()]
      .filter((item) => item.org_id === orgId)
      .map((item) => cloneDelivery(item));
  }

  async listDueWorkDeliveries(
    orgId: string,
    now: string,
  ): Promise<WorkDelivery[]> {
    return [...this.deliveries.values()]
      .filter(
        (item) => item.org_id === orgId && Boolean(item.payload)
          && (shouldFlushDelivery(item, now) || isDeliveryLeaseExpired(item, now)),
      )
      .map((item) => cloneDelivery(item));
  }

  async getWorkDelivery(orgId: string, id: string): Promise<WorkDelivery | null> {
    const item = this.deliveries.get(id);
    return item && item.org_id === orgId ? cloneDelivery(item) : null;
  }

  async getWorkDeliveryByItem(
    orgId: string,
    workItemId: string,
  ): Promise<WorkDelivery | null> {
    const found = [...this.deliveries.values()].find(
      (row) => row.org_id === orgId && row.work_item_id === workItemId
        && (row.run_id
          ? row.run_id === this.items.get(workItemId)?.current_run_id
          : this.runs.get(this.items.get(workItemId)?.current_run_id ?? "")?.write_back_required === undefined),
    );
    return found ? cloneDelivery(found) : null;
  }

  async putWorkDelivery(delivery: WorkDelivery): Promise<WorkDelivery> {
    assertWorkDeliveryWrite(delivery, this.deliveries.get(delivery.id),
      delivery.run_id && this.items.get(delivery.work_item_id)?.org_id === delivery.org_id
        ? this.runs.get(delivery.run_id) : undefined);
    if ([...this.deliveries.values()].some(
      (row) => row.org_id === delivery.org_id && row.id !== delivery.id
        && (delivery.run_id ? row.run_id === delivery.run_id
          : !row.run_id && row.work_item_id === delivery.work_item_id),
    )) throw new Error("Work execution already has a delivery");
    this.deliveries.set(delivery.id, cloneDelivery(delivery));
    return cloneDelivery(delivery);
  }

  async transitionWorkDelivery(input: WorkDeliveryCommand): Promise<WorkDeliveryCommandResult> {
    const current = this.deliveries.get(input.delivery_id);
    const delivery = current?.org_id === input.org_id ? current : null;
    const item = delivery ? this.items.get(delivery.work_item_id) : undefined;
    const result = planWorkDeliveryCommand(delivery,
      item?.org_id === input.org_id ? item.status : undefined, input);
    if (result.outcome === "applied") this.deliveries.set(result.delivery.id, cloneDelivery(result.delivery));
    return structuredClone(result);
  }

  async getUiPref(orgId: string, key: string): Promise<string | null> {
    return this.uiPrefs.get(`${orgId}\0${key}`) ?? null;
  }

  async putUiPref(
    orgId: string,
    key: string,
    value: string,
    _updatedAt: string,
  ): Promise<void> {
    this.uiPrefs.set(`${orgId}\0${key}`, value);
  }

  async getSearchAnswer(
    orgId: string,
    id: string,
  ): Promise<SearchAnswerRecord | null> {
    const record = this.searchAnswers.get(id);
    return record?.org_id === orgId ? structuredClone(record) : null;
  }

  async putSearchAnswer(
    record: SearchAnswerRecord,
  ): Promise<SearchAnswerRecord> {
    this.searchAnswers.set(record.id, structuredClone(record));
    return structuredClone(record);
  }

  async deleteSearchAnswer(orgId: string, id: string): Promise<boolean> {
    const record = this.searchAnswers.get(id);
    return record?.org_id === orgId && this.searchAnswers.delete(id);
  }

  async listExecutorInstallations(orgId: string): Promise<ExecutorInstallation[]> {
    return [...this.executors.values()]
      .filter((item) => item.org_id === orgId)
      .map((item) => cloneExecutor(item));
  }

  async getExecutorInstallation(
    orgId: string,
    id: string,
  ): Promise<ExecutorInstallation | null> {
    const item = this.executors.get(id);
    return item && item.org_id === orgId ? cloneExecutor(item) : null;
  }

  async putExecutorInstallation(
    installation: ExecutorInstallation,
  ): Promise<ExecutorInstallation> {
    this.executors.set(installation.id, cloneExecutor(installation));
    return cloneExecutor(installation);
  }

  async deleteExecutorInstallation(orgId: string, id: string): Promise<boolean> {
    const item = this.executors.get(id);
    if (!item || item.org_id !== orgId) {
      return false;
    }
    this.executors.delete(id);
    return true;
  }

  dropOperationalWork(orgId: string): number {
    let count = 0;
    for (const [id, item] of [...this.items]) {
      if (item.org_id === orgId) {
        this.items.delete(id);
        count += 1;
      }
    }
    for (const [id, run] of [...this.runs]) {
      if (run.org_id === orgId) {
        this.runs.delete(id);
      }
    }
    for (const [id, delivery] of [...this.deliveries]) {
      if (delivery.org_id === orgId) {
        this.deliveries.delete(id);
      }
    }
    return count;
  }

  workItemCount(orgId: string): number {
    return [...this.items.values()].filter((item) => item.org_id === orgId).length;
  }

  recipeCount(orgId: string): number {
    return [...this.recipes.values()].filter((recipe) => recipe.org_id === orgId)
      .length;
  }

  executorCount(orgId: string): number {
    return [...this.executors.values()].filter((item) => item.org_id === orgId)
      .length;
  }

  activeItems(orgId: string): WorkItem[] {
    return [...this.items.values()].filter(
      (item) => item.org_id === orgId && isActiveWorkStatus(item.status),
    );
  }
}

function cloneRecipe(recipe: Recipe): Recipe {
  return {
    ...recipe,
    match: { ...recipe.match },
    executor_config: { ...recipe.executor_config },
  };
}

function cloneRun(run: WorkRun): WorkRun {
  return {
    ...run,
    result: run.result ? structuredClone(run.result) : undefined,
    ...(run.write_back_target ? { write_back_target: { ...run.write_back_target } } : {}),
  };
}

function cloneDelivery(delivery: WorkDelivery): WorkDelivery {
  return {
    ...delivery,
    ...(delivery.target ? { target: { ...delivery.target } } : {}),
    payload: delivery.payload
      ? {
          summary: delivery.payload.summary,
          ...(delivery.payload.content
            ? { content: structuredClone(delivery.payload.content) }
            : {}),
        }
      : undefined,
    channel_receipt: delivery.channel_receipt
      ? { ...delivery.channel_receipt }
      : undefined,
  };
}

function cloneExecutor(item: ExecutorInstallation): ExecutorInstallation {
  return {
    ...item,
    config: { ...item.config },
  };
}
