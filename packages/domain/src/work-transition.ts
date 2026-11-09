import { isDeepStrictEqual } from "node:util";
import type { ExecutorRunHandle } from "./executor";
import {
  isActiveWorkStatus,
  type WorkItem,
  type WorkRun,
  type WorkDelivery,
  type RecipeTriggerKind,
} from "./work";
import type { WorkDeliveryPayload } from "./work-delivery";
import { deliveryAbandoned, enqueueWriteBack } from "./work-delivery";
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

export interface CommitWorkObservation {
  expected_item: WorkItem;
  expected_run: WorkRun;
  handle: ExecutorRunHandle;
  can_write_back: boolean;
  trigger_kind: RecipeTriggerKind;
  now: string;
}

export type CommitWorkObservationResult =
  | { outcome: "applied"; transition: WorkObservationTransition }
  | { outcome: "ignored"; reason: "work_skipped" }
  | {
      outcome: "conflict";
      reason: "missing_work" | "stale_observation" | "completed_result_changed";
    };

export type PreparedWorkObservation =
  | {
      outcome: "applied";
      transition: WorkObservationTransition;
      delivery?: WorkDelivery;
    }
  | Exclude<CommitWorkObservationResult, { outcome: "applied" }>;

/** Snapshot fencing during the compatibility phase; not a replacement for RFC 0011 versions. */
export function prepareWorkObservation(
  input: CommitWorkObservation,
  current: { item: WorkItem | null; run: WorkRun | null; delivery: WorkDelivery | null },
): PreparedWorkObservation {
  const { expected_item: expectedItem, expected_run: expectedRun } = input;
  if (expectedRun.org_id !== expectedItem.org_id || expectedRun.work_item_id !== expectedItem.id) {
    throw new Error("Work observation must belong to the same organization and work item");
  }
  const { item, run, delivery } = current;
  if (!item || !run) {
    return { outcome: "conflict", reason: "missing_work" };
  }
  if (item.org_id !== expectedItem.org_id || item.id !== expectedItem.id
    || run.org_id !== item.org_id || run.id !== expectedRun.id || run.work_item_id !== item.id) {
    throw new Error("Stored work observation does not match the requested identities");
  }
  if (item.status === "skipped") {
    return { outcome: "ignored", reason: "work_skipped" };
  }
  if (!sameSnapshot(item, expectedItem) || !sameSnapshot(run, expectedRun)) {
    return { outcome: "conflict", reason: "stale_observation" };
  }
  if ((run.status === "completed" || run.status === "failed" || run.status === "cancelled")
    && input.handle.status !== run.status) {
    return { outcome: "conflict", reason: "stale_observation" };
  }
  if (completedResultChanged(run, input.handle)) {
    return { outcome: "conflict", reason: "completed_result_changed" };
  }
  const transition = planWorkObservation({
    item,
    run,
    handle: input.handle,
    can_write_back: input.can_write_back,
    now: input.now,
  });
  let nextDelivery: WorkDelivery | undefined;
  if (transition.delivery.kind === "enqueue") {
    nextDelivery = enqueueWriteBack({
      org_id: item.org_id,
      work_item_id: item.id,
      recipe_id: run.recipe_id,
      kind: input.trigger_kind,
      unit_key: item.unit_key,
      event_id: item.head_event_id,
      payload: transition.delivery.payload,
      now: input.now,
      existing: delivery,
    });
  } else if (transition.delivery.kind === "abandon" && delivery && delivery.status !== "acked") {
    nextDelivery = deliveryAbandoned(delivery, input.now);
  }
  return { outcome: "applied", transition, delivery: nextDelivery };
}

function sameSnapshot(current: WorkItem | WorkRun, expected: WorkItem | WorkRun): boolean {
  return sameJson(current, expected);
}

function sameJson(current: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(
    JSON.parse(JSON.stringify(current ?? null)),
    JSON.parse(JSON.stringify(expected ?? null)),
  );
}

function completedResultChanged(run: WorkRun, handle: ExecutorRunHandle): boolean {
  return run.status === "completed"
    && handle.result !== undefined
    && !sameJson(run.result, handle.result);
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
  if (completedResultChanged(run, handle)) {
    throw new Error("Completed work results are immutable; start a new attempt to change the result");
  }
  const nextRun: WorkRun = {
    ...run,
    start_state: undefined,
    external_run_id: handle.external_run_id,
    agent_thread_id: handle.agent_thread_id ?? run.agent_thread_id,
    status: handle.status,
    result: run.status === "completed" ? run.result : handle.result ?? run.result,
    updated_at: now,
  };
  const status = workStatusFromRun(nextRun.status);
  const nextItem = item.status === status
    ? item
    : { ...item, status, updated_at: now };
  const delivery: ObservedWorkDelivery = handle.status !== "completed" || run.status === "completed"
    ? { kind: "keep" }
    : input.can_write_back
      ? {
          kind: "enqueue",
          payload: {
            summary: nextRun.result?.summary ?? "",
            content: nextRun.result?.content,
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
    || (before.start_state !== after.start_state && before.start_state !== "submitted")
    || before.external_run_id !== after.external_run_id
    || before.agent_thread_id !== after.agent_thread_id
    || JSON.stringify(before.result) !== JSON.stringify(after.result);
}
