import { isDeepStrictEqual } from "node:util";
import type { ExecutorRunHandle } from "./executor";
import type { SearchAnswerRecord } from "./search-answer";
import {
  isActiveWorkStatus,
  type WorkItem,
  type WorkRun,
  type WorkDelivery,
  type RecipeTriggerKind,
  type WorkRunStartClaim,
  type WorkRunStartCommand,
  type Recipe,
} from "./work";
import type { WorkDeliveryPayload } from "./work-delivery";
import { planWorkDeliveryCommand, enqueueWriteBack } from "./work-delivery";
import { workStatusFromRun } from "./work-policy";

export function assertWorkRunSnapshot(run: WorkRun, current?: WorkRun): void {
  if (run.write_back_required === true && !run.write_back_target) {
    throw new Error("Required write-back needs a frozen destination");
  }
  if (run.write_back_target && (
    run.write_back_required !== true
    || !run.write_back_target.installation_id?.trim()
    || !run.write_back_target.source?.trim()
    || !run.write_back_target.target?.trim()
  )) throw new Error("Frozen write-back target must contain installation, source and target");
  if (current && (
    current.org_id !== run.org_id || current.work_item_id !== run.work_item_id
    || current.write_back_required !== run.write_back_required
    || current.trigger_kind !== run.trigger_kind
    || !sameJson(current.write_back_target, run.write_back_target)
  )) {
    throw new Error("Work run identity and write-back snapshot are immutable");
  }
}

export function assertWorkRunWrite(run: WorkRun, current?: WorkRun): void {
  assertWorkRunSnapshot(run, current);
  if (!current) return;
  if (isTerminalWorkRun(current) && current.status !== run.status) {
    throw new Error("Terminal work run status is immutable; start a new attempt");
  }
  if (current.status === "completed" && !sameJson(current.result, run.result)) {
    throw new Error("Completed work results are immutable; start a new attempt to change the result");
  }
}

function isTerminalWorkRun(run: WorkRun): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled";
}

export function canClaimWorkRunStartItem(input: WorkRunStartClaim, item: WorkItem): boolean {
  const { run, expected_item: expected, retry, rebind } = input;
  if (run.status !== "running" || run.start_state !== "pending") {
    throw new Error("Work start claim requires a pending running attempt");
  }
  if (retry !== undefined && retry !== "automatic" && retry !== "manual") {
    throw new Error("Unknown work start retry mode");
  }
  if (retry && !expected) throw new Error("Work retry requires an expected item snapshot");
  if ((input.command_id === undefined) !== (input.issued_at === undefined)) {
    throw new Error("Work start command requires both an id and timestamp");
  }
  if (input.command_id !== undefined && (
    !expected ||
    typeof input.expected_version !== "number" ||
    !Number.isSafeInteger(input.expected_version) ||
    input.expected_version < 0 ||
    typeof input.issued_at !== "string" ||
    input.expected_version !== expected.version ||
    !input.command_id.trim() ||
    input.command_id !== input.command_id.trim() ||
    input.command_id.length > 128 ||
    !Number.isFinite(Date.parse(input.issued_at))
  )) {
    throw new Error("Work start command requires a valid expected version, id and timestamp");
  }
  if (input.expected_version !== undefined && (
    !Number.isSafeInteger(input.expected_version) || input.expected_version < 0
  )) {
    throw new Error("Work start expected version must be a non-negative safe integer");
  }
  if (rebind !== undefined && rebind !== "automatic" && rebind !== "manual") {
    throw new Error("Unknown work start binding mode");
  }
  if (rebind && (!expected || (rebind === "manual" && retry !== "manual")
    || (rebind === "automatic" && retry === "manual"))) {
    throw new Error("Work start binding requires an expected snapshot and matching retry intent");
  }
  if (expected && (expected.org_id !== run.org_id || expected.id !== run.work_item_id)) {
    throw new Error("Work start snapshot must belong to the same organization and work item");
  }
  if (
    input.visibility_intent_version !== undefined &&
    (!expected ||
      !Number.isSafeInteger(input.visibility_intent_version) ||
      input.visibility_intent_version < 0)
  ) {
    throw new Error("Work start visibility intent version requires an item snapshot and a non-negative safe integer");
  }
  if (item.org_id !== run.org_id || item.id !== run.work_item_id
    || (expected && !sameSnapshot(item, expected))
    || (input.expected_version !== undefined && item.version !== input.expected_version)) return false;
  if (item.recipe_id !== run.recipe_id) {
    if (!rebind) return false;
    if (rebind === "manual" && item.recipe_id && isActiveWorkStatus(item.status)) return false;
    if (rebind === "automatic" && item.status !== "open" && item.status !== "failed") return false;
  }
  if (item.status === "open") return true;
  if (item.status === "failed") return retry === "automatic" || retry === "manual";
  return retry === "manual" && (item.status === "done" || item.status === "skipped");
}

