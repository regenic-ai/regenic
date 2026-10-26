import type { ExecutorInstallation, ExecutorStore } from "./executor-installation";
import { currentJobOnSession } from "./job-control";
import type {
  Recipe,
  WorkDelivery,
  WorkItem,
  WorkRun,
  WorkRunStartClaim,
  WorkStore,
} from "./work";
import { isActiveWorkStatus } from "./work";
import type { WorkItemStatus } from "./work";
import { shouldFlushDelivery } from "./work-delivery";
import type { SearchAnswerRecord } from "./search-answer";

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
    this.items.set(item.id, { ...item });
    return { ...item };
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
    const active = [...this.runs.values()].filter(
      (run) =>
        run.org_id === orgId &&
        run.work_item_id === workItemId &&
        (run.status === "running" || run.status === "waiting_human"),
    );
    active.sort((left, right) =>
      left.updated_at < right.updated_at ? 1 : -1,
    );
    return active[0] ? cloneRun(active[0]) : null;
  }

  async putWorkRun(run: WorkRun): Promise<WorkRun> {
    this.runs.set(run.id, cloneRun(run));
    return cloneRun(run);
  }

  async claimWorkRunStart({ run, max_concurrent }: WorkRunStartClaim): Promise<boolean> {
    const item = this.items.get(run.work_item_id);
    const recipe = this.recipes.get(run.recipe_id);
    if (
      !item || item.org_id !== run.org_id || item.status !== "open" ||
      item.recipe_id !== run.recipe_id || recipe?.org_id !== run.org_id ||
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
    this.runs.set(run.id, cloneRun(run));
    this.items.set(item.id, { ...item, status: "running", updated_at: run.updated_at });
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
        (item) => item.org_id === orgId && shouldFlushDelivery(item, now),
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
      (item) => item.org_id === orgId && item.work_item_id === workItemId,
    );
    return found ? cloneDelivery(found) : null;
  }

  async putWorkDelivery(delivery: WorkDelivery): Promise<WorkDelivery> {
    this.deliveries.set(delivery.id, cloneDelivery(delivery));
    return cloneDelivery(delivery);
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
    result: run.result ? { ...run.result } : undefined,
  };
}

function cloneDelivery(delivery: WorkDelivery): WorkDelivery {
  return {
    ...delivery,
    payload: delivery.payload
      ? {
          summary: delivery.payload.summary,
          ...(delivery.payload.content
            ? { content: [...delivery.payload.content] }
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
