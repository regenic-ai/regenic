import type { DriverCatalogField, DriverCatalogFieldWhen } from "./driver";

export type ConnectorFieldValueIssue = "required" | "type" | "range" | "option";

export function matchesCatalogFieldWhen(
  when: DriverCatalogFieldWhen | undefined,
  values: Record<string, unknown>,
): boolean {
  if (!when) return true;
  const current = String(values[when.field] ?? "");
  if (when.values?.length) return when.values.includes(current);
  if (when.value !== undefined) return when.value.split("|").includes(current);
  return true;
}

export function connectorFieldValueIssue(
  field: DriverCatalogField,
  value: unknown,
  savedCredential = false,
): ConnectorFieldValueIssue | undefined {
  const empty = value === undefined || value === null ||
    (typeof value === "string" && !value.trim()) ||
    (Array.isArray(value) && value.length === 0);
  if (empty) {
    const keepCredential = (field.secret || field.widget === "password") &&
      savedCredential && value !== null;
    return field.required && !keepCredential ? "required" : undefined;
  }
  if (!field.type) return undefined;
  const valid =
    (field.type === "string" && typeof value === "string") ||
    (field.type === "number" && typeof value === "number" && Number.isFinite(value)) ||
    (field.type === "boolean" && typeof value === "boolean") ||
    (field.type === "string_array" && Array.isArray(value) &&
      value.every((item) => typeof item === "string"));
  if (!valid) return "type";
  if (typeof value === "number" &&
    ((field.min !== undefined && value < field.min) ||
      (field.max !== undefined && value > field.max))) return "range";
  // Dynamic pages are suggestions, not a complete membership set.
  if (!field.allow_custom && !field.dynamic_options && field.options?.length) {
    const allowed = new Set(field.options.map((option) => option.value));
    const selected = Array.isArray(value) ? value : [value];
    if (selected.some((item) => typeof item !== "string" || !allowed.has(item))) return "option";
  }
  return undefined;
}
