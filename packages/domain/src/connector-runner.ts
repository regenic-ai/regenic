import { randomUUID } from "node:crypto";
import type { SyncPollHint } from "./sync-contracts";
import type {
  ChannelConnector,
  ConnectorPollOptions,
  ConnectorQuotaHint,
  ConnectorLease,
  ConnectorRuntimeStore,
  IngestBatch,
  IngestBatchResult,
  IngestRecordResult,
  NewIngestAttempt,
  SyncPageCommit,
  WebhookRequest,
} from "./ingestion";
import {
  assertAttemptInstallationBinding,
  IngestPageProcessingError,
  ingestAttemptQuarantines,
  ingestAttemptSummary,
} from "./ingestion";
import type { IngestSubmissionResult } from "./ingestion-service";
import { withDeadline } from "./deadline";
import {
  connectorAcceptsWebhook,
  connectorPolls,
  connectorSourceMode,
} from "./source-mode";
import type { InstallationQuotaBook } from "./quota";
import {
  asConnectorRuntimeInvoker,
  type ConnectorRuntimeInvoker,
} from "./connector-invoker";
import { currentSyncLane } from "./sync-budget";
import {
  processSyncMetrics,
  recordSyncDuration,
  type SyncMetricLabels,
  type SyncMetricsSink,
} from "./sync-observability";

export interface IngestBatchProcessor {
  ingest(
    input: unknown,
    page?: SyncPageCommit,
    pageRuntimeStore?: ConnectorRuntimeStore,
  ): Promise<IngestSubmissionResult>;
}

export interface RunConnectorPollInput {
  installation_id: string;
  stream_key: string;
  lease_owner: string;
  lease_duration_ms: number;
  older?: boolean;
  latest?: boolean;
  media?: boolean;
  before?: string;
  before_external_id?: string;
  /** Last acked push watermark. Opaque; forwarded only, never parsed. */
  push_watermark?: string;
  timeout_ms?: number;
  /**
   * Opaque cursor for this call. When omitted, the lease cursor is used.
   * Regenic does not interpret the value.
   */
  cursor?: string;
  /** Scroll ingests the page and leaves the lease cursor where it was. */
  commit_cursor?: boolean;
}

export type ConnectorPollRunResult =
  | {
      status: "lease_unavailable" | "throttled" | "unsupported_mode";
      installation_id: string;
      stream_key: string;
    }
  | {
      status: "completed" | "retryable_failure";
      installation_id: string;
      stream_key: string;
      attempt_id: string;
      result: IngestBatchResult;
      next_cursor?: string;
      has_more?: boolean;
      media_pending?: boolean;
      poll_hint?: SyncPollHint;
    };

export interface RunConnectorWebhookInput {
  installation_id: string;
  request: WebhookRequest;
  timeout_ms?: number;
}

export type ConnectorWebhookRunResult =
  | {
      status: "throttled" | "unsupported_mode";
      installation_id: string;
    }
  | {
      status: "completed" | "retryable_failure";
      installation_id: string;
      result: IngestBatchResult;
      /** Threads that should skip steady idle on the next poll tick. */
      wake_thread_ids?: string[];
    };

export type RunnerConnector = Pick<
  ChannelConnector,
  "source" | "source_mode" | "quota" | "limits" | "poll" | "verifyWebhook" | "handleWebhook"
>;

export type RunnerQuota = Pick<InstallationQuotaBook, "tryConsume"> &
  Partial<Pick<InstallationQuotaBook, "declare" | "tryAcquireSlot" | "pageSize">>;

export class ConnectorRunner {
  private readonly connector: ConnectorRuntimeInvoker;

  constructor(
    connector: RunnerConnector | ConnectorRuntimeInvoker,
    private readonly processor: IngestBatchProcessor,
    private readonly runtimeStore: ConnectorRuntimeStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly quota?: RunnerQuota,
    private readonly metrics: SyncMetricsSink = processSyncMetrics,
  ) {
    this.connector = asConnectorRuntimeInvoker(connector);
  }

