import { randomUUID } from "node:crypto";
import {
  isRecordClass,
  isThreadFacet,
  normalizeRecipeTrigger,
  normalizeUnitKind,
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
  include_context?: boolean;
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
  return {
    id: existing?.id ?? input.id?.trim() ?? `recipe-${randomUUID()}`,
    org_id: orgId,
    name,
    match,
    trigger,
    executor_type,
    executor_config: input.executor_config ?? existing?.executor_config ?? {},
    can_write_back: input.can_write_back ?? existing?.can_write_back ?? pull,
    include_context: input.include_context ?? existing?.include_context ?? pull,
    enabled: input.enabled ?? existing?.enabled ?? true,
    ...(pull
      ? {
          next_run_at: shouldKeepPullSchedule(existing, { match, trigger })
            ? existing?.next_run_at ?? now
            : now,
        }
      : {}),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
}

function normalizeMatch(match: RecipeMatch): RecipeMatch {
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
  };
}
