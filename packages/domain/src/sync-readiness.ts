import { WRITE_WAIT_PRESSURE_MS } from "./sync-claim-limit";
import { UNSEEN_SEED_PER_TICK } from "./sync-contracts";
import {
  coldIdleMsForCatalogSize,
  DEFAULT_HOT_STREAM_IDLE_MS,
} from "./sync-idle";
import type { SyncMetricAggregate, SyncMetricName } from "./sync-observability";
import type { SyncProgressView } from "./sync-progress";

/** Default Personal live tick. Used only as the optimistic ETA cadence. */
export const DEFAULT_SYNC_TICK_MS = 10_000;

export type SyncThrottleReason = "source_429" | "throttled" | "writer_wait";
export type SyncFreshnessSource = "poll" | "none";

export interface SyncEtaRange {
  low_ms: number;
  high_ms: number;
}

export interface SyncReadinessView {
  remaining_streams: number;
  freshness_ms: number | null;
  freshness_source: SyncFreshnessSource;
  accepted_count: number;
  throttle_reason: SyncThrottleReason | null;
  eta: SyncEtaRange | null;
}

export const SYNC_SOAK_METRIC_NAMES = [
  "work_queue_lag_ms",
  "freshness_ms",
  "source_poll_ms",
  "accepted_records",
  "database_transaction_ms",
  "writer_wait_ms",
  "lease_conflicts",
  "throttled",
  "source_429",
  "retryable_failures",
  "api_latency_ms",
  "wal_bytes",
] as const satisfies readonly SyncMetricName[];

export type SyncSoakMetricName = (typeof SYNC_SOAK_METRIC_NAMES)[number];

export interface SyncSoakReport {
  generated_at: string;
  plan_ms: number;
  claim_ms: number;
  planned: number;
  due_now: number;
  claimed: number;
  readiness: SyncReadinessView;
  metrics: Record<SyncSoakMetricName, number>;
  memory: { rss_bytes: number; heap_used_bytes: number };
  wal_bytes: number | null;
}

export function remainingSyncStreams(
  progress?: Pick<
    SyncProgressView,
    "unseeded" | "backfilling" | "media_pending"
  > | null,
): number {
  if (!progress) {
    return 0;
  }
  return (
    Math.max(0, progress.unseeded) +
    Math.max(0, progress.backfilling) +
    Math.max(0, progress.media_pending)
  );
}

/**
 * Schedule ETA from remaining streams and claim cadence. Message totals stay
 * unknown — this never yields a percentage of records.
 */
export function estimateSyncEta(input: {
  remaining_streams: number;
  first_seed_per_tick?: number;
  tick_ms?: number;
  hot_idle_ms?: number;
  cold_idle_ms?: number;
}): SyncEtaRange | null {
  const remaining = Math.max(0, Math.floor(input.remaining_streams));
  if (remaining === 0) {
    return null;
  }
  const claim = Math.max(1, Math.floor(input.first_seed_per_tick ?? UNSEEN_SEED_PER_TICK));
  const tickMs = Math.max(1, Math.floor(input.tick_ms ?? DEFAULT_SYNC_TICK_MS));
  const hotMs = Math.max(1, Math.floor(input.hot_idle_ms ?? DEFAULT_HOT_STREAM_IDLE_MS));
  const coldMs = Math.max(
    1,
    Math.floor(input.cold_idle_ms ?? coldIdleMsForCatalogSize(remaining)),
  );
  const ticks = Math.ceil(remaining / claim);
  const lowMs = Math.max(0, (ticks - 1) * tickMs);
  const highMs =
    remaining <= claim
      ? Math.max(lowMs, hotMs)
      : Math.max(lowMs, coldMs, (ticks - 1) * hotMs);
  return { low_ms: lowMs, high_ms: highMs };
}