export function workRunStartCommand(input: WorkRunStartClaim): WorkRunStartCommand | undefined {
  if (input.command_id === undefined || input.issued_at === undefined || input.expected_version === undefined) {
    return undefined;
  }
  return {
    org_id: input.run.org_id,
    work_item_id: input.run.work_item_id,
    expected_version: input.expected_version,
    command_id: input.command_id,
    issued_at: input.issued_at,
  };
}

export function sameWorkRunStartCommand(saved: unknown, command: WorkRunStartCommand): boolean {
  if (typeof saved !== "object" || saved === null) return false;
  const value = saved as Record<string, unknown>;
  return value.work_item_id === command.work_item_id
    && value.expected_version === command.expected_version
    && value.issued_at === command.issued_at;
}

export type WorkRunStartCheckpoint = {
  expected_item: WorkItem;
  expected_run: WorkRun;
  now: string;
} & (
  | { kind: "bound"; external_run_id: string; agent_thread_id: string }
  | { kind: "submitted"; external_run_id: string; agent_thread_id?: string; result?: WorkRun["result"] }
  | { kind: "failed" | "uncertain"; error: string }
);

export interface WorkRunStartFailure {
  expected_item: WorkItem;
  run: WorkRun & { status: "failed" };
  mode: "automatic" | "manual" | "auxiliary";
  /** A trial may fail validation for a selected rule without changing the existing binding. */
  rebind?: "manual";
}

export interface WorkDismissal {
  expected_item: WorkItem;
  expected_version?: number;
  now: string;
  command_id?: string;
  issued_at?: string;
  /** Compare-and-set the timeout cause in the same commit as the local stop. */
  search_answer_timeout?: SearchAnswerRecord;
}

export interface WorkItemCreation {
  item: WorkItem;
  recipe: Recipe;
  expected_recipe: Recipe | null;
  search_answer?: SearchAnswerRecord;
}

export interface WorkItemCreationAbort {
  expected_item: WorkItem;
  expected_search_answer?: SearchAnswerRecord;
}

export type WorkItemCreationAbortResult =
  | { outcome: "applied"; item: WorkItem; search_answer?: SearchAnswerRecord }
  | { outcome: "conflict"; reason: "missing_work" | "stale_work" | "has_run" | "has_delivery" | "missing_search_answer" | "stale_search_answer" };

export function prepareWorkItemCreationAbort(input: WorkItemCreationAbort, facts: {
  item: WorkItem | null;
  has_run: boolean;
  has_delivery: boolean;
  search_answer?: SearchAnswerRecord | null;
}): WorkItemCreationAbortResult {
  const { item } = facts;
  if (!item) return { outcome: "conflict", reason: "missing_work" };
  if (!sameSnapshot(item, input.expected_item) || item.status !== "open"
    || item.current_run_id !== undefined || (item.version ?? 0) !== 0) {
    return { outcome: "conflict", reason: "stale_work" };
  }
  if (facts.has_run) return { outcome: "conflict", reason: "has_run" };
  if (facts.has_delivery) return { outcome: "conflict", reason: "has_delivery" };
  const expectedAnswer = input.expected_search_answer;
  const searchAnswer = facts.search_answer;
  if (expectedAnswer) {
    if (expectedAnswer.org_id !== item.org_id || expectedAnswer.work_item_id !== item.id) {
      throw new Error("Work creation abort answer must belong to the same work item");
    }
    if (!searchAnswer) return { outcome: "conflict", reason: "missing_search_answer" };
    if (!sameJson(searchAnswer, expectedAnswer)) {
      return { outcome: "conflict", reason: "stale_search_answer" };
    }
  } else if (searchAnswer) {
    return { outcome: "conflict", reason: "stale_search_answer" };
  }
  return structuredClone({
    outcome: "applied",
    item,
    ...(expectedAnswer && searchAnswer ? { search_answer: searchAnswer } : {}),
  });
}

