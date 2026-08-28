import { randomUUID } from "node:crypto";
import type {
  ChannelConnector,
  ConnectorPollOptions,
  ConnectorQuotaHint,
  ConnectorRuntimeStore,
  IngestBatchResult,
  IngestRecordResult,
  WebhookRequest,
} from "./ingestion";
import type { IngestSubmissionResult } from "./ingestion-service";
import { withDeadline } from "./deadline";
import {
  connectorAcceptsWebhook,
  connectorPolls,
  connectorSourceMode,
} from "./source-mode";
import type { InstallationQuotaBook } from "./quota";

export interface IngestBatchProcessor {
  ingest(input: unknown): Promise<IngestSubmissionResult>;
}

export interface RunConnectorPollInput {
  installation_id: string;
  stream_key: string;
  lease_owner: string;
  lease_duration_ms: number;
  older?: boolean;
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
    };

export type RunnerConnector = Pick<
  ChannelConnector,
  "source" | "source_mode" | "quota" | "poll" | "verifyWebhook" | "handleWebhook"
>;

export class ConnectorRunner {
  constructor(
    private readonly connector: RunnerConnector,
    private readonly processor: IngestBatchProcessor,
    private readonly runtimeStore: ConnectorRuntimeStore,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly quota?: Pick<InstallationQuotaBook, "tryConsume">,
  ) {}

  async poll(input: RunConnectorPollInput): Promise<ConnectorPollRunResult> {
    const poll = this.connector.poll?.bind(this.connector);
    if (!connectorPolls(connectorSourceMode(this.connector)) || !poll) {
      return {
        status: "unsupported_mode",
        installation_id: input.installation_id,
        stream_key: input.stream_key,
      };
    }
    if (!this.takeQuota(input.installation_id, this.connector.quota)) {
      return {
        status: "throttled",
        installation_id: input.installation_id,
        stream_key: input.stream_key,
      };
    }
    const startedAt = this.now();
    const lease = await this.runtimeStore.acquireLease({
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      lease_owner: input.lease_owner,
      now: startedAt,
      lease_duration_ms: input.lease_duration_ms,
    });
    if (!lease) {
      return {
        status: "lease_unavailable",
        installation_id: input.installation_id,
        stream_key: input.stream_key,
      };
    }

    let pollResult;
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
      throw error;
    }
    const attemptId = randomUUID();
    await this.runtimeStore.beginAttempt({
      id: attemptId,
      org_id: pollResult.batch.org_id,
      connector_installation_id: input.installation_id,
      stream_key: input.stream_key,
      delivery_id: pollResult.batch.delivery_id,
      started_at: startedAt,
    });

    if (pollResult.batch.records.length === 0) {
      const nextCursor = pollResult.next_cursor ?? pollResult.batch.next_cursor;
      await this.runtimeStore.settleAttempt({
        attempt_id: attemptId,
        installation_id: input.installation_id,
        stream_key: input.stream_key,
        lease_owner: input.lease_owner,
        finished_at: this.now(),
        accepted_count: 0,
        duplicate_count: 0,
        quarantined_count: 0,
        retryable_failure_count: 0,
        next_cursor: nextCursor,
        quarantines: [],
      });
      return {
        status: "completed",
        installation_id: input.installation_id,
        stream_key: input.stream_key,
        attempt_id: attemptId,
        result: {
          connector_id: pollResult.batch.connector_id,
          delivery_id: pollResult.batch.delivery_id,
          records: [],
        },
        next_cursor: nextCursor,
        has_more: pollResult.has_more,
      };
    }

    let result: IngestBatchResult;
    try {
      const submission = await this.processor.ingest(pollResult.batch);
      result = this.requireValidResult(submission);
    } catch (error) {
      await this.runtimeStore.settleAttempt({
        attempt_id: attemptId,
        installation_id: input.installation_id,
        stream_key: input.stream_key,
        lease_owner: input.lease_owner,
        finished_at: this.now(),
        accepted_count: 0,
        duplicate_count: 0,
        quarantined_count: 0,
        retryable_failure_count: 1,
        error_code: "internal_error",
        quarantines: [],
      });
      throw error;
    }
    const summary = this.summarize(result.records);
    const nextCursor = pollResult.next_cursor ?? pollResult.batch.next_cursor;
    await this.runtimeStore.settleAttempt({
      attempt_id: attemptId,
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      lease_owner: input.lease_owner,
      finished_at: this.now(),
      ...summary,
      next_cursor: nextCursor,
      quarantines: result.records
        .filter((record) => record.status === "quarantined")
        .map((record) => ({
          id: randomUUID(),
          record_external_id: record.external_id,
          reason_code: record.error_code ?? "invalid_record",
          safe_metadata: {},
          created_at: this.now(),
        })),
    });

    return {
      status:
        summary.retryable_failure_count === 0
          ? "completed"
          : "retryable_failure",
      installation_id: input.installation_id,
      stream_key: input.stream_key,
      attempt_id: attemptId,
      result,
      next_cursor: nextCursor,
      has_more: pollResult.has_more,
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
    const summary = this.summarize(result.records);
    return {
      status:
        summary.retryable_failure_count === 0
          ? "completed"
          : "retryable_failure",
      installation_id: input.installation_id,
      result,
    };
  }

  private takeQuota(
    installationId: string,
    quota?: ConnectorQuotaHint,
  ): boolean {
    return this.quota?.tryConsume(installationId, quota) ?? true;
  }

  private requireValidResult(
    submission: IngestSubmissionResult,
  ): IngestBatchResult {
    if (!submission.valid) {
      throw new Error(`Ingest batch rejected: ${submission.error_code}`);
    }
    return submission;
  }

  private summarize(records: IngestRecordResult[]): {
    accepted_count: number;
    duplicate_count: number;
    quarantined_count: number;
    retryable_failure_count: number;
    error_code?: string;
  } {
    const retryable = records.find(
      (record) => record.status === "retryable_failure",
    );
    return {
      accepted_count: records.filter((record) => record.status === "accepted")
        .length,
      duplicate_count: records.filter((record) => record.status === "duplicate")
        .length,
      quarantined_count: records.filter(
        (record) => record.status === "quarantined",
      ).length,
      retryable_failure_count: records.filter(
        (record) => record.status === "retryable_failure",
      ).length,
      error_code: retryable?.error_code,
    };
  }
}

function pollOptions(
  input: Pick<RunConnectorPollInput, "older" | "media">,
): ConnectorPollOptions | undefined {
  const options: ConnectorPollOptions = {};
  if (input.older === true) {
    options.older = true;
  }
  if (input.media === false) {
    options.media = false;
  }
  return options.older || options.media === false ? options : undefined;
}