export function estimateSyncReadiness(input: {
  progress?: SyncProgressView | null;
  metrics?: readonly SyncMetricAggregate[];
  first_seed_per_tick?: number;
  tick_ms?: number;
  hot_idle_ms?: number;
  cold_idle_ms?: number;
  writer_wait_pressure_ms?: number;
}): SyncReadinessView {
  const metrics = input.metrics ?? [];
  const remaining = remainingSyncStreams(input.progress);
  const freshness = selectFreshnessMs(metrics);
  return {
    remaining_streams: remaining,
    freshness_ms: freshness,
    freshness_source: freshness == null ? "none" : "poll",
    accepted_count: sumMetric(metrics, "accepted_records"),
    throttle_reason: selectThrottleReason(
      metrics,
      input.writer_wait_pressure_ms ?? WRITE_WAIT_PRESSURE_MS,
    ),
    eta: estimateSyncEta({
      remaining_streams: remaining,
      first_seed_per_tick: input.first_seed_per_tick,
      tick_ms: input.tick_ms,
      hot_idle_ms: input.hot_idle_ms,
      cold_idle_ms: input.cold_idle_ms,
    }),
  };
}

export function buildSyncSoakReport(input: {
  plan_ms: number;
  claim_ms: number;
  planned: number;
  due_now: number;
  claimed: number;
  metrics: readonly SyncMetricAggregate[];
  progress?: SyncProgressView | null;
  memory?: { rss_bytes: number; heap_used_bytes: number };
  wal_bytes?: number | null;
  now?: () => string;
}): SyncSoakReport {
  const usage = input.memory ?? { rss_bytes: 0, heap_used_bytes: 0 };
  return {
    generated_at: (input.now ?? (() => new Date().toISOString()))(),
    plan_ms: input.plan_ms,
    claim_ms: input.claim_ms,
    planned: input.planned,
    due_now: input.due_now,
    claimed: input.claimed,
    readiness: estimateSyncReadiness({
      progress: input.progress,
      metrics: input.metrics,
    }),
    metrics: soakMetricLastValues(input.metrics),
    memory: {
      rss_bytes: usage.rss_bytes,
      heap_used_bytes: usage.heap_used_bytes,
    },
    wal_bytes: input.wal_bytes ?? null,
  };
}

function soakMetricLastValues(
  metrics: readonly SyncMetricAggregate[],
): Record<SyncSoakMetricName, number> {
  const report = {} as Record<SyncSoakMetricName, number>;
  for (const name of SYNC_SOAK_METRIC_NAMES) {
    const last = lastMetric(metrics, name);
    report[name] = last == null ? 0 : last;
  }
  return report;
}

function selectFreshnessMs(metrics: readonly SyncMetricAggregate[]): number | null {
  const samples = metrics.filter((item) => item.name === "freshness_ms");
  if (samples.length === 0) {
    return null;
  }
  const hot = samples.filter(
    (item) =>
      item.labels.status === "hot" ||
      item.labels.status === "interactive" ||
      item.labels.lane === "interactive",
  );
  const chosen = hot.length > 0 ? hot : samples;
  return Math.min(...chosen.map((item) => item.last));
}

function selectThrottleReason(
  metrics: readonly SyncMetricAggregate[],
  writerWaitPressureMs: number,
): SyncThrottleReason | null {
  if (sumMetric(metrics, "source_429") > 0) {
    return "source_429";
  }
  if (sumMetric(metrics, "throttled") > 0) {
    return "throttled";
  }
  const writerWait = lastMetric(metrics, "writer_wait_ms");
  if (writerWait != null && writerWait >= writerWaitPressureMs) {
    return "writer_wait";
  }
  return null;
}

function lastMetric(
  metrics: readonly SyncMetricAggregate[],
  name: SyncMetricName,
): number | null {
  let found: number | null = null;
  for (const item of metrics) {
    if (item.name !== name) {
      continue;
    }
    found = item.last;
  }
  return found;
}

function sumMetric(
  metrics: readonly SyncMetricAggregate[],
  name: SyncMetricName,
): number {
  let total = 0;
  for (const item of metrics) {
    if (item.name === name) {
      total += item.sum;
    }
  }
  return total;
}