export type WorkItemCreationResult =
  | { outcome: "applied"; item: WorkItem; recipe: Recipe; search_answer?: SearchAnswerRecord }
  | { outcome: "conflict"; reason: "work_exists" | "stale_recipe" | "search_answer_exists" };

export function prepareWorkItemCreation(input: WorkItemCreation, facts: {
  item_exists: boolean;
  recipe: Recipe | null;
  search_answer_exists?: boolean;
}): WorkItemCreationResult {
  const { item, recipe, expected_recipe: expected } = input;
  if (!item.id?.trim() || !item.org_id?.trim() || !item.thread_id?.trim() || !item.unit_key?.trim()
    || !recipe.id?.trim() || item.org_id !== recipe.org_id || item.recipe_id !== recipe.id
    || item.status !== "open" || item.current_run_id !== undefined || (item.version ?? 0) !== 0
    || !Number.isSafeInteger(item.visibility_intent_version ?? 0)
    || (item.visibility_intent_version ?? 0) < 0
    || !Number.isFinite(Date.parse(item.created_at)) || item.created_at !== item.updated_at
    || !Number.isFinite(Date.parse(recipe.created_at)) || !Number.isFinite(Date.parse(recipe.updated_at))
    || (expected && (expected.id !== recipe.id || expected.org_id !== recipe.org_id))) {
    throw new Error("Work creation requires a fresh open item and a matching recipe snapshot");
  }
  const answer = input.search_answer;
  if (answer && (!answer.id?.trim() || answer.org_id !== item.org_id || answer.work_item_id !== item.id
    || answer.outcome !== undefined || typeof answer.query !== "string" || !answer.query.trim()
    || !Array.isArray(answer.event_ids) || answer.event_ids.some((id) => typeof id !== "string" || !id.trim())
    || !Number.isFinite(Date.parse(answer.created_at)) || answer.created_at !== answer.updated_at)) {
    throw new Error("Work creation requires fresh search answer metadata belonging to the same work item");
  }
  if (facts.item_exists) return { outcome: "conflict", reason: "work_exists" };
  if (answer && facts.search_answer_exists) return { outcome: "conflict", reason: "search_answer_exists" };
  const current = facts.recipe;
  const equivalent = current && sameJson(
    { ...current, created_at: undefined, updated_at: undefined },
    { ...recipe, created_at: undefined, updated_at: undefined },
  );
  if (!equivalent && !sameJson(current, expected)) return { outcome: "conflict", reason: "stale_recipe" };
  return structuredClone({
    outcome: "applied",
    item: { ...item, version: 0, visibility_intent_version: item.visibility_intent_version ?? 0 },
    recipe: equivalent ? current : { ...recipe, created_at: current?.created_at ?? recipe.created_at },
    ...(answer ? { search_answer: answer } : {}),
  });
}

export type WorkDismissalResult =
  | { outcome: "applied"; item: WorkItem; run: WorkRun | null; deliveries: WorkDelivery[]; search_answer?: SearchAnswerRecord }
  | { outcome: "replayed"; item: WorkItem }
  | { outcome: "conflict"; reason: "missing_work" | "stale_dismissal" | "unknown_current_run" | "stale_search_answer" | "inactive_search_answer" };

export function sameWorkDismissalCommand(
  saved: unknown,
  input: WorkDismissal,
): boolean {
  if (typeof saved !== "object" || saved === null) return false;
  const command = saved as Record<string, unknown>;
  return command.work_item_id === input.expected_item.id &&
    command.expected_version === (input.expected_version ?? input.expected_item.version ?? 0) &&
    command.issued_at === input.issued_at &&
    input.search_answer_timeout === undefined &&
    Object.keys(command).length === 3;
}

