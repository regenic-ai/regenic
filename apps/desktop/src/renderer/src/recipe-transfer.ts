import { flowConfigFromFields, type FlowWireConfig } from "./flow-wire.ts";
import type {
  RecipeMatch,
  RecipeTrigger,
  RecipeView,
} from "./types";

export const RECIPE_BUNDLE_VERSION = 2;

export interface RecipeTransferItem {
  name: string;
  match: RecipeMatch;
  trigger: RecipeTrigger;
  executor_type: string;
  executor_config: Record<string, string>;
  can_write_back: boolean;
  write_back_thread_id?: string;
  hide_on_success: boolean;
  include_context: boolean;
  max_concurrent?: number | null;
  enabled: boolean;
}

export interface RecipeBundle {
  version: number;
  exported_at: string;
  flows: Array<{ name: string; config: FlowWireConfig }>;
}

export interface ParsedRecipeBundle {
  version: number;
  exported_at: string;
  recipes: RecipeTransferItem[];
}

export function recipeToTransferItem(recipe: RecipeView): RecipeTransferItem {
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(recipe.executor_config ?? {})) {
    if (typeof value === "string") {
      config[key] = value;
    }
  }
  return {
    name: recipe.name,
    match: { ...recipe.match },
    trigger: { ...recipe.trigger },
    executor_type: recipe.executor_type,
    executor_config: config,
    can_write_back: recipe.can_write_back,
    ...(recipe.write_back_thread_id ? { write_back_thread_id: recipe.write_back_thread_id } : {}),
    hide_on_success: recipe.hide_on_success ?? true,
    include_context: recipe.include_context,
    max_concurrent: recipe.max_concurrent ?? null,
    enabled: recipe.enabled,
  };
}

export function buildRecipeBundle(
  recipes: RecipeView[],
  now = new Date().toISOString(),
): RecipeBundle {
  return {
    version: RECIPE_BUNDLE_VERSION,
    exported_at: now,
    flows: recipes.map((recipe) => {
      const item = recipeToTransferItem(recipe);
      return { name: item.name, config: flowConfigFromFields(item) };
    }),
  };
}

export function stringifyRecipeBundle(bundle: RecipeBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMatch(value: unknown): RecipeMatch | null {
  if (!isRecord(value)) {
    return null;
  }
  const match: RecipeMatch = {};
  for (const key of ["text_contains", "text_excludes", "title_contains", "title_excludes"] as const) {
    if (value[key] !== undefined) {
      if (typeof value[key] !== "string" || !value[key].trim()) {
        return null;
      }
      match[key] = value[key];
    }
  }
  if (typeof value.record_class === "string") {
    match.record_class = value.record_class as RecipeMatch["record_class"];
  }
  if (typeof value.thread_facet === "string") {
    match.thread_facet = value.thread_facet as RecipeMatch["thread_facet"];
  }
  if (typeof value.source === "string" && value.source.trim()) {
    match.source = value.source.trim();
  }
  if (typeof value.thread_id === "string" && value.thread_id.trim()) {
    match.thread_id = value.thread_id.trim();
  }
  if (typeof value.unit_kind === "string" && value.unit_kind.trim()) {
    match.unit_kind = value.unit_kind.trim();
  }
  return match;
}

function parseTrigger(value: unknown): RecipeTrigger | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }
  if (value.kind === "pull") {
    const trigger: RecipeTrigger = {
      kind: "pull",
      interval_ms:
        typeof value.interval_ms === "number" && Number.isFinite(value.interval_ms)
          ? value.interval_ms
          : 60 * 60 * 1000,
    };
    if (
      typeof value.at_minute === "number" &&
      Number.isInteger(value.at_minute) &&
      value.at_minute >= 0 &&
      value.at_minute <= 1439 &&
      typeof value.timezone === "string" &&
      value.timezone.trim()
    ) {
      trigger.at_minute = value.at_minute;
      trigger.timezone = value.timezone.trim();
      if (Array.isArray(value.weekdays)) {
        const days = [
          ...new Set(
            value.weekdays.filter(
              (day): day is number =>
                typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 7,
            ),
          ),
        ].sort((left, right) => left - right);
        if (days.length > 0) {
          trigger.weekdays = days;
        }
      }
    }
    return trigger;
  }
  if (value.kind === "manual") {
    return { kind: "manual" };
  }
  if (value.kind === "push") {
    return { kind: "push", coalesce: value.coalesce !== false };
  }
  return null;
}

