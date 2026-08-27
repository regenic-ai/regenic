import { randomUUID } from "node:crypto";
import type { ExecutorRunHandle } from "./executor";
import { recipeAllowsAutoStart } from "./recipe-trigger";
import { recordClassFromType, type RecordClass } from "./record-class";
import { matchRecipe, type RecipeSubject } from "./recipe-match";
import type { PromptAnswer, ThreadPrompt } from "./thread-surface";
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

export function isAbandonedWorkItem(
  status: WorkItemStatus | null | undefined,
): boolean {
  return status === "skipped";
}

export function shouldRefreshActiveRun(status: WorkItemStatus): boolean {
  return !isAbandonedWorkItem(status);
}

export function cancelWorkRun<T extends { status: WorkRunStatus; updated_at: string }>(
  run: T,
  now: string,
): T {
  return { ...run, status: "cancelled", updated_at: now };
}

export function workStatusFromRun(status: WorkRunStatus): WorkItemStatus {
  switch (status) {
    case "waiting_human":
      return "waiting_human";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "skipped";
    default:
      return "running";
  }
}

export function shouldWriteBackHandle(
  handle: Pick<ExecutorRunHandle, "status" | "result">,
  canWriteBack: boolean,
): boolean {
  return handle.status === "completed" && canWriteBack && Boolean(handle.result);
}

export function matchWriteBackPrompt(
  prompts: readonly ThreadPrompt[],
  summary: string,
  labelsFor: (label: string) => readonly string[] = writeBackExactLabels,
): PromptAnswer | undefined {
  const candidates = writeBackConclusionLines(summary);
  if (candidates.length === 0) {
    return undefined;
  }
  for (const prompt of prompts) {
    const question = prompt.questions[0];
    const options = question?.options ?? [];
    for (const candidate of candidates) {
      const matched = options.find((option) =>
        labelsFor(option.label).includes(candidate),
      );
      if (matched && question) {
        return {
          prompt_id: prompt.prompt_id,
          answers: [{ id: question.id, selected: [matched.label] }],
        };
      }
    }
  }
  return undefined;
}

export function writeBackExactLabels(label: string): string[] {
  const trimmed = label.trim();
  return trimmed ? [trimmed] : [];
}

function writeBackConclusionLines(summary: string): string[] {
  const text = summary.trim();
  if (!text) {
    return [];
  }
  const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine && firstLine !== text ? [text, firstLine] : [text];
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
  const result_summary = run?.result?.summary?.trim();
  return {
    id: item.id,
    status: item.status,
    recipe_id: item.recipe_id,
    executor_type: run?.executor_type ?? recipe?.executor_type,
    agent_thread_id: run?.agent_thread_id,
    can_write_back: recipe?.can_write_back,
    has_result: Boolean(result_summary),
    ...(result_summary ? { result_summary } : {}),
    updated_at: item.updated_at,
  };
}
