import type { ExecutorRunHandle } from "./executor";
import { isActiveWorkStatus, type WorkItem, type WorkRun } from "./work";
import type { WorkDeliveryPayload } from "./work-delivery";
import { workStatusFromRun } from "./work-policy";

export type ObservedWorkDelivery =
  | { kind: "enqueue"; payload: WorkDeliveryPayload }
  | { kind: "abandon" }
  | { kind: "keep" };

export interface WorkObservationTransition {
  run: WorkRun;
  item: WorkItem;
  delivery: ObservedWorkDelivery;
  settled: boolean;
  changed: boolean;
}

export function planWorkObservation(input: {
  item: WorkItem;
  run: WorkRun;
  handle: ExecutorRunHandle;
  can_write_back: boolean;
  now: string;
}): WorkObservationTransition {
  const { item, run, handle, now } = input;
  if (run.org_id !== item.org_id || run.work_item_id !== item.id) {
    throw new Error("Work observation must belong to the same organization and work item");
  }
  const nextRun: WorkRun = {
    ...run,
    start_state: undefined,
    external_run_id: handle.external_run_id,
    agent_thread_id: handle.agent_thread_id ?? run.agent_thread_id,
    status: handle.status,
    result: handle.result ?? run.result,
    updated_at: now,
  };
  const status = workStatusFromRun(nextRun.status);
  const nextItem = item.status === status
    ? item
    : { ...item, status, updated_at: now };
  const delivery: ObservedWorkDelivery = handle.status !== "completed"
    ? { kind: "keep" }
    : input.can_write_back
      ? {
          kind: "enqueue",
          payload: {
            summary: handle.result?.summary ?? "",
            content: handle.result?.content,
          },
        }
      : { kind: "abandon" };
  return {
    run: nextRun,
    item: nextItem,
    delivery,
    settled: !isActiveWorkStatus(status),
    changed: nextItem !== item || workRunChanged(run, nextRun),
  };
}

function workRunChanged(before: WorkRun, after: WorkRun): boolean {
  return before.status !== after.status
    || before.start_state !== after.start_state
    || before.external_run_id !== after.external_run_id
    || before.agent_thread_id !== after.agent_thread_id
    || JSON.stringify(before.result) !== JSON.stringify(after.result);
}
