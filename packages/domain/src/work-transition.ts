import { isDeepStrictEqual } from "node:util";
import type { ExecutorRunHandle } from "./executor";
import type { SearchAnswerRecord } from "./search-answer";
import {
  isActiveWorkStatus,
  type WorkItem,
  type WorkRun,
  type WorkDelivery,
  type CommitCancellationJobObservation,
  type CommitCancellationJobObservationResult,
  type WorkDeliveryCommand,
  type RecipeTriggerKind,
  type WorkRunStartClaim,
  type WorkRunStartCommand,
  type Recipe,
  type WorkItemIdentityDiagnostic,
} from "./work";
import type { WorkDeliveryPayload } from "./work-delivery";
import { planWorkDeliveryCommand, enqueueWriteBack } from "./work-delivery";
import { workStatusFromRun } from "./work-policy";
import type { ConversationReadCursorPatch } from "./ingestion";

export function assertWorkRunSnapshot(run: WorkRun, current?: WorkRun): void {
  if (run.completion_policy_version !== undefined && run.completion_policy_version !== 1) {
    throw new Error("Unknown work completion policy version");
  }
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
    || current.recipe_id !== run.recipe_id
    || current.executor_type !== run.executor_type
    || current.write_back_required !== run.write_back_required
    || current.include_context !== run.include_context
    || current.trigger_kind !== run.trigger_kind
    || current.completion_policy_version !== run.completion_policy_version
    || current.hide_on_success !== run.hide_on_success
    || !sameJson(current.executor_config, run.executor_config)
    || !sameJson(current.write_back_target, run.write_back_target)
  )) {
    throw new Error("Work run identity and execution snapshot are immutable");
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

export function assertWorkRunExecutionIdentityWrite(
  run: WorkRun,
  current?: WorkRun,
): void {
  if (current && (
    (current.external_run_id !== undefined
      && current.external_run_id !== run.external_run_id)
    || (current.agent_thread_id !== undefined
      && current.agent_thread_id !== run.agent_thread_id)
  )) {
    throw new Error("Bound work run execution identity is immutable");
  }
}

export function assertWorkRunStartStateWrite(run: WorkRun, current?: WorkRun): void {
  if (current && current.start_state !== run.start_state) {
    throw new Error("Work run start state must be changed through lifecycle transitions");
  }
}

export function assertWorkRunStatusWrite(run: WorkRun, current?: WorkRun): void {
  if (current && current.status !== run.status) {
    throw new Error("Work run status must be changed through lifecycle transitions");
  }
}

function workRunHandleIdentityConflicts(
  run: WorkRun,
  handle: Pick<ExecutorRunHandle, "external_run_id" | "agent_thread_id">,
): boolean {
  return (run.external_run_id !== undefined && run.external_run_id !== handle.external_run_id)
    || (run.agent_thread_id !== undefined && handle.agent_thread_id !== undefined
      && run.agent_thread_id !== handle.agent_thread_id);
}

export function workRunHandleMatchesExecution(
  run: WorkRun,
  handle: Pick<ExecutorRunHandle, "external_run_id" | "agent_thread_id">,
): boolean {
  if (workRunHandleIdentityConflicts(run, handle)) return false;
  return run.external_run_id !== undefined
    ? run.external_run_id === handle.external_run_id
    : Boolean(run.agent_thread_id && run.agent_thread_id === handle.agent_thread_id);
}

export function assertWorkRunVersionWrite(
  run: WorkRun,
  current?: WorkRun,
): void {
  if (current && (run.version ?? 0) !== (current.version ?? 0)) {
    throw new Error("Stale work run version; reload before writing");
  }
}

export function assertWorkItemVersionWrite(
  item: WorkItem,
  current?: WorkItem,
): void {
  if (current && (item.version ?? 0) !== (current.version ?? 0)) {
    throw new Error("Stale work item version; reload before writing");
  }
}

export function assertWorkItemStatusWrite(
  item: WorkItem,
  current?: WorkItem,
): void {
  if (current && item.status !== current.status) {
    throw new Error("Work item status must be changed through lifecycle transitions");
  }
}

function isTerminalWorkRun(run: WorkRun): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "cancelled";
}

