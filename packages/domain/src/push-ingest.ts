import { randomUUID } from "node:crypto";
import {
  INGEST_SCHEMA_VERSION,
  validatePushIngestBatch,
  type IngestValidationIssue,
  type PushIngestAck,
} from "@regenic/connector-contract";
import type { IngestBatchProcessor } from "./connector-runner";
import {
  ingestAttemptSummary,
  type ConnectorInstallation,
  type IngestBatch,
  type PushWatermarkStore,
} from "./ingestion";
import {
  processSyncMetrics,
  recordPushLag,
  type SyncMetricsSink,
} from "./sync-observability";

export interface PushIngestLimits {
  /** Queued plus in-flight batches one installation may hold before 429. */
  max_pending_per_installation: number;
  max_inflight_per_installation: number;
  /** Queued plus in-flight batches across all installations before 429. */
  max_pending_global: number;
  max_inflight_global: number;
  retry_after_ms: number;
}

export const DEFAULT_PUSH_INGEST_LIMITS: PushIngestLimits = {
  max_pending_per_installation: 8,
  max_inflight_per_installation: 1,
  max_pending_global: 64,
  max_inflight_global: 4,
  retry_after_ms: 1_000,
};

export class PushIngestRejectedError extends Error {
  constructor(
    readonly code: "invalid_envelope" | "invalid_record" | "connector_mismatch",
    readonly issues: IngestValidationIssue[],
  ) {
    super(`Push batch rejected: ${code}`);
    this.name = "PushIngestRejectedError";
  }
}

export class PushIngestBackpressureError extends Error {
  constructor(
    readonly scope: "installation" | "global",
    readonly retry_after_ms: number,
  ) {
    super(`Push ingest queue is full (${scope})`);
    this.name = "PushIngestBackpressureError";
  }
}

export interface PushIngestStats {
  queued: number;
  inflight: number;
  acked_batches: number;
  retryable_records: number;
  backpressure_rejections: number;
  last_ack_at?: string;
  last_ack_latency_ms?: number;
}

export interface PushIngestGateOptions {
  limits?: PushIngestLimits;
  /** When set, a clean ack persists the batch watermark before returning. */
  watermarks?: Pick<PushWatermarkStore, "recordPushWatermark">;
  metrics?: SyncMetricsSink;
  now?: () => number;
}

export interface PushIngestSnapshot {
  installation_id: string;
  queued: number;
  inflight: number;
  acked_batches: number;
  retryable_records: number;
  backpressure_rejections: number;
  last_ack_at?: string;
  last_ack_latency_ms?: number;
  /** Milliseconds since last_ack_at; omitted when never acked. */
  lag_ms?: number;
}

interface Waiter {
  installationId: string;
  grant: () => void;
}

/**
 * Admission and persistence for connector pushes. Each installation gets a
 * bounded queue and an in-flight cap so one noisy connector cannot starve
 * the others; overflow is reported as backpressure, never buffered.
 */
export class PushIngestGate {
  private readonly stats = new Map<string, PushIngestStats>();
  private readonly waiters: Waiter[] = [];
  private inflightGlobal = 0;
  private pendingGlobal = 0;
  private readonly limits: PushIngestLimits;
  private readonly watermarks?: PushIngestGateOptions["watermarks"];
  private readonly metrics: SyncMetricsSink;
  private readonly now: () => number;

  constructor(
    private readonly processor: Pick<IngestBatchProcessor, "ingest">,
    options: PushIngestGateOptions = {},
  ) {
    this.limits = options.limits ?? DEFAULT_PUSH_INGEST_LIMITS;
    this.watermarks = options.watermarks;
    this.metrics = options.metrics ?? processSyncMetrics;
    this.now = options.now ?? (() => Date.now());
  }