export function prepareWorkDismissal(input: WorkDismissal, facts: {
  item: WorkItem | null;
  run: WorkRun | null;
  deliveries: WorkDelivery[];
  search_answer?: SearchAnswerRecord | null;
}): WorkDismissalResult {
  if (!Number.isFinite(Date.parse(input.now))) throw new Error("Work dismissal requires a valid timestamp");
  if (
    (input.command_id === undefined) !== (input.issued_at === undefined) ||
    (input.command_id !== undefined &&
      (!input.command_id.trim() || input.command_id !== input.command_id.trim() ||
        input.command_id.length > 128 || !Number.isFinite(Date.parse(input.issued_at!))))
  ) {
    throw new Error("Work dismissal command requires a valid command id and timestamp");
  }
  const { item, run } = facts;
  if (!item) return { outcome: "conflict", reason: "missing_work" };
  if (
    !sameSnapshot(item, input.expected_item) ||
    (input.expected_version !== undefined &&
      input.expected_version !== (item.version ?? 0))
  ) {
    return { outcome: "conflict", reason: "stale_dismissal" };
  }
  if (item.current_run_id && !run) return { outcome: "conflict", reason: "unknown_current_run" };
  if (run && (run.org_id !== item.org_id || run.work_item_id !== item.id || run.id !== item.current_run_id)) {
    throw new Error("Work dismissal run must belong to the current work item");
  }
  let searchAnswer: SearchAnswerRecord | undefined;
  if (input.search_answer_timeout) {
    const expected = input.search_answer_timeout;
    if (expected.org_id !== item.org_id || expected.work_item_id !== item.id) {
      throw new Error("Search answer timeout must belong to the dismissed work item");
    }
    if (!facts.search_answer || !sameJson(facts.search_answer, expected) || facts.search_answer.outcome) {
      return { outcome: "conflict", reason: "stale_search_answer" };
    }
    if (!isActiveWorkStatus(item.status) || !run || isTerminalWorkRun(run)) {
      return { outcome: "conflict", reason: "inactive_search_answer" };
    }
    searchAnswer = { ...facts.search_answer, outcome: "timed_out", updated_at: input.now };
  }
  const deliveries = facts.deliveries.map((delivery) => {
    if (delivery.org_id !== item.org_id || delivery.work_item_id !== item.id) {
      throw new Error("Work dismissal delivery must belong to the same organization and work item");
    }
    const result = planWorkDeliveryCommand(delivery, "skipped", {
      org_id: item.org_id, delivery_id: delivery.id, kind: "cancel", now: input.now,
    });
    if (result.outcome !== "applied") throw new Error(`Work dismissal delivery rejected: ${result.reason}`);
    return result.delivery;
  });
  return structuredClone({
    outcome: "applied",
    item: { ...item, status: "skipped", version: (item.version ?? 0) + 1, updated_at: input.now },
    run,
    deliveries,
    ...(searchAnswer ? { search_answer: searchAnswer } : {}),
  });
}

export type WorkRunStartFailureResult =
  | { outcome: "applied"; item: WorkItem; run: WorkRun }
  | { outcome: "conflict"; reason: "missing_work" | "stale_failure" | "missing_recipe" | "active_run" | "unresolved_delivery" };