  async poll(input: RunConnectorPollInput): Promise<ConnectorPollRunResult> {
    const poll = this.connector.poll?.bind(this.connector);
    if (!connectorPolls(connectorSourceMode(this.connector)) || !poll) {
      return {
        status: "unsupported_mode",
        installation_id: input.installation_id,
        stream_key: input.stream_key,
      };
    }
    const startedAt = this.now();
    const leaseOwner = `${input.lease_owner}:${randomUUID()}`;
    const labels = this.metricLabels(input);
    const leaseStartedAt = Date.now();
    const lease = await this.runtimeStore.acquireLease({
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      lease_owner: leaseOwner,
      now: startedAt,
      lease_duration_ms: input.lease_duration_ms,
      preempt: currentSyncLane() === "interactive",
    });
    recordSyncDuration(this.metrics, "lease_wait_ms", leaseStartedAt, labels);
    if (!lease) {
      this.metrics.record({ name: "lease_conflicts", value: 1, labels });
      return {
        status: "lease_unavailable",
        installation_id: input.installation_id,
        stream_key: input.stream_key,
      };
    }
    this.quota?.declare?.(input.installation_id, this.connector.limits);
    const releaseSlot = this.takeSlot(input.installation_id);
    if (!releaseSlot || !this.takeQuota(input.installation_id, this.connector.quota)) {
      releaseSlot?.();
      await this.runtimeStore.releaseLease({
        installation_id: input.installation_id,
        stream_key: input.stream_key,
        lease_owner: leaseOwner,
        claim_token: lease.claim_token,
        now: this.now(),
      });
      this.metrics.record({ name: "throttled", value: 1, labels });
      return {
        status: "throttled",
        installation_id: input.installation_id,
        stream_key: input.stream_key,
      };
    }
    try {
      return await this.pollLeased(input, poll, lease, leaseOwner, startedAt, labels);
    } finally {
      releaseSlot();
    }
  }

