import { randomUUID } from "node:crypto";
import type { ExecutorRunHandle } from "./executor";
import { recipeAllowsAutoStart } from "./recipe-trigger";
import { recordClassFromType, type RecordClass } from "./record-class";
import { matchRecipe, type RecipeSubject } from "./recipe-match";
import {
  mergeThreadFacet,
  projectThreadFacet,
  type ThreadFacet,
} from "./thread-facet";
import {
  isActiveWorkStatus,
  type Recipe,
  type WorkFace,
  type WorkItem,
  type WorkItemStatus,
  type WorkRun,
  type WorkRunStatus,
} from "./work";

export function shouldOpenWorkItem(input: {
  record_class: RecordClass;
  recipe?: Recipe;
}): boolean {
  if (input.record_class === "task") {
    return true;
  }
  return input.recipe !== undefined && recipeAllowsAutoStart(input.recipe.match);
}

export function workSubjectFromEvent(input: {
  type?: string;
  source: string;
  thread_id: string;
  await_reply?: boolean;
  prompts?: boolean;
  hint?: ThreadFacet;
  prior_facet?: ThreadFacet;
}): RecipeSubject | undefined {
  const record_class = recordClassFromType(input.type);
  if (!record_class) {
    return undefined;
  }
  const projected = projectThreadFacet({
    record_class,
    type: input.type,
    prompts: input.prompts,
    hint: input.hint,
  });
  return {
    record_class,
    thread_facet: mergeThreadFacet(input.prior_facet, projected),
    source: input.source,
    thread_id: input.thread_id,
  };
}

export function openOrUpdateWorkItem(input: {
  existing?: WorkItem | null;
  org_id: string;
  subject: RecipeSubject;
  head_event_id?: string;
  recipe?: Recipe;
  now: string;
}): WorkItem | undefined {
  if (!shouldOpenWorkItem({ record_class: input.subject.record_class, recipe: input.recipe })) {
    return input.existing ?? undefined;
  }
  const current = input.existing;
  const unit_key = input.head_event_id ?? current?.unit_key ?? `job:${input.subject.thread_id}`;
  if (current && isActiveWorkStatus(current.status)) {
    const next = {
      ...current,
      head_event_id: input.head_event_id ?? current.head_event_id,
      record_class: input.subject.record_class,
      thread_facet: input.subject.thread_facet,
      recipe_id: input.recipe?.id ?? current.recipe_id,
      updated_at: input.now,
    };
    if (
      next.head_event_id === current.head_event_id &&
      next.record_class === current.record_class &&
      next.thread_facet === current.thread_facet &&
      next.recipe_id === current.recipe_id
    ) {
      return current;
    }
    return next;
  }
  if (current && current.head_event_id && current.head_event_id === input.head_event_id) {
    return current;
  }
  if (current && !input.head_event_id) {
    return current;
  }
  return {
    id: `work-${randomUUID()}`,
    org_id: input.org_id,
    thread_id: input.subject.thread_id,
    unit_key,
    head_event_id: input.head_event_id,
    record_class: input.subject.record_class,
    thread_facet: input.subject.thread_facet,
    status: "open",
    recipe_id: input.recipe?.id,
    created_at: input.now,
    updated_at: input.now,
  };
}

export function selectRecipeForSubject(
  recipes: Recipe[],
  subject: RecipeSubject,
): Recipe | undefined {
  const matched = matchRecipe(recipes, subject);
  if (!matched || !recipeAllowsAutoStart(matched.match)) {
    return undefined;
  }
  return matched;
}

export function workStatusFromRun(status: WorkRunStatus): WorkItemStatus {
  switch (status) {
    case "waiting_human":
      return "waiting_human";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    default:
      return "running";
  }
}

export function workStatusFromHandle(
  handle: ExecutorRunHandle,
): WorkItemStatus {
  return workStatusFromRun(handle.status);
}

export function hiddenExecutorThreadIds(
  items: WorkItem[],
  runs: WorkRun[],
): Set<string> {
  const sources = new Set(items.map((item) => item.thread_id));
  const hidden = new Set<string>();
  for (const run of runs) {
    if (run.agent_thread_id && !sources.has(run.agent_thread_id)) {
      hidden.add(run.agent_thread_id);
    }
  }
  return hidden;
}

export function workFaceOf(
  item: WorkItem,
  recipe?: Recipe | null,
  run?: WorkRun | null,
): WorkFace {
  return {
    id: item.id,
    status: item.status,
    recipe_id: item.recipe_id,
    executor_type: run?.executor_type ?? recipe?.executor_type,
    agent_thread_id: run?.agent_thread_id,
    can_write_back: recipe?.can_write_back,
    has_result: Boolean(run?.result),
    updated_at: item.updated_at,
  };
}
