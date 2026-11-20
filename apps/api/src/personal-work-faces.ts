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
  const runsById = new Map(input.runs.map((run) => [run.id, run]));
  const deliveriesByItem = new Map<string, WorkDelivery[]>();
  for (const delivery of input.deliveries) {
    const rows = deliveriesByItem.get(delivery.work_item_id) ?? [];
    rows.push(delivery);
    deliveriesByItem.set(delivery.work_item_id, rows);
  }
  const faces = new Map<string, WorkInboxFace>();
  for (const threadId of new Set(input.threadIds)) {
    const item = currentJobOnSession(input.items, threadId);
    if (!item) {
      continue;
    }
    const recipe = item.recipe_id ? recipesById.get(item.recipe_id) : undefined;
    const run = item.current_run_id ? runsById.get(item.current_run_id) : undefined;
    const deliveries = deliveriesByItem.get(item.id) ?? [];
    const delivery = deliveries.find((row) => row.run_id
      ? row.run_id === item.current_run_id : run?.write_back_required === undefined);
    const work = workFaceOf(item, recipe, run, delivery);
    const unresolvedHistory = deliveries.some((row) => row !== delivery && row.status !== "acked");
    faces.set(threadId, {
      record_class: item.record_class,
      thread_facet: item.thread_facet,
      attention: unresolvedHistory ? "waiting_you"
        : attentionForWork(work, input.extraPrompts?.get(threadId)?.length ?? 0),
      work,
      agent_thread_id: run?.agent_thread_id,
    });
  }
  return faces;
}

export function attentionForWork(
  work: WorkFace,
  extraPrompts: number,
): AttentionClass {
  if (
    extraPrompts > 0 ||
    work.status === "waiting_human" ||
    work.needs_operator === true ||
    work.status === "failed" ||
    work.start_state === "uncertain" ||
    deliveryNeedsAttention(work.delivery)
  ) {
    return "waiting_you";
  }
  if (work.status === "done" && work.has_result && work.can_write_back === false
    && work.auto_completed !== true) {
    return "needs_ack";
  }
  if (work.status === "running") {
    return "running";
  }
  return "quiet";
}