export function prepareWorkRunStartFailure(input: WorkRunStartFailure, facts: {
  item: WorkItem | null;
  recipe_exists: boolean;
  active_run: boolean;
  unresolved_delivery: boolean;
}): WorkRunStartFailureResult {
  const { run, expected_item: expected, mode } = input;
  if (mode !== "automatic" && mode !== "manual" && mode !== "auxiliary") {
    throw new Error("Unknown work start failure mode");
  }
  assertWorkRunSnapshot(run);
  if (typeof run.id !== "string" || !run.id.trim()
    || typeof run.executor_type !== "string" || !run.executor_type.trim()
    || run.status !== "failed" || run.start_state !== undefined
    || run.external_run_id !== undefined || run.agent_thread_id !== undefined
    || run.write_back_required !== false
    || typeof run.result?.summary !== "string" || !run.result.summary.trim()
    || !Number.isFinite(Date.parse(run.updated_at)) || run.created_at !== run.updated_at
    || (run.version ?? 0) !== 0) {
    throw new Error("Work start failure must describe a fresh, definitely unstarted attempt");
  }
  const claim: WorkRunStartClaim = {
    run: { ...run, status: "running", start_state: "pending" },
    expected_item: expected,
    retry: mode === "manual" ? "manual" : expected.status === "failed" ? "automatic" : undefined,
    rebind: input.rebind,
  };
  if (input.rebind !== undefined && (input.rebind !== "manual" || mode !== "manual")) {
    throw new Error("Work start failure binding intent is only available to manual trials");
  }
  // Validate caller identity even when the item disappeared.
  const eligible = canClaimWorkRunStartItem(claim, facts.item ?? expected);
  if (!facts.item) return { outcome: "conflict", reason: "missing_work" };
  if (!eligible) return { outcome: "conflict", reason: "stale_failure" };
  if (!facts.recipe_exists) return { outcome: "conflict", reason: "missing_recipe" };
  if (facts.active_run) return { outcome: "conflict", reason: "active_run" };
  if (facts.unresolved_delivery) return { outcome: "conflict", reason: "unresolved_delivery" };
  return {
    outcome: "applied",
    run: structuredClone({ ...run, version: 0 }),
    item: structuredClone({
      ...facts.item,
      ...(mode === "automatic" ? { status: "failed" as const, current_run_id: run.id } : {}),
      version: (facts.item.version ?? 0) + 1,
      updated_at: run.updated_at,
    }),
  };
}

export type WorkRunStartCheckpointResult =
  | { outcome: "applied"; item: WorkItem; run: WorkRun }
  | {
      outcome: "conflict";
      reason: "missing_work" | "work_skipped" | "not_current_run" | "stale_checkpoint" | "start_closed";
    };