export function canClaimWorkRunStartItem(
  input: WorkRunStartClaim,
  item: WorkItem,
  triggerIsCurrentWork = false,
): boolean {
  const { run, expected_item: expected, retry, rebind } = input;
  if (run.status !== "running" || run.start_state !== "pending") {
    throw new Error("Work start claim requires a pending running attempt");
  }
  if (run.result !== undefined) {
    throw new Error("Work start claim cannot include an execution result");
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
  if (
    input.require_current_work_trigger &&
    (!item.head_event_id || !triggerIsCurrentWork)
  ) return false;
  if (retry === "automatic" && item.current_run_id
    && item.acknowledged_run_id === item.current_run_id) return false;
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
  fold_visibility?: boolean;
  command_id?: string;
  issued_at?: string;
  /** Compare-and-set the timeout cause in the same commit as the local stop. */
  search_answer_timeout?: SearchAnswerRecord;
  search_answer_outcome?: "timed_out" | "cancelled";
}

export interface WorkAcknowledgment {
  expected_item: WorkItem;
  run_id: string;
  trigger_event_id: string;
  expected_version: number;
  expected_run_version: number;
  command_id: string;
  issued_at: string;
  now: string;
  conversation_attention?: ConversationReadCursorPatch;
}

export type WorkAcknowledgmentResult =
  | { outcome: "applied"; item: WorkItem }
  | { outcome: "replayed"; item: WorkItem }
  | { outcome: "conflict"; reason: "missing_work" | "stale_result" | "not_acknowledgeable" | "command_conflict" };

export function assertWorkAcknowledgmentAttentionBinding(input: WorkAcknowledgment): void {
  const attention = input.conversation_attention;
  if (!attention) return;
  if (attention.org_id !== input.expected_item.org_id
    || attention.thread_id !== input.expected_item.thread_id
    || !attention.org_id.trim()
    || !attention.thread_id.trim()
    || !Number.isFinite(Date.parse(attention.updated_at))
    || (attention.last_read_at !== undefined && attention.last_read_at !== null
      && !Number.isFinite(Date.parse(attention.last_read_at)))) {
    throw new Error("Work acknowledgment attention must match its conversation and use valid timestamps");
  }
}

export function sameWorkAcknowledgmentCommand(saved: unknown, input: WorkAcknowledgment): boolean {
  if (!saved || typeof saved !== "object") return false;
  const command = saved as Partial<WorkAcknowledgment>;
  if (!command.expected_item) return false;
  // The cursor is monotonic and may advance on replay without changing work-command identity.
  return command.expected_item.id === input.expected_item.id
    && command.expected_item.org_id === input.expected_item.org_id
    && command.run_id === input.run_id
    && command.trigger_event_id === input.trigger_event_id
    && command.expected_version === input.expected_version
    && command.expected_run_version === input.expected_run_version
    && command.command_id === input.command_id
    && command.issued_at === input.issued_at;
}

export function prepareWorkAcknowledgment(input: WorkAcknowledgment, facts: {
  item: WorkItem | null;
  run: WorkRun | null;
  delivery: WorkDelivery | null;
  trigger_is_current_work: boolean;
  trigger_is_completed_work?: boolean;
}): WorkAcknowledgmentResult {
  assertWorkAcknowledgmentAttentionBinding(input);
  if (!input.command_id.trim() || input.command_id !== input.command_id.trim()
    || input.command_id.length > 128 || !Number.isSafeInteger(input.expected_version)
    || input.expected_version < 0 || !Number.isSafeInteger(input.expected_run_version)
    || input.expected_run_version < 0 || !Number.isFinite(Date.parse(input.issued_at))
    || !Number.isFinite(Date.parse(input.now)) || !input.run_id.trim()
    || !input.trigger_event_id.trim()) {
    throw new Error("Work result acknowledgment requires a valid run, version, command and timestamp");
  }
  const { item, run, delivery } = facts;
  if (!item) return { outcome: "conflict", reason: "missing_work" };
  if (input.expected_item.org_id !== item.org_id || input.expected_item.id !== item.id
    || !sameSnapshot(item, input.expected_item) || (item.version ?? 0) !== input.expected_version
    || item.current_run_id !== input.run_id || item.head_event_id !== input.trigger_event_id) {
    return { outcome: "conflict", reason: "stale_result" };
  }
  const completed = run?.status === "completed" && item.status === "done"
    && Boolean(run.result?.summary?.trim());
  const failed = run?.status === "failed" && item.status === "failed"
    && Boolean(run.result?.summary?.trim());
  if (!run || run.org_id !== item.org_id || run.work_item_id !== item.id || run.id !== input.run_id
    || (run.version ?? 0) !== input.expected_run_version || (!completed && !failed)
    || item.acknowledged_run_id === run.id) {
    return { outcome: "conflict", reason: "not_acknowledgeable" };
  }
  if (completed && run.write_back_required === true && (
    !delivery || delivery.run_id !== run.id || delivery.status !== "acked" || delivery.write_back !== "sent"
  )) {
    return { outcome: "conflict", reason: "not_acknowledgeable" };
  }
  if (!facts.trigger_is_current_work && !(completed && facts.trigger_is_completed_work)) {
    return { outcome: "conflict", reason: "not_acknowledgeable" };
  }
  return {
    outcome: "applied",
    item: {
      ...item,
      acknowledged_run_id: run.id,
      version: (item.version ?? 0) + 1,
      updated_at: input.now,
    },
  };
}

export interface WorkItemCreation {
  item: WorkItem;
  recipe: Recipe;
  expected_recipe: Recipe | null;
  search_answer?: SearchAnswerRecord;
  search_answer_transition?: {
    expected_answer: SearchAnswerRecord;
    expected_item: WorkItem;
    expected_run: WorkRun;
  };
}

export interface WorkItemObservation {
  expected_item: WorkItem | null;
  item: WorkItem;
}

export type WorkItemObservationResult =
  | { outcome: "applied"; item: WorkItem }
  | { outcome: "unchanged"; item: WorkItem }
  | {
      outcome: "conflict";
      reason:
        | "missing_work"
        | "stale_work"
        | "work_exists"
        | "unit_exists"
        | "trigger_not_current_work";
    };

export interface WorkItemObservationLifecycleEvent {
  thread_id: string;
  aggregate_type: "work_item";
  aggregate_id: string;
  aggregate_version: number;
  event_type: "work_item_transitioned";
  dedupe_key: string;
  payload: Record<string, string | number | boolean | undefined>;
}

export function workItemObservationLifecycleEvent(
  expected: WorkItem | null,
  item: WorkItem,
): WorkItemObservationLifecycleEvent {
  const version = item.version ?? 0;
  const eventType = "work_item_transitioned";
  return {
    thread_id: item.thread_id,
    aggregate_type: "work_item",
    aggregate_id: item.id,
    aggregate_version: version,
    event_type: eventType,
    dedupe_key: JSON.stringify(["work_item", item.id, version, eventType]),
    payload: {
      work_item_id: item.id,
      from_status: expected?.id === item.id ? expected.status : "absent",
      to_status: item.status,
      reason: "message_observed",
    },
  };
}

export function diagnoseWorkItemRunIdentity(
  item: WorkItem,
  associatedRuns: readonly WorkRun[],
  referencedRun?: WorkRun,
): WorkItemIdentityDiagnostic | null {
  if (item.status !== "running" && item.status !== "waiting_human") return null;
  const current = item.current_run_id
    ? referencedRun ?? associatedRuns.find((run) => run.id === item.current_run_id)
    : undefined;
  if (current && current.org_id === item.org_id && current.work_item_id === item.id
    && current.recipe_id === item.recipe_id && isActiveRunStatus(current)) {
    return null;
  }

  const reason: WorkItemIdentityDiagnostic["reason"] = !item.current_run_id
    ? "missing_current_run"
    : !current
      ? "current_run_not_found"
      : current.org_id !== item.org_id || current.work_item_id !== item.id
        ? "current_run_identity_mismatch"
        : current.recipe_id !== item.recipe_id
          ? "current_run_recipe_mismatch"
          : "current_run_not_active";
  const candidate_run_ids = associatedRuns
    .filter((run) => run.org_id === item.org_id && run.work_item_id === item.id
      && run.recipe_id === item.recipe_id && isActiveRunStatus(run))
    .map((run) => run.id)
    .sort();
  return {
    work_item_id: item.id,
    thread_id: item.thread_id,
    unit_key: item.unit_key,
    item_status: item.status,
    ...(item.current_run_id ? { current_run_id: item.current_run_id } : {}),
    reason,
    candidate_run_ids,
  };
}

function isActiveRunStatus(run: WorkRun): boolean {
  return run.status === "running" || run.status === "waiting_human";
}

export function prepareWorkItemObservation(
  input: WorkItemObservation,
  facts: {
    expected_item: WorkItem | null;
    current_item: WorkItem | null;
    unit_exists: boolean;
    trigger_is_current_work: boolean;
  },
): WorkItemObservationResult {
  const { item, expected_item: expected } = input;
  if (!item.id?.trim() || !item.org_id?.trim() || !item.thread_id?.trim()
    || !item.unit_key?.trim() || !Number.isFinite(Date.parse(item.created_at))
    || !Number.isFinite(Date.parse(item.updated_at))) {
    throw new Error("Work observation requires a valid item identity and timestamps");
  }
  const currentExpected = facts.expected_item;
  if (expected && (!currentExpected || !sameSnapshot(currentExpected, expected))) {
    return { outcome: "conflict", reason: "stale_work" };
  }
  if (!expected && currentExpected) {
    return { outcome: "conflict", reason: "work_exists" };
  }
  if (facts.current_item && facts.current_item.id !== expected?.id) {
    return { outcome: "conflict", reason: "work_exists" };
  }
  if (!facts.trigger_is_current_work) {
    return { outcome: "conflict", reason: "trigger_not_current_work" };
  }
  if (expected?.org_id !== undefined && expected.org_id !== item.org_id) {
    throw new Error("Observed work item must remain in the same organization");
  }
  if (expected && expected.thread_id !== item.thread_id) {
    throw new Error("Observed work item must remain in the same conversation");
  }
  if (expected?.id === item.id) {
    if (expected.thread_id !== item.thread_id || expected.unit_key !== item.unit_key
      || expected.head_event_id !== item.head_event_id
      || expected.status !== item.status || expected.current_run_id !== item.current_run_id
      || expected.acknowledged_run_id !== item.acknowledged_run_id
      || expected.created_at !== item.created_at
      || (expected.visibility_intent_version ?? 0) !== (item.visibility_intent_version ?? 0)) {
      throw new Error("Work observation may only update metadata on an existing item");
    }
    if (!facts.current_item || !sameSnapshot(facts.current_item, expected)) {
      return { outcome: "conflict", reason: "stale_work" };
    }
    if (sameJson(expected, item)) return { outcome: "unchanged", item: expected };
    return {
      outcome: "applied",
      item: { ...item, version: (expected.version ?? 0) + 1 },
    };
  }
  if (facts.current_item) return { outcome: "conflict", reason: "work_exists" };
  if (facts.unit_exists) return { outcome: "conflict", reason: "unit_exists" };
  if (item.status !== "open" || item.current_run_id !== undefined
    || item.acknowledged_run_id !== undefined || (item.version ?? 0) !== 0
    || (item.visibility_intent_version ?? 0) !== 0) {
    throw new Error("New observed work must be an unreserved open item");
  }
  return { outcome: "applied", item: { ...item, version: 0, visibility_intent_version: 0 } };
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
  | { outcome: "conflict"; reason: "work_exists" | "stale_recipe" | "search_answer_exists" | "stale_search_answer" };

export function prepareWorkItemCreation(input: WorkItemCreation, facts: {
  item_exists: boolean;
  recipe: Recipe | null;
  search_answer_exists?: boolean;
  search_answer?: SearchAnswerRecord | null;
  answer_item?: WorkItem | null;
  answer_run?: WorkRun | null;
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
  const transition = input.search_answer_transition;
  if (transition && !answer) throw new Error("Search answer advancement requires the next stage metadata");
  if (answer && (!answer.id?.trim() || answer.org_id !== item.org_id || answer.work_item_id !== item.id
    || answer.outcome !== undefined || typeof answer.query !== "string" || !answer.query.trim()
    || !Array.isArray(answer.event_ids) || answer.event_ids.some((id) => typeof id !== "string" || !id.trim())
    || !Number.isFinite(Date.parse(answer.created_at)) || !Number.isFinite(Date.parse(answer.updated_at))
    || (!transition && answer.created_at !== answer.updated_at))) {
    throw new Error("Work creation requires fresh search answer metadata belonging to the same work item");
  }
  if (facts.item_exists) return { outcome: "conflict", reason: "work_exists" };
  if (transition && answer) {
    const previous = transition.expected_answer;
    const priorMap = previous.scope?.map_reduce;
    const nextMap = answer.scope?.map_reduce;
    const serialAdvance = !!priorMap && !!nextMap &&
      priorMap.phase === "mapping" &&
      priorMap.completed_batches < priorMap.total_batches &&
      nextMap.completed_batches === priorMap.completed_batches + 1 &&
      nextMap.phase === (
        nextMap.completed_batches === priorMap.total_batches
          ? "reducing"
          : "mapping"
      );
    const parallelReduction = !!priorMap && !!nextMap &&
      priorMap.phase === "mapping" &&
      priorMap.completed_batches === priorMap.total_batches &&
      priorMap.batches?.length === priorMap.total_batches &&
      priorMap.batches.every((batch) => batch.status === "completed") &&
      nextMap.completed_batches === priorMap.total_batches &&
      nextMap.phase === "reducing";
    const parallelSource = parallelReduction && priorMap.batches?.some(
      (batch) =>
        batch.status === "completed" &&
        batch.work_item_id === transition.expected_item.id,
    ) === true;
    if (!sameJson(facts.search_answer, previous) || previous.outcome !== undefined
      || !sameJson(facts.answer_item, transition.expected_item)
      || !sameJson(facts.answer_run, transition.expected_run)
      || transition.expected_item.org_id !== item.org_id
      || (transition.expected_item.id !== previous.work_item_id && !parallelSource)
      || transition.expected_item.status !== "done"
      || transition.expected_item.current_run_id !== transition.expected_run.id
      || transition.expected_run.org_id !== item.org_id
      || transition.expected_run.work_item_id !== transition.expected_item.id
      || transition.expected_run.recipe_id !== transition.expected_item.recipe_id
      || transition.expected_run.status !== "completed"
      || item.id === previous.work_item_id
      || answer.id !== previous.id || answer.org_id !== previous.org_id
      || answer.query !== previous.query || answer.created_at !== previous.created_at
      || !sameJson(answer.event_ids, previous.event_ids)
      || !priorMap || !nextMap || (!serialAdvance && !parallelReduction)
      || !sameJson(
        { ...priorMap, phase: undefined, completed_batches: undefined, facts: undefined },
        { ...nextMap, phase: undefined, completed_batches: undefined, facts: undefined },
      )
      || !sameJson(nextMap.facts.slice(0, priorMap.facts.length), priorMap.facts)
      || (previous.scope?.complete === false && answer.scope?.complete !== false)
      || (!parallelReduction &&
        answer.scope?.conflict_count !== previous.scope?.conflict_count)
      || (parallelReduction && answer.scope?.conflict_count !== undefined &&
        (!Number.isSafeInteger(answer.scope.conflict_count) ||
          answer.scope.conflict_count < 1 ||
          answer.scope.conflict_count > 2_000))
      || !sameJson(
        {
          ...previous.scope,
          map_reduce: undefined,
          complete: undefined,
          incomplete_reason: undefined,
          conflict_count: undefined,
        },
        {
          ...answer.scope,
          map_reduce: undefined,
          complete: undefined,
          incomplete_reason: undefined,
          conflict_count: undefined,
        },
      )) return { outcome: "conflict", reason: "stale_search_answer" };
  } else if (answer && facts.search_answer_exists) {
    return { outcome: "conflict", reason: "search_answer_exists" };
  }
  const current = facts.recipe;
  const equivalent = current && sameJson(
    { ...current, hide_on_success: current.hide_on_success ?? true, created_at: undefined, updated_at: undefined },
    { ...recipe, hide_on_success: recipe.hide_on_success ?? true, created_at: undefined, updated_at: undefined },
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
    command.fold_visibility === (input.fold_visibility !== false) &&
    command.issued_at === input.issued_at &&
    input.search_answer_timeout === undefined &&
    Object.keys(command).length === 4;
}

export function prepareWorkDismissal(input: WorkDismissal, facts: {
  item: WorkItem | null;
  run: WorkRun | null;
  deliveries: WorkDelivery[];
  search_answer?: SearchAnswerRecord | null;
}): WorkDismissalResult {
  if (!Number.isFinite(Date.parse(input.now))) throw new Error("Work dismissal requires a valid timestamp");
  if (
    (input.fold_visibility !== undefined && typeof input.fold_visibility !== "boolean") ||
    (input.search_answer_outcome !== undefined && !input.search_answer_timeout) ||
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
    const belongsToActiveMapBatch = expected.scope?.map_reduce?.batches?.some(
      (batch) => batch.status === "running" && batch.work_item_id === item.id,
    ) === true;
    if (
      expected.org_id !== item.org_id ||
      (expected.work_item_id !== item.id && !belongsToActiveMapBatch)
    ) {
      throw new Error("Search answer terminal transition must belong to the dismissed work item");
    }
    if (!facts.search_answer || !sameJson(facts.search_answer, expected) || facts.search_answer.outcome) {
      return { outcome: "conflict", reason: "stale_search_answer" };
    }
    if (!isActiveWorkStatus(item.status) || !run || isTerminalWorkRun(run)) {
      return { outcome: "conflict", reason: "inactive_search_answer" };
    }
    searchAnswer = {
      ...facts.search_answer,
      outcome: input.search_answer_outcome ?? "timed_out",
      updated_at: input.now,
    };
  }
  const deliveries = facts.deliveries.map((delivery) => {
    if (delivery.org_id !== item.org_id || delivery.work_item_id !== item.id) {
      throw new Error("Work dismissal delivery must belong to the same organization and work item");
    }
    const result = planWorkDeliveryCommand(delivery, "skipped", {
      org_id: item.org_id, delivery_id: delivery.id, kind: "cancel", now: input.now,
    });
    if (result.outcome !== "applied") {
      throw new Error(`Work dismissal delivery rejected: ${result.outcome === "conflict" ? result.reason : "unexpected replay"}`);
    }
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
    run: { ...run, status: "running", start_state: "pending", result: undefined },
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
  | { outcome: "applied"; item: WorkItem; run: WorkRun; cancellation_requested?: true }
  | {
      outcome: "conflict";
      reason: "missing_work" | "work_skipped" | "not_current_run" | "stale_checkpoint" | "start_closed" | "execution_identity_mismatch";
    };

export interface WorkRunStartLifecycleEvent {
  thread_id: string;
  aggregate_type: "work_run";
  aggregate_id: string;
  aggregate_version: number;
  event_type: "work_run_transitioned";
  dedupe_key: string;
  payload: Record<string, string | number | boolean | undefined>;
}

export function workRunStartLifecycleEvent(
  input: WorkRunStartCheckpoint,
  run: WorkRun,
): WorkRunStartLifecycleEvent | null {
  if (input.kind !== "submitted" || input.expected_run.start_state !== "uncertain") return null;
  const version = run.version ?? 0;
  const eventType = "work_run_transitioned";
  return {
    thread_id: input.expected_item.thread_id,
    aggregate_type: "work_run",
    aggregate_id: run.id,
    aggregate_version: version,
    event_type: eventType,
    dedupe_key: JSON.stringify(["work_run", run.id, version, eventType]),
    payload: {
      work_item_id: input.expected_item.id,
      run_id: run.id,
      from_status: input.expected_run.status,
      to_status: run.status,
      from_start_state: "uncertain",
      to_start_state: "submitted",
      reason: "uncertain_start_reconciled",
    },
  };
}

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
  if (item.status === "skipped") {
    if (expectedItem.status === "skipped"
      || item.current_run_id !== run.id
      || run.start_state !== "pending"
      || isTerminalWorkRun(run)
      || !sameSnapshot(run, expectedRun)) {
      return { outcome: "conflict", reason: "work_skipped" };
    }
    if (input.kind !== "bound" && input.kind !== "submitted") {
      return { outcome: "conflict", reason: "work_skipped" };
    }
    if (typeof input.external_run_id !== "string" || !input.external_run_id.trim()
      || (input.kind === "bound" && typeof input.agent_thread_id !== "string")
      || (input.agent_thread_id !== undefined
        && (typeof input.agent_thread_id !== "string" || !input.agent_thread_id.trim()))) {
      throw new Error("Start checkpoint requires an external execution identity");
    }
    if (workRunHandleIdentityConflicts(run, input)) {
      return { outcome: "conflict", reason: "execution_identity_mismatch" };
    }
    const nextRun: WorkRun = {
      ...run,
      version: (run.version ?? 0) + 1,
      external_run_id: input.external_run_id,
      agent_thread_id: input.agent_thread_id ?? run.agent_thread_id,
      start_state: "submitted",
      updated_at: input.now,
      ...(input.kind === "submitted"
        ? { result: input.result ?? run.result }
        : {}),
    };
    assertWorkRunWrite(nextRun, run);
    assertWorkRunExecutionIdentityWrite(nextRun, run);
    return {
      outcome: "applied",
      item: structuredClone(item),
      run: nextRun,
      cancellation_requested: true,
    };
  }
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
    if (workRunHandleIdentityConflicts(run, input)) {
      return { outcome: "conflict", reason: "execution_identity_mismatch" };
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
  assertWorkRunExecutionIdentityWrite(nextRun, run);
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

export interface WorkObservationLifecycleEvent {
  thread_id: string;
  aggregate_type: "work_run" | "work_delivery";
  aggregate_id: string;
  aggregate_version: number;
  event_type: "work_run_transitioned" | "delivery_created";
  dedupe_key: string;
  payload: Record<string, string | undefined>;
}

export interface WorkDeliveryLifecycleEvent {
  thread_id: string;
  aggregate_id: string;
  aggregate_version: number;
  event_type: "delivery_claimed" | "delivery_transitioned";
  dedupe_key: string;
  payload: Record<string, string | number | boolean | undefined>;
}

export function workDeliveryLifecycleEvent(input: {
  thread_id: string;
  previous: WorkDelivery;
  next: WorkDelivery;
  command: WorkDeliveryCommand;
  aggregate_version: number;
}): WorkDeliveryLifecycleEvent | null {
  const { previous, next, command, aggregate_version: version } = input;
  const changed = previous.status !== next.status
    || previous.write_back !== next.write_back
    || previous.attempts !== next.attempts
    || previous.last_error !== next.last_error
    || previous.next_retry_at !== next.next_retry_at
    || previous.lease_owner !== next.lease_owner
    || previous.claim_token !== next.claim_token
    || previous.cancel_requested_at !== next.cancel_requested_at
    || !sameJson(previous.channel_receipt, next.channel_receipt);
  if (!changed || command.kind === "renew") return null;
  const eventType = command.kind === "claim" ? "delivery_claimed" : "delivery_transitioned";
  return {
    thread_id: input.thread_id,
    aggregate_id: next.id,
    aggregate_version: version,
    event_type: eventType,
    dedupe_key: JSON.stringify([
      "work_delivery", next.id, version, eventType,
    ]),
    payload: {
      delivery_id: next.id,
      run_id: next.run_id,
      command_kind: command.kind,
      before_status: previous.status,
      after_status: next.status,
      before_write_back: previous.write_back,
      after_write_back: next.write_back,
      attempts: next.attempts,
      ...(command.kind === "receipt" ? { acceptance_proven: true } : {}),
      ...(next.cancel_requested_at ? { cancellation_requested: true } : {}),
    },
  };
}

export function workObservationLifecycleEvents(
  expected: CommitWorkObservation,
  transition: WorkObservationTransition,
  previousDelivery: WorkDelivery | null,
  nextDelivery?: WorkDelivery,
): WorkObservationLifecycleEvent[] {
  const events: WorkObservationLifecycleEvent[] = [];
  if (transition.changed) {
    const aggregateVersion = transition.run.version ?? 0;
    events.push({
      thread_id: transition.item.thread_id,
      aggregate_type: "work_run",
      aggregate_id: transition.run.id,
      aggregate_version: aggregateVersion,
      event_type: "work_run_transitioned",
      dedupe_key: JSON.stringify([
        "work_run", transition.run.id, aggregateVersion, "work_run_transitioned",
      ]),
      payload: {
        work_item_id: transition.item.id,
        run_id: transition.run.id,
        from_status: expected.expected_run.status,
        to_status: transition.run.status,
      },
    });
  }
  if (nextDelivery && !previousDelivery) {
    events.push({
      thread_id: transition.item.thread_id,
      aggregate_type: "work_delivery",
      aggregate_id: nextDelivery.id,
      aggregate_version: 0,
      event_type: "delivery_created",
      dedupe_key: JSON.stringify([
        "work_delivery", nextDelivery.id, 0, "delivery_created",
      ]),
      payload: {
        work_item_id: transition.item.id,
        run_id: transition.run.id,
        delivery_id: nextDelivery.id,
      },
    });
  }
  return events;
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
      reason: "missing_work" | "stale_observation" | "completed_result_changed" | "not_current_run" | "execution_identity_unknown" | "execution_identity_mismatch" | "execution_start_unconfirmed";
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
  if (workRunHandleIdentityConflicts(run, input.handle)) {
    return { outcome: "conflict", reason: "execution_identity_mismatch" };
  }
  if (item.status === "skipped" && (
    !run.external_run_id || input.handle.external_run_id !== run.external_run_id
    || run.start_state === "pending" || run.start_state === "uncertain"
  )) {
    return { outcome: "conflict", reason: "execution_identity_unknown" };
  }
  if (run.start_state === "pending" || run.start_state === "uncertain") {
    return { outcome: "conflict", reason: "execution_start_unconfirmed" };
  }
  if (!workRunHandleMatchesExecution(run, input.handle)) {
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

export function prepareCancellationJobObservation(
  input: CommitCancellationJobObservation,
  current: WorkRun | null,
): CommitCancellationJobObservationResult {
  if (!Number.isFinite(Date.parse(input.now))) {
    throw new Error("Cancellation observation requires a valid timestamp");
  }
  const { expected_run: expected, handle } = input;
  if (
    expected.org_id !== input.org_id ||
    !expected.id.trim() ||
    !expected.work_item_id.trim() ||
    !Number.isSafeInteger(expected.version ?? 0) ||
    (expected.version ?? 0) < 0
  ) {
    throw new Error("Cancellation observation requires an exact run identity");
  }
  if (!current) return { outcome: "conflict" };
  if (current.org_id !== expected.org_id || current.id !== expected.id
    || current.work_item_id !== expected.work_item_id) {
    throw new Error("Cancellation observation run identity does not match");
  }
  if (!sameSnapshot(current, expected)) return { outcome: "conflict" };
  if (isTerminalWorkRun(current)) {
    return { outcome: "already_terminal", run: structuredClone(current) };
  }
  if (handle.status !== "cancelled" && handle.status !== "completed" && handle.status !== "failed") {
    throw new Error("Cancellation observation must prove a terminal executor state");
  }
  if (!workRunHandleMatchesExecution(current, handle)) {
    return { outcome: "conflict" };
  }
  const next: WorkRun = {
    ...current,
    version: (current.version ?? 0) + 1,
    start_state: undefined,
    external_run_id: current.external_run_id ?? handle.external_run_id,
    agent_thread_id: handle.agent_thread_id ?? current.agent_thread_id,
    status: handle.status,
    result: handle.result ?? current.result,
    updated_at: input.now,
  };
  assertWorkRunWrite(next, current);
  return { outcome: "applied", run: next };
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
  assertWorkRunExecutionIdentityWrite(nextRun, run);
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
