import { matchesCatalogFieldWhen } from "@regenic/domain";
import type { ConnectorCatalogItem } from "./types.ts";

export { matchesCatalogFieldWhen };

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
