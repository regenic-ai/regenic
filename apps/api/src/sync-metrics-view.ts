import {
  estimateSyncReadiness,
  processSyncMetrics,
  type SyncProgressView,
  type SyncReadinessView,
} from "@regenic/domain";
import { processMemoryView, sqliteWalBytes } from "./process-memory";

export interface SyncMetricsView {
  generated_at: string;
  memory: { rss_bytes: number; heap_used_bytes: number };
  wal_bytes: number | null;
  metrics: ReturnType<typeof processSyncMetrics.snapshot>;
  readiness: SyncReadinessView;
}

export function syncMetricsView(
  progress?: SyncProgressView | null,
): SyncMetricsView {
  const metrics = processSyncMetrics.snapshot();
  return {
    generated_at: new Date().toISOString(),
    memory: processMemoryView(),
    wal_bytes: sqliteWalBytes(),
    metrics,
    readiness: estimateSyncReadiness({ metrics, progress }),
  };
}

export function currentSyncReadiness(
  progress?: SyncProgressView | null,
): SyncReadinessView {
  return estimateSyncReadiness({
    metrics: processSyncMetrics.snapshot(),
    progress,
  });
}
