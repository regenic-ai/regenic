import { randomUUID } from "node:crypto";
import {
  isRecordClass,
  isThreadFacet,
  normalizeRecipeMaxConcurrent,
  normalizeRecipeTrigger,
  normalizeUnitKind,
  initialPullNextRun,
  recipeMatchIsSpecific,
  recipeSpecificity,
  shouldKeepPullSchedule,
  type JsonValue,
  type Recipe,
  type RecipeMatch,
  type RecipeTrigger,
} from "@regenic/domain";
import { PersonalConnectorError } from "./personal-errors";

export interface RecipeInput {
  id?: string;
  name?: string;
  match?: RecipeMatch;
  trigger?: RecipeTrigger;
  executor_type?: string;
  executor_config?: Record<string, JsonValue>;
  can_write_back?: boolean;
  write_back_thread_id?: string | null;
  hide_on_success?: boolean;
  include_context?: boolean;
  max_concurrent?: number | null;
  enabled?: boolean;
}

export function normalizeRecipe(
  input: RecipeInput,
  orgId: string,
  now: string,
  existing?: Recipe,
): Recipe {
  const name = (input.name ?? existing?.name ?? "").trim();
  if (!name) {
    throw new PersonalConnectorError("invalid_config", "Recipe name is required", 400);
  }
  const executor_type = (input.executor_type ?? existing?.executor_type ?? "").trim();
  if (!executor_type) {
    throw new PersonalConnectorError(
      "invalid_config",
      "executor_type is required",
      400,
    );
  }
  const match = normalizeMatch(input.match ?? existing?.match ?? {});
  const trigger = normalizeRecipeTrigger(input.trigger ?? existing?.trigger, match);
  if (trigger.kind === "pull") {
    if (!match.thread_id) {
      throw new PersonalConnectorError(
        "invalid_config",
        "Pull recipes need a conversation",
        400,
      );
    }
  } else if (recipeSpecificity(match) === 0 || !recipeMatchIsSpecific(match)) {
    throw new PersonalConnectorError(
      "invalid_config",
      "Recipe match needs a thread, a unit kind, a task class, or source plus a non-utterance class",
      400,
    );
  }
  const pull = trigger.kind === "pull";
  const max_concurrent = normalizeRecipeMaxConcurrent(
    input.max_concurrent === undefined ? existing?.max_concurrent : input.max_concurrent,
  );
  if (
    input.write_back_thread_id !== undefined &&
    input.write_back_thread_id !== null &&
    typeof input.write_back_thread_id !== "string"
  ) {
    throw new PersonalConnectorError(
      "invalid_config",
      "write_back_thread_id must be a conversation id",
      400,
    );
  }
  if (
    input.hide_on_success !== undefined &&
    typeof input.hide_on_success !== "boolean"
  ) {
    throw new PersonalConnectorError(
      "invalid_config",
      "hide_on_success must be a boolean",
      400,
    );
  }
  const writeBackThreadId =
    input.write_back_thread_id === undefined
      ? existing?.write_back_thread_id
      : input.write_back_thread_id?.trim() || undefined;
  return {
    id: existing?.id ?? input.id?.trim() ?? `recipe-${randomUUID()}`,
    org_id: orgId,
    name,
    match,
    trigger,
    executor_type,
    executor_config: input.executor_config ?? existing?.executor_config ?? {},
    can_write_back: input.can_write_back ?? existing?.can_write_back ?? pull,
    ...(writeBackThreadId ? { write_back_thread_id: writeBackThreadId } : {}),
    hide_on_success:
      input.hide_on_success ??
      existing?.hide_on_success ??
      Boolean(existing),
    include_context: input.include_context ?? existing?.include_context ?? pull,
    enabled: input.enabled ?? existing?.enabled ?? true,
    ...(max_concurrent ? { max_concurrent } : {}),
    ...(pull
      ? {
          next_run_at: shouldKeepPullSchedule(existing, { match, trigger })
            ? existing?.next_run_at ?? now
            : initialPullNextRun(trigger, now),
        }
      : {}),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

function normalizeMatch(match: RecipeMatch): RecipeMatch {
  for (const key of ["text_contains", "text_excludes"] as const) {
    if (
      match[key] !== undefined &&
      (typeof match[key] !== "string" || !match[key]?.trim())
    ) {
      throw new PersonalConnectorError(
        "invalid_config",
        `${key} must be a non-empty string`,
        400,
      );
    }
  }
  const record_class = match.record_class;
  if (record_class !== undefined && !isRecordClass(record_class)) {
    throw new PersonalConnectorError(
      "invalid_config",
      "record_class is not a closed class",
      400,
    );
  }
  const thread_facet = match.thread_facet;
  if (thread_facet !== undefined && !isThreadFacet(thread_facet)) {
    throw new PersonalConnectorError(
      "invalid_config",
      "thread_facet is not a closed facet",
      400,
    );
  }
  const unit_kind = normalizeUnitKind(match.unit_kind);
  return {
    ...(record_class ? { record_class } : {}),
    ...(thread_facet ? { thread_facet } : {}),
    ...(match.source?.trim() ? { source: match.source.trim() } : {}),
    ...(match.thread_id?.trim() ? { thread_id: match.thread_id.trim() } : {}),
    ...(unit_kind ? { unit_kind } : {}),
    ...(match.text_contains !== undefined ? { text_contains: match.text_contains } : {}),
    ...(match.text_excludes !== undefined ? { text_excludes: match.text_excludes } : {}),
  };
}
