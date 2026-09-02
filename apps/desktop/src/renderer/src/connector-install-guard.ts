import type { ConnectorCatalogItem } from "./types.ts";

// Keep in sync with packages/domain `catalog-field-when`.
// The desktop renderer bundle does not import @regenic/domain.

type CatalogFieldWhen = NonNullable<
  ConnectorCatalogItem["install_confirm"]
>["when"];

export function matchesCatalogFieldWhen(
  when: CatalogFieldWhen | undefined,
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

export function catalogInstallConfirm(
  kind: ConnectorCatalogItem,
  values: Record<string, string>,
): ConnectorCatalogItem["install_confirm"] | undefined {
  const confirm = kind.install_confirm;
  if (!confirm || !matchesCatalogFieldWhen(confirm.when, values)) {
    return undefined;
  }
  return confirm;
}
