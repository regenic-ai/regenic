import type {
  RecipeMatch,
  RecipeTrigger,
  RecipeView,
} from "./types";

export const RECIPE_BUNDLE_VERSION = 1;

export interface RecipeTransferItem {
  name: string;
  match: RecipeMatch;
  trigger: RecipeTrigger;
  executor_type: string;
  executor_config: Record<string, string>;
  can_write_back: boolean;
  include_context: boolean;
  max_concurrent?: number | null;
  enabled: boolean;
}

export interface RecipeBundle {
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
    recipes: recipes.map(recipeToTransferItem),
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
    return {
      kind: "pull",
      interval_ms:
        typeof value.interval_ms === "number" && Number.isFinite(value.interval_ms)
          ? value.interval_ms
          : 60 * 60 * 1000,
    };
  }
  if (value.kind === "manual") {
    return { kind: "manual" };
  }
  if (value.kind === "push") {
    return { kind: "push", coalesce: value.coalesce !== false };
  }
  return null;
}

function parseTransferItem(value: unknown): RecipeTransferItem | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value.name !== "string" || !value.name.trim()) {
    return null;
  }
  if (typeof value.executor_type !== "string" || !value.executor_type.trim()) {
    return null;
  }
  const match = parseMatch(value.match);
  const trigger = parseTrigger(value.trigger);
  if (!match || !trigger) {
    return null;
  }
  const executor_config: Record<string, string> = {};
  if (isRecord(value.executor_config)) {
    for (const [key, entry] of Object.entries(value.executor_config)) {
      if (typeof entry === "string") {
        executor_config[key] = entry;
      }
    }
  }
  const max =
    value.max_concurrent === null || value.max_concurrent === undefined
      ? null
      : typeof value.max_concurrent === "number" &&
          Number.isFinite(value.max_concurrent) &&
          value.max_concurrent >= 1
        ? Math.floor(value.max_concurrent)
        : null;
  return {
    name: value.name.trim(),
    match,
    trigger,
    executor_type: value.executor_type.trim(),
    executor_config,
    can_write_back: value.can_write_back === true,
    include_context: value.include_context === true,
    max_concurrent: max,
    enabled: value.enabled !== false,
  };
}

export function parseRecipeBundle(raw: string): RecipeBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("invalid_json");
  }
  if (!isRecord(parsed)) {
    throw new Error("invalid_bundle");
  }
  const version = Number(parsed.version);
  if (!Number.isFinite(version) || version < 1) {
    throw new Error("unsupported_version");
  }
  if (!Array.isArray(parsed.recipes) || parsed.recipes.length === 0) {
    throw new Error("empty_recipes");
  }
  const recipes: RecipeTransferItem[] = [];
  for (const item of parsed.recipes) {
    const next = parseTransferItem(item);
    if (!next) {
      throw new Error("invalid_recipe");
    }
    recipes.push(next);
  }
  return {
    version,
    exported_at:
      typeof parsed.exported_at === "string" && parsed.exported_at.trim()
        ? parsed.exported_at
        : new Date().toISOString(),
    recipes,
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
