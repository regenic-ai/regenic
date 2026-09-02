import type { DriverCatalogFieldWhen } from "./channel-driver";

export function matchesCatalogFieldWhen(
  when: DriverCatalogFieldWhen | undefined,
  values: Record<string, unknown>,
): boolean {
  if (!when) {
    return true;
  }
  const current = String(values[when.field] ?? "");
  if (when.values?.length) {
    return when.values.includes(current);
  }
  if (when.value !== undefined) {
    if (when.value.includes("|")) {
      return when.value.split("|").includes(current);
    }
    return current === when.value;
  }
  return true;
}
