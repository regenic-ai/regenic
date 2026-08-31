import { t } from "../../shared/i18n.ts";
import type { EngineInstallationView, SyncProgressView } from "./types.ts";

export function syncProgressSummary(
  sync?: SyncProgressView | null,
): string {
  if (!sync || sync.discovered === 0) {
    return t("sync.noneFound");
  }
  return t("sync.coverage", {
    discovered: sync.catalog_complete
      ? sync.discovered
      : `${sync.discovered}+`,
    seeded: sync.seeded,
    backfilling: sync.backfilling,
  });
}

export function syncProgressTone(
  sync?: SyncProgressView | null,
): "ok" | "warn" | undefined {
  if (!sync) {
    return undefined;
  }
  if (!sync.catalog_complete || sync.unseeded > 0 || sync.backfilling > 0) {
    return "warn";
  }
  return "ok";
}

export function aggregateInstallationSync(
  installations: readonly EngineInstallationView[],
): SyncProgressView | null {
  const items = installations
    .map((item) => item.sync)
    .filter((item): item is SyncProgressView => item != null)
    .filter((item) => item.discovered > 0 || item.catalog_complete);
  if (items.length === 0) {
    return null;
  }
  return {
    discovered: items.reduce((sum, item) => sum + item.discovered, 0),
    seeded: items.reduce((sum, item) => sum + item.seeded, 0),
    unseeded: items.reduce((sum, item) => sum + item.unseeded, 0),
    backfilling: items.reduce((sum, item) => sum + item.backfilling, 0),
    media_pending: items.reduce((sum, item) => sum + item.media_pending, 0),
    catalog_complete: items.every((item) => item.catalog_complete),
  };
}
