export type SyncMetricName =
  | "lease_wait_ms"
  | "source_poll_ms"
  | "ingest_ms"
  | "settle_ms"
  | "work_queue_lag_ms"
  | "freshness_ms"
  | "api_latency_ms"
  | "writer_wait_ms"
  | "database_transaction_ms"
  | "wal_bytes"
  | "accepted_records"
  | "duplicate_records"
  | "quarantined_records"
  | "retryable_failures"
  | "lease_conflicts"
  | "throttled"
  | "source_429";

export interface SyncMetricLabels {
  installation_id?: string;
  stream_key?: string;
  source?: string;
  lane?: string;
  operation?: string;
  status?: string;
}

export interface SyncMetricPoint {
  name: SyncMetricName;
  value: number;
  labels?: SyncMetricLabels;
  recorded_at?: string;
}

export interface SyncMetricAggregate {
  name: SyncMetricName;
  labels: SyncMetricLabels;
  count: number;
  sum: number;
  max: number;
  last: number;
  recorded_at: string;
}

export interface SyncMetricsSink {
  record(point: SyncMetricPoint): void;
}

export class SyncMetricsRegistry implements SyncMetricsSink {
  private readonly aggregates = new Map<string, SyncMetricAggregate>();

  record(point: SyncMetricPoint): void {
    if (!Number.isFinite(point.value)) {
      return;
    }
    const labels = stableLabels(point.labels);
    const key = JSON.stringify([point.name, labels]);
    const recordedAt = point.recorded_at ?? new Date().toISOString();
    const current = this.aggregates.get(key);
    if (!current) {
      this.aggregates.set(key, {
        name: point.name,
        labels,
        count: 1,
        sum: point.value,
        max: point.value,
        last: point.value,
        recorded_at: recordedAt,
      });
      return;
    }
    current.count += 1;
    current.sum += point.value;
    current.max = Math.max(current.max, point.value);
    current.last = point.value;
    current.recorded_at = recordedAt;
  }

  snapshot(): SyncMetricAggregate[] {
    return [...this.aggregates.values()]
      .map((aggregate) => ({
        ...aggregate,
        labels: { ...aggregate.labels },
      }))
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels)),
      );
  }

  clear(): void {
    this.aggregates.clear();
  }
}

/** Samples added between two snapshots. One RPC records each metric once. */
export function syncMetricDeltas(
  before: readonly SyncMetricAggregate[],
  after: readonly SyncMetricAggregate[],
): SyncMetricPoint[] {
  const previous = new Map(before.map((row) => [metricKey(row), row]));
  const points: SyncMetricPoint[] = [];
  for (const row of after) {
    const prior = previous.get(metricKey(row));
    const added = row.count - (prior?.count ?? 0);
    if (added <= 0) {
      continue;
    }
    points.push({
      name: row.name,
      value: row.last,
      labels: { ...row.labels },
      recorded_at: row.recorded_at,
    });
  }
  return points;
}

function metricKey(row: Pick<SyncMetricAggregate, "name" | "labels">): string {
  return JSON.stringify([row.name, row.labels]);
}

export const processSyncMetrics = new SyncMetricsRegistry();

export function recordSyncDuration(
  sink: SyncMetricsSink,
  name: Extract<
    SyncMetricName,
    | "lease_wait_ms"
    | "source_poll_ms"
    | "ingest_ms"
    | "settle_ms"
    | "work_queue_lag_ms"
    | "api_latency_ms"
    | "writer_wait_ms"
    | "database_transaction_ms"
  >,
  startedAtMs: number,
  labels?: SyncMetricLabels,
): void {
  sink.record({
    name,
    value: Math.max(0, Date.now() - startedAtMs),
    labels,
  });
}

/** Queue wait from the durable due time until a worker claimed the row. */
export function recordWorkQueueLag(
  sink: SyncMetricsSink,
  nextDueAt: string,
  labels?: SyncMetricLabels,
  nowMs = Date.now(),
): void {
  const dueMs = Date.parse(nextDueAt);
  sink.record({
    name: "work_queue_lag_ms",
    value: Math.max(0, Number.isFinite(dueMs) ? nowMs - dueMs : 0),
    labels,
  });
}

/** Effective poll interval. Callers must omit `stream_key` so cardinality stays bounded. */
export function recordPollFreshness(
  sink: SyncMetricsSink,
  idleMs: number,
  labels?: Omit<SyncMetricLabels, "stream_key">,
): void {
  sink.record({
    name: "freshness_ms",
    value: Math.max(0, idleMs),
    labels,
  });
}

function stableLabels(labels?: SyncMetricLabels): SyncMetricLabels {
  if (!labels) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(labels)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .sort(([left], [right]) => left.localeCompare(right)),
  ) as SyncMetricLabels;
}