export function parseRecipeBundle(raw: string): ParsedRecipeBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid_json");
  }
  if (!isRecord(parsed)) {
    throw new Error("invalid_bundle");
  }
  if (parsed.version !== RECIPE_BUNDLE_VERSION) {
    throw new Error("unsupported_version");
  }
  if (!Array.isArray(parsed.flows) || parsed.flows.length === 0) {
    throw new Error("empty_recipes");
  }
  const recipes: RecipeTransferItem[] = [];
  for (const item of parsed.flows) {
    const next = parseFlowItem(item);
    if (!next) {
      throw new Error("invalid_recipe");
    }
    recipes.push(next);
  }
  return {
    version: RECIPE_BUNDLE_VERSION,
    exported_at:
      typeof parsed.exported_at === "string" && parsed.exported_at.trim()
        ? parsed.exported_at
        : new Date().toISOString(),
    recipes,
  };
}

function parseFlowItem(value: unknown): RecipeTransferItem | null {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name.trim() || !isRecord(value.config)) {
    return null;
  }
  const config = value.config;
  const handler = config.handler;
  const scope = config.scope;
  if (
    !isRecord(handler) ||
    handler.kind !== "agent" ||
    typeof handler.executor_type !== "string" ||
    !handler.executor_type.trim() ||
    !isRecord(scope) ||
    scope.kind !== "new_messages"
  ) {
    return null;
  }
  const match = parseMatch(scope.match);
  const trigger = parseTrigger(config.trigger);
  if (!match || !trigger || typeof config.hide_on_success !== "boolean" || typeof config.include_context !== "boolean") {
    return null;
  }
  const destination = config.destination;
  if (destination !== undefined) {
    if (
      !isRecord(destination) ||
      destination.kind !== "reply" ||
      typeof destination.thread !== "string" ||
      !destination.thread.trim() ||
      destination.confirm !== false ||
      typeof destination.send !== "boolean"
    ) {
      return null;
    }
  }
  const executor_config: Record<string, string> = {};
  if (isRecord(handler.params)) {
    for (const [key, entry] of Object.entries(handler.params)) {
      if (typeof entry !== "string") {
        return null;
      }
      executor_config[key] = entry;
    }
  }
  const max = config.max_concurrent === undefined
    ? null
    : typeof config.max_concurrent === "number" && Number.isFinite(config.max_concurrent) && config.max_concurrent >= 1
      ? Math.floor(config.max_concurrent)
      : null;
  if (config.max_concurrent !== undefined && max === null) {
    return null;
  }
  const reply = isRecord(destination) ? destination : undefined;
  return {
    name: value.name.trim(),
    match,
    trigger,
    executor_type: handler.executor_type.trim(),
    executor_config,
    can_write_back: reply?.send === true,
    ...(reply && reply.thread !== "origin" ? { write_back_thread_id: String(reply.thread).trim() } : {}),
    hide_on_success: config.hide_on_success,
    include_context: config.include_context,
    max_concurrent: max,
    enabled: config.enabled !== false,
  };
}

export function downloadRecipeBundle(bundle: RecipeBundle, filename?: string): void {
  const blob = new Blob([stringifyRecipeBundle(bundle)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download =
    filename ??
    `regenic-rules-${bundle.exported_at.slice(0, 10) || "export"}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
