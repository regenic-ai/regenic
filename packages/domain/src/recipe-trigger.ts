import { isLocalOutboundId } from "./message-contract";
import { recordClassFromType } from "./record-class";
import type { Specification } from "./specification";
import {
  PULL_INTERVAL_MS,
  PULL_INTERVALS_MS,
  type Recipe,
  type RecipeMatch,
  type RecipeTrigger,
  type RecipeTriggerKind,
  type WorkItem,
  type WorkItemStatus,
} from "./work";

/**
 * Match must name a subject. Facet and source-only matches are device
 * capabilities, not On=.
 */
export class RecipeMatchSpec implements Specification<RecipeMatch> {
  isSatisfiedBy(match: RecipeMatch): boolean {
    if (match.thread_id?.trim()) {
      return true;
    }
    if (match.unit_kind?.trim()) {
      return true;
    }
    if (match.record_class === "task") {
      return true;
    }
    if (
      match.source?.trim() &&
      match.record_class &&
      match.record_class !== "utterance"
    ) {
      return true;
    }
    return false;
  }
}

export const recipeMatchSpec = new RecipeMatchSpec();

export function recipeMatchIsSpecific(match: RecipeMatch): boolean {
  return recipeMatchSpec.isSatisfiedBy(match);
}

/** @deprecated Use recipeMatchIsSpecific. Kept for older AutoStart call sites. */
export function recipeAllowsAutoStart(match: RecipeMatch): boolean {
  return recipeMatchIsSpecific(match);
}

export function isRecipeTriggerKind(value: unknown): value is RecipeTriggerKind {
  return value === "push" || value === "pull" || value === "manual";
}

export function isPullIntervalMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (PULL_INTERVALS_MS as readonly number[]).includes(value)
  );
}

export function inferLegacyRecipeTrigger(match: RecipeMatch): RecipeTrigger {
  return recipeMatchIsSpecific(match)
    ? { kind: "push", coalesce: true }
    : { kind: "manual" };
}

export function recipeTriggerOf(
  recipe: Pick<Recipe, "match"> & { trigger?: RecipeTrigger },
): RecipeTrigger {
  return recipe.trigger ?? inferLegacyRecipeTrigger(recipe.match);
}

export function normalizeRecipeTrigger(
  input: RecipeTrigger | undefined,
  match: RecipeMatch,
): RecipeTrigger {
  const kind = isRecipeTriggerKind(input?.kind)
    ? input.kind
    : inferLegacyRecipeTrigger(match).kind;
  if (kind === "pull") {
    return {
      kind: "pull",
      interval_ms: isPullIntervalMs(input?.interval_ms)
        ? input.interval_ms
        : PULL_INTERVAL_MS["1h"],
    };
  }
  if (kind === "manual") {
    return { kind: "manual" };
  }
  return {
    kind: "push",
    coalesce: input?.coalesce !== false,
  };
}

export function recipeAllowsPushDispatch(recipe: Recipe): boolean {
  return (
    recipe.enabled &&
    recipeTriggerOf(recipe).kind === "push" &&
    recipeMatchIsSpecific(recipe.match)
  );
}

export function recipeAllowsBind(recipe: Recipe): boolean {
  const kind = recipeTriggerOf(recipe).kind;
  return (
    recipe.enabled &&
    recipeMatchIsSpecific(recipe.match) &&
    (kind === "push" || kind === "manual")
  );
}

export function recipeWantsCoalesce(recipe?: Recipe | null): boolean {
  if (!recipe) {
    return true;
  }
  const trigger = recipeTriggerOf(recipe);
  return trigger.kind !== "push" || trigger.coalesce !== false;
}

export function recipeAllowsPullDispatch(recipe: Recipe): boolean {
  const trigger = recipeTriggerOf(recipe);
  return (
    recipe.enabled &&
    trigger.kind === "pull" &&
    Boolean(recipe.match.thread_id?.trim()) &&
    isPullIntervalMs(trigger.interval_ms)
  );
}

export function recipeWantsWriteBack(recipe: {
  can_write_back?: boolean;
  trigger?: RecipeTrigger;
}): boolean {
  if (recipe.trigger?.kind === "pull") {
    return recipe.can_write_back !== false;
  }
  return Boolean(recipe.can_write_back);
}

export function recipeWantsContext(recipe: {
  include_context?: boolean;
  trigger?: RecipeTrigger;
}): boolean {
  return recipe.trigger?.kind === "pull" || Boolean(recipe.include_context);
}

export function shouldAcceptPushRecord(input: {
  kind?: string;
  direction?: string;
  external_id?: string;
  type?: string;
}): boolean {
  if (input.direction === "outbound") {
    return false;
  }
  if (input.external_id && isLocalOutboundId(input.external_id)) {
    return false;
  }
  // Speakers only exist on utterances. A ticket's kind=system is not a chat echo.
  if (recordClassFromType(input.type) === "task") {
    return true;
  }
  if (input.kind === "assistant" || input.kind === "system") {
    return false;
  }
  return true;
}

export function pushUnitKey(eventId: string): string {
  return eventId;
}

export function pullPeriodKey(nowMs: number, intervalMs: number): string {
  const start = Math.floor(nowMs / intervalMs) * intervalMs;
  return new Date(start).toISOString();
}

export function pullUnitKey(recipeId: string, periodKey: string): string {
  return `pull:${recipeId}:${periodKey}`;
}

export function isPullDue(recipe: Recipe, now: string): boolean {
  if (!recipeAllowsPullDispatch(recipe)) {
    return false;
  }
  if (!recipe.next_run_at) {
    return true;
  }
  return Date.parse(now) >= Date.parse(recipe.next_run_at);
}

export function shouldKeepPullSchedule(
  existing: Recipe | undefined,
  next: Pick<Recipe, "match" | "trigger">,
): boolean {
  if (!existing || existing.trigger.kind !== "pull" || next.trigger.kind !== "pull") {
    return false;
  }
  return (
    existing.trigger.interval_ms === next.trigger.interval_ms &&
    (existing.match.thread_id ?? "") === (next.match.thread_id ?? "")
  );
}

export function advancePullNextRun(
  from: string,
  intervalMs: number,
  now: string,
): string {
  const nowMs = Date.parse(now);
  let next = Date.parse(from);
  if (!Number.isFinite(next)) {
    next = nowMs;
  }
  next += intervalMs;
  while (Number.isFinite(nowMs) && next <= nowMs) {
    next += intervalMs;
  }
  return new Date(next).toISOString();
}

export function findWorkItemByUnitKey(
  items: readonly WorkItem[],
  threadId: string,
  unitKey: string,
): WorkItem | undefined {
  return items.find(
    (item) => item.thread_id === threadId && item.unit_key === unitKey,
  );
}

const PUSH_RETRY_DELAYS_MS = [30_000, 120_000, 480_000] as const;
const PUSH_RETRY_MAX_ATTEMPTS = 3;

export function shouldRetryFailedPush(input: {
  status: WorkItemStatus;
  updated_at: string;
  attempts: number;
  now: string;
}): boolean {
  if (input.status !== "failed") {
    return false;
  }
  if (input.attempts >= PUSH_RETRY_MAX_ATTEMPTS) {
    return false;
  }
  const elapsed = Date.parse(input.now) - Date.parse(input.updated_at);
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    return false;
  }
  const wait =
    PUSH_RETRY_DELAYS_MS[
      Math.min(input.attempts, PUSH_RETRY_DELAYS_MS.length - 1)
    ] ?? PUSH_RETRY_DELAYS_MS[0];
  return elapsed >= wait;
}
