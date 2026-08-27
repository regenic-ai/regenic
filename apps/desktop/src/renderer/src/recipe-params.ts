import type { ExecutorCatalogEntry } from "./types";

export function invokeCopy(
  catalog: ExecutorCatalogEntry | undefined,
  config: Record<string, string> | undefined,
): string {
  const values = config ?? {};
  const bits = (catalog?.fields ?? [])
    .map((field) => values[field.key]?.trim())
    .filter((value): value is string => Boolean(value));
  if (bits.length > 0) {
    return bits.join(" · ");
  }
  return (values.prompt ?? values.instruction ?? values.skill ?? "").trim();
}

export function missingRequiredField(
  catalog: ExecutorCatalogEntry | undefined,
  config: Record<string, string> | undefined,
): string | undefined {
  for (const field of catalog?.fields ?? []) {
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
    const next = { ...(existing ?? {}) };
    if (!next.prompt?.trim() && next.instruction?.trim()) {
      next.prompt = next.instruction;
    }
    return next;
  }
  const next: Record<string, string> = {};
  for (const field of catalog.fields) {
    const current = existing?.[field.key];
    if (current?.trim()) {
      next[field.key] = current;
    } else if (field.default) {
      next[field.key] = field.default;
    }
  }
  if (
    !next.prompt?.trim() &&
    existing?.instruction?.trim() &&
    catalog.fields.some((field) => field.key === "prompt")
  ) {
    next.prompt = existing.instruction;
  }
  return next;
}
