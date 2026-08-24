import { randomUUID } from "node:crypto";
import type {
  ChannelConnector,
  ConnectorRuntimeStore,
  IngestBatch,
  IngestBatchResult,
  IngestRecordResult,
} from "./ingestion";
import type { IngestSubmissionResult } from "./ingestion-service";

export interface IngestBatchProcessor {
  ingest(input: unknown): Promise<IngestSubmissionResult>;
}

export interface RunConnectorPollInput {
  installation_id: string;
  stream_key: string;
  lease_owner: string;
  lease_duration_ms: number;
}

export type ConnectorPollRunResult =
  | {
      status: "lease_unavailable";
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

export class ConnectorRunner {
  constructor(
    private readonly connector: Pick<ChannelConnector, "poll">,
    private readonly processor: IngestBatchProcessor,
    private readonly runtimeStore: ConnectorRuntimeStore,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async poll(input: RunConnectorPollInput): Promise<ConnectorPollRunResult> {
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
      pollResult = await this.connector.poll(
        lease.cursor ? { value: lease.cursor } : null,
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