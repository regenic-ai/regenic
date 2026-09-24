import { t } from "../../shared/i18n.ts";
import type {
  EngineInstallationView,
  SyncProgressView,
  SyncReadinessView,
} from "./types.ts";

export function syncProgressSummary(
  sync?: SyncProgressView | null,
): string {
  if (!sync || sync.discovered === 0) {
    return t("sync.noneFound");
  }
  if (sync.catalog_complete && sync.bootstrap_pending === 0) {
    return t("sync.coverageReady", { count: sync.discovered });
  }
  return t("sync.coverage", {
    discovered: sync.catalog_complete
      ? sync.discovered
      : `${sync.discovered}+`,
    bootstrap_pending: sync.bootstrap_pending,
    steady: sync.steady,
  });
}

export function syncProgressTone(
  sync?: SyncProgressView | null,
): "ok" | "warn" | undefined {
  if (!sync) {
    return undefined;
  }
  if (!sync.catalog_complete || sync.bootstrap_pending > 0) {
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
    bootstrap_pending: items.reduce((sum, item) => sum + item.bootstrap_pending, 0),
    steady: items.reduce((sum, item) => sum + item.steady, 0),
  };
}

export function formatSyncDurationMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 1) {
    return t("sync.dueNow");
  }
  if (seconds < 60) {
    return t("sync.durationSeconds", { count: seconds });
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return t("sync.durationMinutes", { count: minutes });
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return t("sync.durationHours", { count: hours });
  }
  return t("sync.durationDays", { count: Math.round(hours / 24) });
}

export function syncFreshnessSummary(
  readiness?: SyncReadinessView | null,
): string {
  if (!readiness || readiness.freshness_ms == null) {
    return t("sync.freshnessUnknown");
  }
  if (readiness.freshness_ms < 1000) {
    return t("sync.freshnessNow");
  }
  return t("sync.freshnessAgo", {
    when: formatSyncDurationMs(readiness.freshness_ms),
  });
}

export function syncEtaSummary(readiness?: SyncReadinessView | null): string {
  if (readiness?.throttle_reason === "source_429") {
    return t("sync.throttle.source_429");
  }
  if (readiness?.throttle_reason === "throttled") {
    return t("sync.throttle.throttled");
  }
  if (readiness?.throttle_reason === "writer_wait") {
    return t("sync.throttle.writer_wait");
  }
  if (!readiness?.eta) {
    return t("sync.etaUnknown");
  }
  const low = formatSyncDurationMs(readiness.eta.low_ms);
  const high = formatSyncDurationMs(readiness.eta.high_ms);
  if (low === high) {
    return low;
  }
  return t("sync.etaRange", { low, high });
}

export function syncReadinessTone(
  readiness?: SyncReadinessView | null,
): "ok" | "warn" | "risk" | undefined {
  if (readiness?.throttle_reason) {
    return "risk";
  }
  if (readiness?.eta && readiness.remaining_streams > 0) {
    return "warn";
  }
  if (readiness?.freshness_source === "poll") {
    return "ok";
  }
  return undefined;
}
