import {
  currentJobOnSession,
  deliveryNeedsAttention,
  workFaceOf,
  type AttentionClass,
  type RecordClass,
  type Recipe,
  type ThreadFacet,
  type ThreadPrompt,
  type WorkDelivery,
  type WorkFace,
  type WorkItem,
  type WorkRun,
} from "@regenic/domain";

export interface WorkInboxFace {
  record_class: RecordClass;
  thread_facet: ThreadFacet;
  attention: AttentionClass;
  work?: WorkFace;
  agent_thread_id?: string;
  extra_prompts?: ThreadPrompt[];
}

export function workInboxFaces(input: {
  threadIds: string[];
  items: WorkItem[];
  runs: WorkRun[];
  recipes: Recipe[];
  deliveries: WorkDelivery[];
  extraPrompts?: ReadonlyMap<string, ThreadPrompt[]>;
}): Map<string, WorkInboxFace> {
  const recipesById = new Map(input.recipes.map((recipe) => [recipe.id, recipe]));
  const runsByItem = latestRunsByItem(input.runs);
  const deliveryByItem = new Map(
    input.deliveries.map((item) => [item.work_item_id, item]),
  );
  const faces = new Map<string, WorkInboxFace>();
  for (const threadId of new Set(input.threadIds)) {
    const item = currentJobOnSession(input.items, threadId);
    if (!item) {
      continue;
    }
    const recipe = item.recipe_id ? recipesById.get(item.recipe_id) : undefined;
    const run = runsByItem.get(item.id);
    const work = workFaceOf(item, recipe, run, deliveryByItem.get(item.id));
    faces.set(threadId, {
      record_class: item.record_class,
      thread_facet: item.thread_facet,
      attention: attentionForWork(work, input.extraPrompts?.get(threadId)?.length ?? 0),
      work,
      agent_thread_id: run?.agent_thread_id,
    });
  }
  return faces;
}

export function latestRunsByItem(runs: WorkRun[]): Map<string, WorkRun> {
  const best = new Map<string, WorkRun>();
  for (const run of runs) {
    const current = best.get(run.work_item_id);
    if (!current || current.updated_at < run.updated_at) {
      best.set(run.work_item_id, run);
    }
  }
  return best;
}

export function attentionForWork(
  work: WorkFace,
  extraPrompts: number,
): AttentionClass {
  if (
    extraPrompts > 0 ||
    work.status === "waiting_human" ||
    work.status === "failed" ||
    deliveryNeedsAttention(work.delivery)
  ) {
    return "waiting_you";
  }
  if (work.status === "done" && work.has_result && work.can_write_back === false) {
    return "needs_ack";
  }
  if (work.status === "running") {
    return "running";
  }
  return "quiet";
}
