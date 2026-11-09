import type { ConnectorCatalogItem } from "./types.ts";
import { matchesCatalogFieldWhen } from "@regenic/connector-contract/form";
export { matchesCatalogFieldWhen };

export function catalogInstallConfirm(
  kind: ConnectorCatalogItem,
  values: Record<string, unknown>,
): ConnectorCatalogItem["install_confirm"] | undefined {
  const confirm = kind.install_confirm;
  if (!confirm || !matchesCatalogFieldWhen(confirm.when, values)) {
    return undefined;
  }
  return confirm;
}