  async submit(input: {
    installation: Pick<ConnectorInstallation, "id" | "org_id">;
    /** The only `source` this installation may write. */
    source: string;
    batch: unknown;
  }): Promise<PushIngestAck> {
    const installationId = input.installation.id;
    const stats = this.statsFor(installationId);
    const labels = { installation_id: installationId, operation: "push" as const };
    if (stats.queued + stats.inflight >= this.limits.max_pending_per_installation) {
      stats.backpressure_rejections += 1;
      this.metrics.record({ name: "push_backpressure", value: 1, labels: { ...labels, status: "installation" } });
      throw new PushIngestBackpressureError("installation", this.limits.retry_after_ms);
    }
    if (this.pendingGlobal >= this.limits.max_pending_global) {
      stats.backpressure_rejections += 1;
      this.metrics.record({ name: "push_backpressure", value: 1, labels: { ...labels, status: "global" } });
      throw new PushIngestBackpressureError("global", this.limits.retry_after_ms);
    }

    const validation = validatePushIngestBatch(input.batch);
    if (!validation.success) {
      throw new PushIngestRejectedError(validation.error_code, validation.issues);
    }
    const push = validation.data;
    const foreign = push.events.flatMap((event, index) =>
      event.source === input.source
        ? []
        : [{ path: ["events", index, "source"], message: `source must be ${input.source}` }],
    );
    if (foreign.length > 0) {
      throw new PushIngestRejectedError("connector_mismatch", foreign);
    }

    const startedAt = this.now();
    this.pendingGlobal += 1;
    await this.acquire(installationId);
    try {
      const deliveryId = push.batch_id ?? randomUUID();
      const batch: IngestBatch = {
        schema_version: INGEST_SCHEMA_VERSION,
        connector_id: installationId,
        org_id: input.installation.org_id,
        delivery_id: deliveryId,
        records: push.events,
        received_at: new Date(startedAt).toISOString(),
      };
      const submission = await this.processor.ingest(batch);
      if (!submission.valid) {
        throw new PushIngestRejectedError(submission.error_code, submission.issues);
      }
      const summary = ingestAttemptSummary(submission.records);
      const watermark = summary.retryable_failure_count === 0 ? push.watermark : undefined;
      if (watermark !== undefined && this.watermarks) {
        await this.watermarks.recordPushWatermark({
          installation_id: installationId,
          stream_key: push.stream_key,
          watermark,
          batch_id: deliveryId,
          updated_at: new Date(this.now()).toISOString(),
        });
      }
      const finishedAt = this.now();
      const latencyMs = finishedAt - startedAt;
      stats.acked_batches += 1;
      stats.retryable_records += summary.retryable_failure_count;
      stats.last_ack_at = new Date(finishedAt).toISOString();
      stats.last_ack_latency_ms = latencyMs;
      this.metrics.record({ name: "push_ack_latency_ms", value: Math.max(0, latencyMs), labels });
      this.metrics.record({ name: "push_backlog", value: stats.queued + stats.inflight, labels });
      if (summary.accepted_count > 0) {
        this.metrics.record({ name: "accepted_records", value: summary.accepted_count, labels });
      }
      if (summary.duplicate_count > 0) {
        this.metrics.record({ name: "duplicate_records", value: summary.duplicate_count, labels });
      }
      if (summary.quarantined_count > 0) {
        this.metrics.record({ name: "quarantined_records", value: summary.quarantined_count, labels });
      }
      if (summary.retryable_failure_count > 0) {
        this.metrics.record({ name: "retryable_failures", value: summary.retryable_failure_count, labels });
      }
      return {
        installation_id: installationId,
        stream_key: push.stream_key,
        batch_id: deliveryId,
        accepted_count: summary.accepted_count,
        duplicate_count: summary.duplicate_count,
        quarantined_count: summary.quarantined_count,
        retryable_count: summary.retryable_failure_count,
        records: submission.records,
        ...(watermark !== undefined ? { watermark } : {}),
      };
    } finally {
      this.release(installationId);
    }
  }

  /** True while any push is queued or persisting. Reconcile stays off this path. */
  busy(): boolean {
    return this.pendingGlobal > 0;
  }

  /**
   * True when another batch would wait or be rejected.
   * History yields the whole plane only then, so one in-flight ack does not
   * freeze every install's backfill.
   */
  pressured(): boolean {
    return this.waiters.length > 0
      || this.inflightGlobal >= this.limits.max_inflight_global
      || this.pendingGlobal >= this.limits.max_pending_global;
  }