  private async pollLeased(
    input: RunConnectorPollInput,
    poll: NonNullable<ConnectorRuntimeInvoker["poll"]>,
    lease: ConnectorLease,
    leaseOwner: string,
    startedAt: string,
    labels: SyncMetricLabels,
  ): Promise<ConnectorPollRunResult> {
    const heartbeat = this.startLeaseHeartbeat(input, leaseOwner, lease);
    const expireLease = async (now: string): Promise<ConnectorPollRunResult> => {
      await heartbeat.stop();
      await this.runtimeStore.releaseLease({
        installation_id: input.installation_id,
        stream_key: input.stream_key,
        lease_owner: leaseOwner,
        claim_token: lease.claim_token,
        now,
      });
      this.metrics.record({ name: "lease_conflicts", value: 1, labels });
      return {
        status: "lease_unavailable",
        installation_id: input.installation_id,
        stream_key: input.stream_key,
      };
    };

    let pollResult;
    const pollStartedAt = Date.now();
    const timeoutMs = input.timeout_ms ?? 0;
    const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const signal = timeoutSignal
      ? AbortSignal.any([timeoutSignal, heartbeat.signal])
      : heartbeat.signal;
    const commitCursor = input.commit_cursor !== false;
    const pollCursor =
      input.cursor !== undefined
        ? input.cursor
          ? { value: input.cursor }
          : null
        : lease.cursor
          ? { value: lease.cursor }
          : null;
    try {
      const pollOperation = withDeadline(
        poll(pollCursor, pollOptions(input, signal, this.quota?.pageSize?.(input.installation_id))),
        timeoutMs,
        `poll ${input.installation_id}:${input.stream_key}`,
      ).then(
        (result) => ({ kind: "result" as const, result }),
        (error: unknown) => ({ kind: "error" as const, error }),
      );
      const outcome = await Promise.race([
        pollOperation,
        heartbeat.lostPromise.then(() => ({ kind: "lease_lost" as const })),
      ]);
      if (outcome.kind === "lease_lost") {
        return expireLease(this.now());
      }
      if (outcome.kind === "error") throw outcome.error;
      pollResult = outcome.result;
    } catch (error) {
      await heartbeat.stop();
      await this.runtimeStore.releaseLease({
        installation_id: input.installation_id,
        stream_key: input.stream_key,
        lease_owner: leaseOwner,
        claim_token: lease.claim_token,
        now: this.now(),
      });
      if (heartbeat.lost) {
        this.metrics.record({ name: "lease_conflicts", value: 1, labels });
        return {
          status: "lease_unavailable",
          installation_id: input.installation_id,
          stream_key: input.stream_key,
        };
      }
      if (isRateLimitError(error)) {
        this.metrics.record({ name: "source_429", value: 1, labels });
      }
      throw error;
    } finally {
      recordSyncDuration(
        this.metrics,
        "source_poll_ms",
        pollStartedAt,
        labels,
      );
    }
    const afterPoll = this.now();
    if (heartbeat.lost || leaseHasExpired(afterPoll, heartbeat.lease_expires_at)) {
      return expireLease(afterPoll);
    }
    const attempt: NewIngestAttempt = {
      id: randomUUID(),
      org_id: pollResult.batch.org_id,
      connector_installation_id: input.installation_id,
      stream_key: input.stream_key,
      delivery_id: pollResult.batch.delivery_id,
      started_at: startedAt,
    };
    try {
      assertAttemptInstallationBinding(
        attempt,
        await this.runtimeStore.findInstallation(input.installation_id),
      );
    } catch (error) {
      await heartbeat.stop();
      await this.runtimeStore.releaseLease({
        installation_id: input.installation_id,
        stream_key: input.stream_key,
        lease_owner: leaseOwner,
        claim_token: lease.claim_token,
        now: this.now(),
      });
      if (heartbeat.lost) {
        this.metrics.record({ name: "lease_conflicts", value: 1, labels });
        return {
          status: "lease_unavailable",
          installation_id: input.installation_id,
          stream_key: input.stream_key,
        };
      }
      throw error;
    }
    const afterInstallationLookup = this.now();
    if (heartbeat.lost || leaseHasExpired(afterInstallationLookup, heartbeat.lease_expires_at)) {
      return expireLease(afterInstallationLookup);
    }
    const settleBase = {
      attempt_id: attempt.id,
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      lease_owner: leaseOwner,
      claim_token: lease.claim_token,
    };

    const returnedCursor =
      pollResult.next_cursor ?? pollResult.batch.next_cursor;
    const storedCursor = commitCursor ? returnedCursor : undefined;
    if (pollResult.batch.records.length === 0) {
      if (!(await heartbeat.renewBeforeCommit())) {
        return expireLease(this.now());
      }
      const settleStartedAt = Date.now();
      try {
        await this.commitPage({
          attempt,
          settle: {
            ...settleBase,
            finished_at: this.now(),
            accepted_count: 0,
            duplicate_count: 0,
            quarantined_count: 0,
            retryable_failure_count: 0,
            next_cursor: storedCursor,
            quarantines: [],
          },
        });
      } catch (error) {
        if (!isLostLease(error)) throw error;
        this.metrics.record({ name: "lease_conflicts", value: 1, labels });
        return {
          status: "lease_unavailable",
          installation_id: input.installation_id,
          stream_key: input.stream_key,
        };
      }
      recordSyncDuration(this.metrics, "settle_ms", settleStartedAt, labels);
      return {
        status: "completed",
        installation_id: input.installation_id,
        stream_key: input.stream_key,
        attempt_id: attempt.id,
        result: {
          connector_id: pollResult.batch.connector_id,
          delivery_id: pollResult.batch.delivery_id,
          records: [],
        },
        next_cursor: returnedCursor,
        has_more: pollResult.has_more,
        media_pending: pollResult.media_pending,
        poll_hint: pollResult.poll_hint,
      };
    }

    let result: IngestBatchResult;
    const ingestStartedAt = Date.now();
    try {
      const finishedAt = this.now();
      const page: SyncPageCommit = {
        attempt,
        settle: {
          ...settleBase,
          finished_at: finishedAt,
          next_cursor: storedCursor,
        },
      };
      const submission = await this.processor.ingest(pollResult.batch, page, this.runtimeStore);
      result = this.requireValidResult(submission);
      if (submission.valid && submission.page_committed) {
        await heartbeat.stop();
      }
      if (submission.valid && !submission.page_committed) {
        if (!(await heartbeat.renewBeforeCommit())) {
          return expireLease(this.now());
        }
        const settleStartedAt = Date.now();
        await this.commitPage({
          attempt,
          settle: this.settleFromResult(settleBase, result.records, page.settle),
        });
        recordSyncDuration(this.metrics, "settle_ms", settleStartedAt, labels);
      }
    } catch (error) {
      if (isLostLease(error)) {
        await heartbeat.stop();
        this.metrics.record({ name: "lease_conflicts", value: 1, labels });
        return {
          status: "lease_unavailable",
          installation_id: input.installation_id,
          stream_key: input.stream_key,
        };
      }
      const partialRecords =
        error instanceof IngestPageProcessingError ? error.partial_records : [];
      const partialSummary = ingestAttemptSummary(partialRecords);
      const reportedError =
        error instanceof IngestPageProcessingError ? error.original_error : error;
      const failedAt = this.now();
      if (!(await heartbeat.renewBeforeCommit())) {
        await this.runtimeStore.releaseLease({
          installation_id: input.installation_id,
          stream_key: input.stream_key,
          lease_owner: leaseOwner,
          claim_token: lease.claim_token,
          now: failedAt,
        });
        this.metrics.record({ name: "lease_conflicts", value: 1, labels });
        return {
          status: "lease_unavailable",
          installation_id: input.installation_id,
          stream_key: input.stream_key,
        };
      }
      try {
        await this.commitPage({
          attempt,
          settle: {
            ...settleBase,
            finished_at: failedAt,
            ...partialSummary,
            retryable_failure_count: partialSummary.retryable_failure_count + 1,
            error_code: "internal_error",
            quarantines: ingestAttemptQuarantines(
              partialRecords,
              failedAt,
              () => randomUUID(),
            ),
          },
        });
      } catch (settlementError) {
        await heartbeat.stop();
        await this.runtimeStore.releaseLease({
          installation_id: input.installation_id,
          stream_key: input.stream_key,
          lease_owner: leaseOwner,
          claim_token: lease.claim_token,
          now: this.now(),
        });
        if (isLostLease(settlementError)) {
          this.metrics.record({ name: "lease_conflicts", value: 1, labels });
          return {
            status: "lease_unavailable",
            installation_id: input.installation_id,
            stream_key: input.stream_key,
          };
        }
      }
      throw reportedError;
    } finally {
      recordSyncDuration(this.metrics, "ingest_ms", ingestStartedAt, labels);
    }
    const summary = ingestAttemptSummary(result.records);
    this.recordSummary(summary, labels);

    return {
      status:
        summary.retryable_failure_count === 0
          ? "completed"
          : "retryable_failure",
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      attempt_id: attempt.id,
      result,
      next_cursor: returnedCursor,
      has_more: pollResult.has_more,
      media_pending: pollResult.media_pending,
      poll_hint: pollResult.poll_hint,
    };
  }