export function prepareWorkRunStartCheckpoint(
  input: WorkRunStartCheckpoint,
  current: { item: WorkItem | null; run: WorkRun | null },
): WorkRunStartCheckpointResult {
  const { expected_item: expectedItem, expected_run: expectedRun } = input;
  if (!["bound", "submitted", "failed", "uncertain"].includes(input.kind)) {
    throw new Error("Unknown work run start checkpoint kind");
  }
  if (!Number.isFinite(Date.parse(input.now))) throw new Error("Start checkpoint requires a valid timestamp");
  if (expectedRun.org_id !== expectedItem.org_id || expectedRun.work_item_id !== expectedItem.id) {
    throw new Error("Start checkpoint must belong to the same organization and work item");
  }
  const { item, run } = current;
  if (!item || !run) return { outcome: "conflict", reason: "missing_work" };
  if (item.org_id !== expectedItem.org_id || item.id !== expectedItem.id
    || run.org_id !== item.org_id || run.id !== expectedRun.id || run.work_item_id !== item.id) {
    throw new Error("Stored start checkpoint does not match the requested identities");
  }
  if (item.status === "skipped") return { outcome: "conflict", reason: "work_skipped" };
  if (item.current_run_id !== run.id) return { outcome: "conflict", reason: "not_current_run" };
  if (!sameSnapshot(item, expectedItem) || !sameSnapshot(run, expectedRun)) {
    return { outcome: "conflict", reason: "stale_checkpoint" };
  }
  if (!run.start_state || isTerminalWorkRun(run)
    || (item.status !== "running" && item.status !== "waiting_human")
    || (input.kind !== "submitted" && run.start_state !== "pending")
    || (input.kind === "failed" && (run.external_run_id || run.agent_thread_id))) {
    return { outcome: "conflict", reason: "start_closed" };
  }
  const nextRun: WorkRun = { ...run, version: (run.version ?? 0) + 1, updated_at: input.now };
  if (input.kind === "bound" || input.kind === "submitted") {
    if (typeof input.external_run_id !== "string" || !input.external_run_id.trim()
      || (input.kind === "bound" && typeof input.agent_thread_id !== "string")
      || (input.agent_thread_id !== undefined
        && (typeof input.agent_thread_id !== "string" || !input.agent_thread_id.trim()))) {
      throw new Error("Start checkpoint requires an external execution identity");
    }
    nextRun.external_run_id = input.external_run_id;
    nextRun.agent_thread_id = input.agent_thread_id ?? run.agent_thread_id;
    if (input.kind === "submitted") {
      nextRun.start_state = "submitted";
      nextRun.result = input.result ?? run.result;
    }
  } else {
    if (typeof input.error !== "string" || !input.error.trim()) {
      throw new Error("Start checkpoint failure requires an error");
    }
    nextRun.status = input.kind === "failed" ? "failed" : "waiting_human";
    nextRun.start_state = input.kind === "failed" ? undefined : "uncertain";
    nextRun.result = { summary: input.error };
  }
  assertWorkRunWrite(nextRun, run);
  const status = workStatusFromRun(nextRun.status);
  const nextItem = status === item.status ? item
    : { ...item, status, version: (item.version ?? 0) + 1, updated_at: input.now };
  return { outcome: "applied", item: nextItem, run: nextRun };
}

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
      reason: "missing_work" | "stale_observation" | "completed_result_changed" | "not_current_run" | "execution_identity_unknown";
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
  if (item.status === "skipped" && expectedItem.status !== "skipped") {
    return { outcome: "ignored", reason: "work_skipped" };
  }
  if (!item.current_run_id || item.current_run_id !== expectedRun.id) {
    return { outcome: "conflict", reason: "not_current_run" };
  }
  if (!sameSnapshot(item, expectedItem) || !sameSnapshot(run, expectedRun)) {
    return { outcome: "conflict", reason: "stale_observation" };
  }
  if (item.status === "skipped" && (
    !run.external_run_id || input.handle.external_run_id !== run.external_run_id
    || run.start_state === "pending" || run.start_state === "uncertain"
  )) {
    return { outcome: "conflict", reason: "execution_identity_unknown" };
  }
  if (isTerminalWorkRun(run) && input.handle.status !== run.status) {
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
      kind: run.trigger_kind ?? input.trigger_kind,
      unit_key: item.unit_key,
      event_id: item.head_event_id,
      payload: transition.delivery.payload,
      now: input.now,
      existing: delivery,
      run_id: run.write_back_required === undefined ? undefined : run.id,
      target: run.write_back_target,
    });
  } else if (transition.delivery.kind === "abandon" && delivery && delivery.status !== "acked") {
    const cancelled = planWorkDeliveryCommand(delivery, item.status, {
      org_id: item.org_id, delivery_id: delivery.id, kind: "cancel", now: input.now,
    });
    if (cancelled.outcome === "applied") nextDelivery = cancelled.delivery;
  }
  return { outcome: "applied", transition, delivery: nextDelivery };
}

function sameSnapshot(current: WorkItem | WorkRun, expected: WorkItem | WorkRun): boolean {
  const normalize = (value: WorkItem | WorkRun) => ({
    ...value,
    version: value.version ?? 0,
    ...("thread_id" in value
      ? { visibility_intent_version: value.visibility_intent_version ?? 0 }
      : {}),
  });
  return sameJson(
    normalize(current),
    normalize(expected),
  );
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
    version: (run.version ?? 0) + 1,
    start_state: undefined,
    external_run_id: handle.external_run_id,
    agent_thread_id: handle.agent_thread_id ?? run.agent_thread_id,
    status: handle.status,
    result: run.status === "completed" ? run.result : handle.result ?? run.result,
    updated_at: now,
  };
  assertWorkRunWrite(nextRun, run);
  const status = workStatusFromRun(nextRun.status);
  const nextItem = item.status === "skipped" || item.status === status
    ? item
    : { ...item, status, version: (item.version ?? 0) + 1, updated_at: now };
  const delivery: ObservedWorkDelivery = item.status === "skipped" || handle.status !== "completed" || run.status === "completed"
    ? { kind: "keep" }
    : (run.write_back_required ?? input.can_write_back)
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
