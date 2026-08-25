import { currentJobOnSession } from "./job-control";
import type {
  Recipe,
  WorkItem,
  WorkRun,
  WorkStore,
} from "./work";
import { isActiveWorkStatus } from "./work";

export class MemoryWorkStore implements WorkStore {
  private readonly recipes = new Map<string, Recipe>();
  private readonly items = new Map<string, WorkItem>();
  private readonly runs = new Map<string, WorkRun>();
  private readonly uiPrefs = new Map<string, string>();

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

  async listWorkItems(orgId: string): Promise<WorkItem[]> {
    return [...this.items.values()]
      .filter((item) => item.org_id === orgId)
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