  async webhook(
    input: RunConnectorWebhookInput,
  ): Promise<ConnectorWebhookRunResult> {
    const verify = this.connector.verifyWebhook?.bind(this.connector);
    const handle = this.connector.handleWebhook?.bind(this.connector);
    if (
      !connectorAcceptsWebhook(connectorSourceMode(this.connector)) ||
      !verify ||
      !handle
    ) {
      return {
        status: "unsupported_mode",
        installation_id: input.installation_id,
      };
    }
    if (!this.takeQuota(input.installation_id, this.connector.quota)) {
      return {
        status: "throttled",
        installation_id: input.installation_id,
      };
    }

    const batch = await withDeadline(
      (async () => {
        const verified = await verify(input.request);
        return handle(verified);
      })(),
      input.timeout_ms ?? 0,
      `webhook ${input.installation_id}`,
    );

    if (batch.records.length === 0) {
      return {
        status: "completed",
        installation_id: input.installation_id,
        result: {
          connector_id: batch.connector_id,
          delivery_id: batch.delivery_id,
          records: [],
        },
      };
    }

    const result = this.requireValidResult(await this.processor.ingest(batch));
    const summary = ingestAttemptSummary(result.records);
    const wakeThreadIds = webhookWakeThreadIds(batch);
    return {
      status:
        summary.retryable_failure_count === 0
          ? "completed"
          : "retryable_failure",
      installation_id: input.installation_id,
      result,
      wake_thread_ids: wakeThreadIds.length > 0 ? wakeThreadIds : undefined,
    };
  }

  private async commitPage(
    input: Parameters<ConnectorRuntimeStore["commitSyncPage"]>[0],
  ): Promise<void> {
    await this.runtimeStore.commitSyncPage(input);
  }

  private settleFromResult(
    base: {
      attempt_id: string;
      installation_id: string;
      stream_key: string;
      lease_owner: string;
      claim_token: string;
    },
    records: IngestRecordResult[],
    settle: SyncPageCommit["settle"],
  ): Parameters<ConnectorRuntimeStore["commitSyncPage"]>[0]["settle"] {
    const now = settle.finished_at;
    return {
      ...base,
      finished_at: now,
      ...ingestAttemptSummary(records),
      next_cursor: settle.next_cursor,
      quarantines: ingestAttemptQuarantines(records, now, () => randomUUID()),
    };
  }

  private takeQuota(
    installationId: string,
    quota?: ConnectorQuotaHint,
  ): boolean {
    return this.quota?.tryConsume(installationId, quota) ?? true;
  }

  private takeSlot(installationId: string): (() => void) | undefined {
    return this.quota?.tryAcquireSlot
      ? this.quota.tryAcquireSlot(installationId)
      : () => {};
  }

