import { randomUUID } from "node:crypto";
import type { SyncPollHint } from "./sync-contracts";
import type {
  ChannelConnector,
  ConnectorPollOptions,
  ConnectorQuotaHint,
  ConnectorRuntimeStore,
  IngestBatch,
  IngestBatchResult,
  IngestRecordResult,
  NewIngestAttempt,
  SyncPageCommit,
  WebhookRequest,
} from "./ingestion";
import {
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
  timeout_ms?: number;
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
  "source" | "source_mode" | "quota" | "poll" | "verifyWebhook" | "handleWebhook"
>;

export class ConnectorRunner {
  private readonly connector: ConnectorRuntimeInvoker;

  constructor(
    connector: RunnerConnector | ConnectorRuntimeInvoker,
    private readonly processor: IngestBatchProcessor,
    private readonly runtimeStore: ConnectorRuntimeStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly quota?: Pick<InstallationQuotaBook, "tryConsume">,
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
    const labels = this.metricLabels(input);
    const leaseStartedAt = Date.now();
    const lease = await this.runtimeStore.acquireLease({
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      lease_owner: input.lease_owner,
      now: startedAt,
      lease_duration_ms: input.lease_duration_ms,
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
    if (!this.takeQuota(input.installation_id, this.connector.quota)) {
      await this.runtimeStore.releaseLease({
        installation_id: input.installation_id,
        stream_key: input.stream_key,
        lease_owner: input.lease_owner,
        now: this.now(),
      });
      this.metrics.record({ name: "throttled", value: 1, labels });
      return {
        status: "throttled",
        installation_id: input.installation_id,
        stream_key: input.stream_key,
      };
    }

    let pollResult;
    const pollStartedAt = Date.now();
    try {
      pollResult = await withDeadline(
        poll(
          lease.cursor ? { value: lease.cursor } : null,
          pollOptions(input),
        ),
        input.timeout_ms ?? 0,
        `poll ${input.installation_id}:${input.stream_key}`,
      );
    } catch (error) {
      await this.runtimeStore.releaseLease({
        installation_id: input.installation_id,
        stream_key: input.stream_key,
        lease_owner: input.lease_owner,
        now: this.now(),
      });
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
    const attempt: NewIngestAttempt = {
      id: randomUUID(),
      org_id: pollResult.batch.org_id,
      connector_installation_id: input.installation_id,
      stream_key: input.stream_key,
      delivery_id: pollResult.batch.delivery_id,
      started_at: startedAt,
    };
    const settleBase = {
      attempt_id: attempt.id,
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      lease_owner: input.lease_owner,
    };

    if (pollResult.batch.records.length === 0) {
      const nextCursor = pollResult.next_cursor ?? pollResult.batch.next_cursor;
      const settleStartedAt = Date.now();
      await this.commitPage({
        attempt,
        settle: {
          ...settleBase,
          finished_at: this.now(),
          accepted_count: 0,
          duplicate_count: 0,
          quarantined_count: 0,
          retryable_failure_count: 0,
          next_cursor: nextCursor,
          quarantines: [],
        },
      });
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
        next_cursor: nextCursor,
        has_more: pollResult.has_more,
        media_pending: pollResult.media_pending,
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
          next_cursor: pollResult.next_cursor ?? pollResult.batch.next_cursor,
        },
      };
      const submission = await this.processor.ingest(pollResult.batch, page);
      result = this.requireValidResult(submission);
      if (submission.valid && !submission.page_committed) {
        const settleStartedAt = Date.now();
        await this.commitPage({
          attempt,
          settle: this.settleFromResult(settleBase, result.records, page.settle),
        });
        recordSyncDuration(this.metrics, "settle_ms", settleStartedAt, labels);
      }
    } catch (error) {
      try {
        await this.commitPage({
          attempt,
          settle: {
            ...settleBase,
            finished_at: this.now(),
            accepted_count: 0,
            duplicate_count: 0,
            quarantined_count: 0,
            retryable_failure_count: 1,
            error_code: "internal_error",
            quarantines: [],
          },
        });
      } catch {
        await this.runtimeStore.releaseLease({
          installation_id: input.installation_id,
          stream_key: input.stream_key,
          lease_owner: input.lease_owner,
          now: this.now(),
        });
      }
      throw error;
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
      next_cursor: pollResult.next_cursor ?? pollResult.batch.next_cursor,
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

  private metricLabels(
    input: Pick<RunConnectorPollInput, "installation_id" | "stream_key">,
  ): SyncMetricLabels {
    return {
      installation_id: input.installation_id,
      stream_key: input.stream_key,
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
  input: Pick<RunConnectorPollInput, "older" | "latest" | "media">,
): ConnectorPollOptions | undefined {
  const options: ConnectorPollOptions = {};
  if (input.older === true) {
    options.older = true;
  }
  if (input.latest === true) {
    options.latest = true;
  }
  if (input.media === false) {
    options.media = false;
  }
  return options.older || options.latest || options.media === false
    ? options
    : undefined;
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate.?limit|throttl/i.test(message);
}