  /** True while this installation has a push queued or persisting. */
  installationBusy(installationId: string): boolean {
    const stats = this.stats.get(installationId);
    return Boolean(stats && (stats.queued > 0 || stats.inflight > 0));
  }

  snapshot(installationId: string, nowMs = this.now()): PushIngestSnapshot {
    const stats = this.statsFor(installationId);
    return toSnapshot(installationId, stats, nowMs);
  }

  /** Installations that have received at least one push this process. */
  snapshotAll(nowMs = this.now()): PushIngestSnapshot[] {
    return [...this.stats.entries()]
      .map(([installationId, stats]) => toSnapshot(installationId, stats, nowMs))
      .sort((left, right) => left.installation_id.localeCompare(right.installation_id));
  }

  /**
   * Samples backlog and lag for every known installation into the metrics sink.
   * Call from the low-frequency reconcile tick so gauges stay fresh without
   * recording on every poll tick.
   */
  sampleObservability(nowMs = this.now()): void {
    for (const row of this.snapshotAll(nowMs)) {
      const labels = { installation_id: row.installation_id, operation: "push" };
      this.metrics.record({
        name: "push_backlog",
        value: row.queued + row.inflight,
        labels,
      });
      recordPushLag(this.metrics, row.last_ack_at, labels, nowMs);
    }
  }

  forget(installationId: string): void {
    const stats = this.stats.get(installationId);
    if (stats && stats.queued === 0 && stats.inflight === 0) {
      this.stats.delete(installationId);
    }
  }

  private acquire(installationId: string): Promise<void> {
    if (this.canRun(installationId) && !this.waiters.some((w) => w.installationId === installationId)) {
      this.start(installationId);
      return Promise.resolve();
    }
    this.statsFor(installationId).queued += 1;
    return new Promise((resolve) => {
      this.waiters.push({ installationId, grant: resolve });
    });
  }

  private release(installationId: string): void {
    const stats = this.statsFor(installationId);
    stats.inflight -= 1;
    this.inflightGlobal -= 1;
    this.pendingGlobal -= 1;
    this.pump();
  }

  /** FIFO, skipping installations already at their in-flight cap. */
  private pump(): void {
    for (let index = 0; index < this.waiters.length;) {
      if (this.inflightGlobal >= this.limits.max_inflight_global) {
        return;
      }
      const waiter = this.waiters[index];
      if (waiter && this.canRun(waiter.installationId)) {
        this.waiters.splice(index, 1);
        this.statsFor(waiter.installationId).queued -= 1;
        this.start(waiter.installationId);
        waiter.grant();
        continue;
      }
      index += 1;
    }
  }

  private canRun(installationId: string): boolean {
    return this.inflightGlobal < this.limits.max_inflight_global &&
      this.statsFor(installationId).inflight < this.limits.max_inflight_per_installation;
  }

  private start(installationId: string): void {
    this.statsFor(installationId).inflight += 1;
    this.inflightGlobal += 1;
  }

  private statsFor(installationId: string): PushIngestStats {
    let stats = this.stats.get(installationId);
    if (!stats) {
      stats = {
        queued: 0,
        inflight: 0,
        acked_batches: 0,
        retryable_records: 0,
        backpressure_rejections: 0,
      };
      this.stats.set(installationId, stats);
    }
    return stats;
  }
}

function toSnapshot(
  installationId: string,
  stats: PushIngestStats,
  nowMs: number,
): PushIngestSnapshot {
  const ackMs = stats.last_ack_at ? Date.parse(stats.last_ack_at) : Number.NaN;
  return {
    installation_id: installationId,
    queued: stats.queued,
    inflight: stats.inflight,
    acked_batches: stats.acked_batches,
    retryable_records: stats.retryable_records,
    backpressure_rejections: stats.backpressure_rejections,
    ...(stats.last_ack_at ? { last_ack_at: stats.last_ack_at } : {}),
    ...(stats.last_ack_latency_ms !== undefined
      ? { last_ack_latency_ms: stats.last_ack_latency_ms }
      : {}),
    ...(Number.isFinite(ackMs) ? { lag_ms: Math.max(0, nowMs - ackMs) } : {}),
  };
}