  private startLeaseHeartbeat(
    input: RunConnectorPollInput,
    leaseOwner: string,
    lease: ConnectorLease,
  ): {
    signal: AbortSignal;
    lostPromise: Promise<void>;
    readonly lost: boolean;
    readonly lease_expires_at: string;
    renewBeforeCommit(): Promise<boolean>;
    stop(): Promise<void>;
  } {
    const controller = new AbortController();
    let resolveLost!: () => void;
    const lostPromise = new Promise<void>((resolve) => {
      resolveLost = resolve;
    });
    let stopped = false;
    let lost = false;
    let pending: Promise<void> | undefined;
    let leaseExpiresAt = lease.lease_expires_at;
    const labels = this.metricLabels(input);
    const loseLease = () => {
      if (lost) return;
      lost = true;
      resolveLost();
      controller.abort();
    };
    const renew = (force = false): Promise<void> => {
      if (lost || (stopped && !force)) return Promise.resolve();
      if (pending) return pending;
      pending = this.runtimeStore.renewLease({
        installation_id: input.installation_id,
        stream_key: input.stream_key,
        lease_owner: leaseOwner,
        claim_token: lease.claim_token,
        now: this.now(),
        lease_duration_ms: input.lease_duration_ms,
      }).then((renewed) => {
        if (!renewed) {
          loseLease();
        } else {
          leaseExpiresAt = renewed.lease_expires_at;
        }
      }, () => {
        this.metrics.record({
          name: "lease_renewal_errors",
          value: 1,
          labels: { ...labels, status: "storage_error" },
        });
        loseLease();
      }).finally(() => {
        pending = undefined;
      });
      return pending;
    };
    const interval = setInterval(
      () => { void renew(); },
      Math.max(1, Math.floor(input.lease_duration_ms / 3)),
    );
    interval.unref?.();

    return {
      signal: controller.signal,
      lostPromise,
      get lost() { return lost; },
      get lease_expires_at() { return leaseExpiresAt; },
      async renewBeforeCommit() {
        stopped = true;
        clearInterval(interval);
        if (pending) await pending;
        if (lost) return false;
        await renew(true);
        return !lost;
      },
      async stop() {
        stopped = true;
        clearInterval(interval);
        if (pending) await pending;
      },
    };
  }

  private metricLabels(
    input: Pick<RunConnectorPollInput, "installation_id" | "stream_key">,
  ): SyncMetricLabels {
    return {
      installation_id: input.installation_id,
      source: this.connector.source,
      lane: currentSyncLane(),
    };
  }

  private recordSummary(
    summary: ReturnType<typeof ingestAttemptSummary>,
    labels: SyncMetricLabels,
  ): void {
    this.metrics.record({
      name: "accepted_records",
      value: summary.accepted_count,
      labels,
    });
    this.metrics.record({
      name: "duplicate_records",
      value: summary.duplicate_count,
      labels,
    });
    this.metrics.record({
      name: "quarantined_records",
      value: summary.quarantined_count,
      labels,
    });
    this.metrics.record({
      name: "retryable_failures",
      value: summary.retryable_failure_count,
      labels,
    });
  }

  private requireValidResult(
    submission: IngestSubmissionResult,
  ): IngestBatchResult {
    if (!submission.valid) {
      throw new Error(`Ingest batch rejected: ${submission.error_code}`);
    }
    return submission;
  }
}

function webhookWakeThreadIds(batch: IngestBatch): string[] {
  const ids = new Set<string>();
  for (const record of batch.records) {
    const id = record.thread?.id?.trim();
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}

function pollOptions(
  input: Pick<
    RunConnectorPollInput,
    "older" | "latest" | "media" | "before" | "before_external_id" | "push_watermark"
  >,
  signal?: AbortSignal,
  pageSize?: number,
): ConnectorPollOptions | undefined {
  const options: ConnectorPollOptions = {};
  if (pageSize !== undefined) {
    options.page_size = pageSize;
  }
  const pushWatermark = input.push_watermark?.trim();
  if (pushWatermark) {
    options.push_watermark = pushWatermark;
  }
  if (input.older === true) {
    options.older = true;
  }
  if (input.latest === true) {
    options.latest = true;
  }
  if (input.media === false) {
    options.media = false;
  }
  const before = input.before?.trim();
  if (before) {
    options.before = before;
  }
  const beforeExternalId = input.before_external_id?.trim();
  if (beforeExternalId) {
    options.before_external_id = beforeExternalId;
  }
  if (signal) {
    options.signal = signal;
  }
  return options.older ||
    options.latest ||
    options.media === false ||
    options.signal ||
    options.before ||
    options.page_size !== undefined ||
    options.push_watermark !== undefined
    ? options
    : undefined;
}

function isLostLease(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("lease is not held")
  );
}

function leaseHasExpired(now: string, expiresAt: string): boolean {
  const nowMs = Date.parse(now);
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(expiresMs)) {
    throw new Error("Connector lease has an invalid timestamp");
  }
  return nowMs >= expiresMs;
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate.?limit|throttl/i.test(message);
}