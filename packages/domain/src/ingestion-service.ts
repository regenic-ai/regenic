import { ArrangementService } from "./arrangement-service";
import {
  canonicalizeRecordContent,
  ContentUnavailableError,
} from "./canonicalization";
import type {
  AuthorityStore,
  BlobStore,
  EventRecord,
  IngestBatchResult,
  IngestErrorCode,
  IngestRecord,
  IngestRecordResult,
  SourceIdentity,
} from "./ingestion";
import { AuthorityConflictError } from "./ingestion";
import {
  validateIngestBatch,
  type IngestValidationIssue,
} from "./ingestion-schema";
import {
  bodyTextFromStored,
  conversationId,
  isLocalOutboundId,
  normalizeUtterance,
  surfaceFromParts,
} from "./message-contract";

export type IngestSubmissionResult =
  | ({ valid: true } & IngestBatchResult)
  | {
      valid: false;
      error_code: Extract<IngestErrorCode, "invalid_envelope" | "invalid_record">;
      issues: IngestValidationIssue[];
    };

export class IngestionService {
  private readonly arrangement: ArrangementService;

  constructor(
    private readonly blobStore: BlobStore,
    private readonly authorityStore: AuthorityStore,
  ) {
    this.arrangement = new ArrangementService(authorityStore);
  }

  async ingest(input: unknown): Promise<IngestSubmissionResult> {
    const validation = validateIngestBatch(input);
    if (!validation.success) {
      return {
        valid: false,
        error_code: validation.error_code,
        issues: validation.issues,
      };
    }

    const batch = validation.data;
    const records: IngestRecordResult[] = [];

    for (const record of batch.records) {
      records.push(await this.ingestRecord(batch.org_id, record));
    }

    return {
      valid: true,
      connector_id: batch.connector_id,
      delivery_id: batch.delivery_id,
      records,
    };
  }

  private async ingestRecord(
    orgId: string,
    record: IngestRecord,
  ): Promise<IngestRecordResult> {
    const identity: SourceIdentity = {
      org_id: orgId,
      source: record.source,
      external_id: record.external_id,
    };
    const current = await this.authorityStore.findBySourceIdentity(identity);

    if (record.operation === "tombstone") {
      return this.ingestTombstone(identity, record, current);
    }

    let canonical;
    try {
      canonical = canonicalizeRecordContent(record);
    } catch (error) {
      if (error instanceof ContentUnavailableError) {
        return {
          external_id: record.external_id,
          status: "quarantined",
          error_code: "content_unavailable",
        };
      }
      throw error;
    }

    if (current?.content_hash === canonical.hash) {
      return this.replayed(record, current);
    }

    const echoed = await this.findEchoedOutbound(orgId, record);
    if (echoed) {
      return this.replayed(record, echoed);
    }

    if (
      record.operation === "create" &&
      current &&
      (current.operation !== "tombstone" || current.parent_event_id !== undefined)
    ) {
      return {
        external_id: record.external_id,
        status: "quarantined",
        error_code: "source_identity_conflict",
      };
    }

    if (record.operation === "revise" && !current) {
      return {
        external_id: record.external_id,
        status: "quarantined",
        error_code: "source_identity_conflict",
      };
    }

    await this.blobStore.put(
      canonical.hash,
      canonical.bytes,
      canonical.media_type,
    );

    try {
      if (record.operation === "revise" && current) {
        const event = await this.authorityStore.appendRevision({
          ...identity,
          content_hash: canonical.hash,
          content_media_type: canonical.media_type,
          content_byte_size: canonical.bytes.byteLength,
          occurred_at: record.occurred_at,
          expected_head_id: current.id,
          parent_event_id: current.id,
          revision_id: record.revision_id,
        });
        return this.accepted(record, event);
      }

      const event = await this.authorityStore.append({
        ...identity,
        content_hash: canonical.hash,
        content_media_type: canonical.media_type,
        content_byte_size: canonical.bytes.byteLength,
        occurred_at: record.occurred_at,
        expected_head_id: current?.id ?? null,
      });

      if (current?.operation === "tombstone") {
        const tombstone = await this.authorityStore.markTombstone({
          ...identity,
          occurred_at: current.occurred_at,
          expected_head_id: event.id,
        });
        return this.accepted(record, tombstone);
      }

      return this.accepted(record, event);
    } catch (error) {
      if (error instanceof AuthorityConflictError) {
        return this.concurrentUpdate(record);
      }
      throw error;
    }
  }

  private async ingestTombstone(
    identity: SourceIdentity,
    record: IngestRecord,
    current: EventRecord | null,
  ): Promise<IngestRecordResult> {
    if (current?.operation === "tombstone") {
      return this.replayed(record, current);
    }

    try {
      const event = await this.authorityStore.markTombstone({
        ...identity,
        occurred_at: record.occurred_at,
        expected_head_id: current?.id ?? null,
      });
      return this.accepted(record, event);
    } catch (error) {
      if (error instanceof AuthorityConflictError) {
        return this.concurrentUpdate(record);
      }
      throw error;
    }
  }

  private async accepted(
    record: IngestRecord,
    event: EventRecord,
  ): Promise<IngestRecordResult> {
    await this.arrangement.remember(event, record);
    return {
      external_id: record.external_id,
      status: "accepted",
      event_id: event.id,
    };
  }

  private async replayed(
    record: IngestRecord,
    event: EventRecord,
  ): Promise<IngestRecordResult> {
    if (!(await this.authorityStore.getDisposition(event.id))) {
      await this.arrangement.remember(event, record);
    }
    return {
      external_id: record.external_id,
      status: "duplicate",
      event_id: event.id,
    };
  }

  private async findEchoedOutbound(
    orgId: string,
    record: IngestRecord,
  ): Promise<EventRecord | null> {
    if (isLocalOutboundId(record.external_id)) {
      return null;
    }
    if (surfaceFromParts(record.content ?? [])?.kind !== "user") {
      return null;
    }
    const incoming = normalizeUtterance(recordBodyText(record));
    if (!incoming) {
      return null;
    }
    const conversation = conversationId(record.source, record.external_id);
    const events = await this.authorityStore.listEvents(orgId);
    for (const event of events) {
      if (event.source !== record.source || !isLocalOutboundId(event.external_id)) {
        continue;
      }
      if (conversationId(event.source, event.external_id, event.id) !== conversation) {
        continue;
      }
      const existing = await this.readEventText(event);
      if (existing && normalizeUtterance(existing) === incoming) {
        return event;
      }
    }
    return null;
  }

  private async readEventText(event: EventRecord): Promise<string | undefined> {
    if (!event.content_hash) {
      return undefined;
    }
    const meta = await this.authorityStore.findBlob(event.content_hash);
    if (!meta) {
      return undefined;
    }
    try {
      return bodyTextFromStored(await this.blobStore.get(event.content_hash), meta.media_type);
    } catch {
      return undefined;
    }
  }

  private concurrentUpdate(record: IngestRecord): IngestRecordResult {
    return {
      external_id: record.external_id,
      status: "retryable_failure",
      error_code: "concurrent_source_update",
    };
  }
}

function recordBodyText(record: IngestRecord): string | undefined {
  return record.content?.find((part) => part.role === "body" && part.text !== undefined)?.text;
}