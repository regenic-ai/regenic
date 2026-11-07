import type { ExecutorCatalogEntry } from "./types";

const SHARED_INSTRUCTION_KEYS = new Set(["prompt", "instruction"]);

export function taskInstructionValue(
  config: Record<string, string> | undefined,
): string {
  for (const key of ["prompt", "instruction"]) {
    const value = config?.[key];
    if (value?.trim()) {
      return value;
    }
  }
  return config?.prompt ?? config?.instruction ?? "";
}

export function invokeCopy(
  catalog: ExecutorCatalogEntry | undefined,
  config: Record<string, string> | undefined,
): string {
  const values = config ?? {};
  const bits = (catalog?.fields ?? [])
    .filter((field) => !SHARED_INSTRUCTION_KEYS.has(field.key))
    .map((field) => values[field.key]?.trim())
    .filter((value): value is string => Boolean(value));
  const instruction = taskInstructionValue(values).trim();
  return [...bits, instruction].filter(Boolean).join(" · ");
}

export function missingRequiredField(
  catalog: ExecutorCatalogEntry | undefined,
  config: Record<string, string> | undefined,
): string | undefined {
  for (const field of catalog?.fields ?? []) {
    if (SHARED_INSTRUCTION_KEYS.has(field.key)) {
      continue;
    }
    if (field.required && !(config?.[field.key] ?? "").trim()) {
      return field.label;
    }
  }
  return undefined;
}

export function configFromCatalog(
  catalog: ExecutorCatalogEntry | undefined,
  existing?: Record<string, string>,
): Record<string, string> {
  if (!catalog) {
    return { ...(existing ?? {}) };
  }
  const next: Record<string, string> = {};
  for (const key of SHARED_INSTRUCTION_KEYS) {
    const value = existing?.[key];
    if (value !== undefined) {
      next[key] = value;
    }
  }
  for (const field of catalog.fields) {
    if (SHARED_INSTRUCTION_KEYS.has(field.key)) {
      continue;
    }
    const current = existing?.[field.key];
    if (current?.trim()) {
      next[field.key] = current;
    } else if (field.default) {
      next[field.key] = field.default;
    }
  }
  return next;
}

export function configForRecipeEdit(
  catalog: ExecutorCatalogEntry | undefined,
  existing: Record<string, string>,
): Record<string, string> {
  const next = { ...existing };
  for (const field of catalog?.fields ?? []) {
    if (
      !SHARED_INSTRUCTION_KEYS.has(field.key) &&
      !Object.hasOwn(next, field.key) &&
      field.default
    ) {
      next[field.key] = field.default;
    }
  }
  return next;
}
