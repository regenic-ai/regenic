import { randomUUID } from "node:crypto";
import { ArrangementService } from "./arrangement-service";
import {
  blobsForCanonical,
  canonicalizeRecordContent,
  ContentUnavailableError,
  extraBlobsForCanonical,
  type CanonicalContent,
} from "./canonicalization";
import type {
  AuthorityStore,
  BlobObject,
  BlobStore,
  EventRecord,
  IngestBatchResult,
  IngestErrorCode,
  IngestRecord,
  IngestRecordResult,
  NewEvent,
  SourceIdentity,
} from "./ingestion";
import { AuthorityConflictError } from "./ingestion";
import {
  validateIngestBatch,
  type IngestValidationIssue,
} from "./ingestion-schema";
import {
  incomingImprovesAttachments,
  incomingWorsensAttachments,
  preserveResolvedAttachments,
  resolutionFromCanonical,
  resolutionFromStored,
  type AttachmentResolution,
} from "./content-resolution";
import {
  attachmentDigestsFromParts,
  attachmentDigestsFromStored,
  attachmentsCoveredBy,
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

type InspectedRecord =
  | { kind: "result"; result: IngestRecordResult }
  | {
      kind: "create";
      identity: SourceIdentity;
      record: IngestRecord;
      canonical: CanonicalContent;
    }
  | {
      kind: "revise";
      identity: SourceIdentity;
      record: IngestRecord;
      canonical: CanonicalContent;
      current: EventRecord;
    }
  | {
      kind: "tombstone";
      identity: SourceIdentity;
      record: IngestRecord;
      current: EventRecord | null;
    }
  | {
      kind: "create_after_tombstone";
      identity: SourceIdentity;
      record: IngestRecord;
      canonical: CanonicalContent;
      current: EventRecord;
    };

interface PlannedCreate {
  index: number;
  eventId: string;
  identity: SourceIdentity;
  record: IngestRecord;
  canonical: CanonicalContent;
}

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
    const records: IngestRecordResult[] = new Array(batch.records.length);
    const overlay = new PendingIngestOverlay();
    const pendingCreates: PlannedCreate[] = [];

    const flushCreates = async () => {
      if (pendingCreates.length === 0) {
        return;
      }
      const planned = pendingCreates.splice(0, pendingCreates.length);
      await this.commitCreates(planned, records);
    };

    for (const [index, record] of batch.records.entries()) {
      const inspected = await this.inspectRecord(batch.org_id, record, overlay);
      if (inspected.kind === "result") {
        records[index] = inspected.result;
        continue;
      }
      if (inspected.kind === "create") {
        const eventId = randomUUID();
        overlay.rememberCreate(
          inspected.identity,
          previewCreate(eventId, inspected.identity, inspected.record, inspected.canonical),
          inspected.record,
        );
        pendingCreates.push({
          index,
          eventId,
          identity: inspected.identity,
          record: inspected.record,
          canonical: inspected.canonical,
        });
        continue;
      }
      await flushCreates();
      records[index] = await this.ingestRecord(batch.org_id, record);
    }
    await flushCreates();

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
    const inspected = await this.inspectRecord(orgId, record);
    if (inspected.kind === "result") {
      return inspected.result;
    }
    return this.persistInspected(inspected);
  }

  private async inspectRecord(
    orgId: string,
    record: IngestRecord,
    overlay?: PendingIngestOverlay,
  ): Promise<InspectedRecord> {
    const identity: SourceIdentity = {
      org_id: orgId,
      source: record.source,
      external_id: record.external_id,
    };
    const overlayCurrent = overlay?.current(identity);
    const current =
      overlayCurrent ?? (await this.authorityStore.findBySourceIdentity(identity));

    if (record.operation === "tombstone") {
      if (current?.operation === "tombstone") {
        return this.replayedInspected(record, current, overlayCurrent);
      }
      return { kind: "tombstone", identity, record, current };
    }

    const merged = await this.mergeRecordContent(record, current);
    let canonical;
    try {
      canonical = canonicalizeRecordContent(merged);
    } catch (error) {
      if (error instanceof ContentUnavailableError) {
        return {
          kind: "result",
          result: {
            external_id: record.external_id,
            status: "quarantined",
            error_code: "content_unavailable",
          },
        };
      }
      throw error;
    }

    if (current?.content_hash === canonical.hash) {
      return this.replayedInspected(record, current, overlayCurrent);
    }

    const overlayEcho = overlay?.findEcho(record);
    if (overlayEcho) {
      return {
        kind: "result",
        result: duplicateResult(record, overlayEcho),
      };
    }
    const echoed = await this.findEchoedOutbound(orgId, record);
    if (echoed) {
      return {
        kind: "result",
        result: await this.replayed(record, echoed),
      };
    }

    if (record.operation === "revise" && !current) {
      return {
        kind: "result",
        result: {
          external_id: record.external_id,
          status: "quarantined",
          error_code: "source_identity_conflict",
        },
      };
    }

    if (current) {
      const existing = await this.existingResolution(current);
      const incoming = resolutionFromCanonical(canonical);
      if (incomingWorsensAttachments(existing, incoming)) {
        return this.replayedInspected(record, current, overlayCurrent);
      }
      if (record.operation === "revise") {
        return { kind: "revise", identity, record: merged, canonical, current };
      }
      if (
        current.operation !== "tombstone" ||
        current.parent_event_id !== undefined
      ) {
        if (incomingImprovesAttachments(existing, incoming)) {
          return { kind: "revise", identity, record: merged, canonical, current };
        }
        if (existing.unresolvedCount > 0 || incoming.unresolvedCount > 0) {
          return this.replayedInspected(record, current, overlayCurrent);
        }
        return {
          kind: "result",
          result: {
            external_id: record.external_id,
            status: "quarantined",
            error_code: "source_identity_conflict",
          },
        };
      }
    }

    if (current) {
      return {
        kind: "create_after_tombstone",
        identity,
        record: merged,
        canonical,
        current,
      };
    }

    return { kind: "create", identity, record: merged, canonical };
  }

  private async mergeRecordContent(
    record: IngestRecord,
    current: EventRecord | null | undefined,
  ): Promise<IngestRecord> {
    if (!current || !record.content) {
      return record;
    }
    const stored = await this.readEventBytes(current);
    const content = await preserveResolvedAttachments(
      record.content,
      stored?.bytes,
      stored?.mediaType,
      async (hash) => {
        try {
          return await this.blobStore.get(hash);
        } catch {
          return undefined;
        }
      },
    );
    return content === record.content ? record : { ...record, content };
  }

  private async replayedInspected(
    record: IngestRecord,
    event: EventRecord,
    overlayCurrent: EventRecord | undefined,
  ): Promise<InspectedRecord> {
    if (overlayCurrent) {
      return {
        kind: "result",
        result: duplicateResult(record, event),
      };
    }
    return {
      kind: "result",
      result: await this.replayed(record, event),
    };
  }

  private async commitCreates(
    creates: PlannedCreate[],
    records: IngestRecordResult[],
  ): Promise<void> {
    const blobs = new Map<string, BlobObject>();
    for (const item of creates) {
      for (const blob of blobsForCanonical(item.canonical)) {
        if (!blobs.has(blob.hash)) {
          blobs.set(blob.hash, blob);
        }
      }
    }
    await this.blobStore.putMany([...blobs.values()]);

    const appends: NewEvent[] = creates.map((item) => ({
      id: item.eventId,
      ...item.identity,
      content_hash: item.canonical.hash,
      content_media_type: item.canonical.media_type,
      content_byte_size: item.canonical.bytes.byteLength,
      extra_blobs: extraBlobsForCanonical(item.canonical),
      occurred_at: item.record.occurred_at,
      expected_head_id: null,
    }));
    const dispositions = creates.map((item) =>
      this.arrangement.decide(
        previewCreate(item.eventId, item.identity, item.record, item.canonical),
        item.record,
      ),
    );

    try {
      const events = await this.authorityStore.commitIngest({
        appends,
        dispositions,
      });
      for (const [index, item] of creates.entries()) {
        records[item.index] = {
          external_id: item.record.external_id,
          status: "accepted",
          event_id: events[index]?.id ?? item.eventId,
        };
      }
    } catch (error) {
      if (error instanceof AuthorityConflictError) {
        for (const item of creates) {
          records[item.index] = await this.ingestRecord(
            item.identity.org_id,
            item.record,
          );
        }
        return;
      }
      throw error;
    }
  }

  private async persistInspected(
    inspected: Exclude<InspectedRecord, { kind: "result" }>,
  ): Promise<IngestRecordResult> {
    if (inspected.kind === "tombstone") {
      return this.ingestTombstone(
        inspected.identity,
        inspected.record,
        inspected.current,
      );
    }

    await this.blobStore.putMany(blobsForCanonical(inspected.canonical));
    const extraBlobs = extraBlobsForCanonical(inspected.canonical);

    try {
      if (inspected.kind === "revise") {
        const event = await this.authorityStore.appendRevision({
          ...inspected.identity,
          content_hash: inspected.canonical.hash,
          content_media_type: inspected.canonical.media_type,
          content_byte_size: inspected.canonical.bytes.byteLength,
          extra_blobs: extraBlobs,
          occurred_at: inspected.record.occurred_at,
          expected_head_id: inspected.current.id,
          parent_event_id: inspected.current.id,
          revision_id: inspected.record.revision_id,
        });
        return this.accepted(inspected.record, event);
      }

      const event = await this.authorityStore.append({
        ...inspected.identity,
        content_hash: inspected.canonical.hash,
        content_media_type: inspected.canonical.media_type,
        content_byte_size: inspected.canonical.bytes.byteLength,
        extra_blobs: extraBlobs,
        occurred_at: inspected.record.occurred_at,
        expected_head_id:
          inspected.kind === "create_after_tombstone"
            ? inspected.current.id
            : null,
      });

      if (inspected.kind === "create_after_tombstone") {
        const tombstone = await this.authorityStore.markTombstone({
          ...inspected.identity,
          occurred_at: inspected.current.occurred_at,
          expected_head_id: event.id,
        });
        return this.accepted(inspected.record, tombstone);
      }

      return this.accepted(inspected.record, event);
    } catch (error) {
      if (error instanceof AuthorityConflictError) {
        return this.concurrentUpdate(inspected.record);
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
    return duplicateResult(record, event);
  }

  private async findEchoedOutbound(
    orgId: string,
    record: IngestRecord,
  ): Promise<EventRecord | null> {
    const needle = echoNeedle(record);
    if (!needle) {
      return null;
    }
    const events = await this.authorityStore.listEvents(orgId);
    const candidates = events.filter(
      (event) =>
        event.source === record.source &&
        isLocalOutboundId(event.external_id) &&
        conversationId(event.source, event.external_id, event.id) ===
          needle.conversation,
    );
    const ordered = needle.text ? candidates : [...candidates].reverse();
    for (const event of ordered) {
      if (needle.text) {
        const existing = await this.readEventText(event);
        if (existing && normalizeUtterance(existing) === needle.text) {
          return event;
        }
        continue;
      }
      const existing = await this.readEventAttachments(event);
      if (attachmentsCoveredBy(needle.attachments, existing)) {
        return event;
      }
    }
    return null;
  }

  private async readEventText(event: EventRecord): Promise<string | undefined> {
    const stored = await this.readEventBytes(event);
    if (!stored) {
      return undefined;
    }
    try {
      return bodyTextFromStored(stored.bytes, stored.mediaType);
    } catch {
      return undefined;
    }
  }

  private async existingResolution(
    event: EventRecord,
  ): Promise<AttachmentResolution> {
    const stored = await this.readEventBytes(event);
    if (!stored) {
      return { resolvedHashes: [], unresolvedCount: 0 };
    }
    return resolutionFromStored(stored.bytes, stored.mediaType);
  }

  private async readEventAttachments(event: EventRecord): Promise<string[]> {
    const stored = await this.readEventBytes(event);
    if (!stored) {
      return [];
    }
    try {
      return attachmentDigestsFromStored(stored.bytes, stored.mediaType);
    } catch {
      return [];
    }
  }

  private async readEventBytes(
    event: EventRecord,
  ): Promise<{ bytes: Uint8Array; mediaType: string } | undefined> {
    if (!event.content_hash) {
      return undefined;
    }
    const meta = await this.authorityStore.findBlob(event.content_hash);
    if (!meta) {
      return undefined;
    }
    try {
      return {
        bytes: await this.blobStore.get(event.content_hash),
        mediaType: meta.media_type,
      };
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

class PendingIngestOverlay {
  private readonly byKey = new Map<string, EventRecord>();
  private readonly pending: Array<{ event: EventRecord; record: IngestRecord }> =
    [];

  current(identity: SourceIdentity): EventRecord | undefined {
    return this.byKey.get(identityKey(identity));
  }

  rememberCreate(
    identity: SourceIdentity,
    event: EventRecord,
    record: IngestRecord,
  ): void {
    this.byKey.set(identityKey(identity), event);
    this.pending.push({ event, record });
  }

  findEcho(record: IngestRecord): EventRecord | null {
    const needle = echoNeedle(record);
    if (!needle) {
      return null;
    }
    const candidates = this.pending.filter(
      (item) =>
        item.record.source === record.source &&
        isLocalOutboundId(item.record.external_id) &&
        conversationId(
          item.event.source,
          item.event.external_id,
          item.event.id,
        ) === needle.conversation,
    );
    const ordered = needle.text ? candidates : [...candidates].reverse();
    for (const item of ordered) {
      if (needle.text) {
        const existing = normalizeUtterance(recordBodyText(item.record));
        if (existing && existing === needle.text) {
          return item.event;
        }
        continue;
      }
      if (
        attachmentsCoveredBy(
          needle.attachments,
          attachmentDigestsFromParts(item.record.content ?? []),
        )
      ) {
        return item.event;
      }
    }
    return null;
  }
}

function previewCreate(
  eventId: string,
  identity: SourceIdentity,
  record: IngestRecord,
  canonical: CanonicalContent,
): EventRecord {
  return {
    id: eventId,
    org_id: identity.org_id,
    source: identity.source,
    external_id: identity.external_id,
    operation: "create",
    content_hash: canonical.hash,
    occurred_at: record.occurred_at,
    ingested_at: record.occurred_at,
  };
}

function duplicateResult(
  record: IngestRecord,
  event: EventRecord,
): IngestRecordResult {
  return {
    external_id: record.external_id,
    status: "duplicate",
    event_id: event.id,
  };
}

function identityKey(identity: SourceIdentity): string {
  return JSON.stringify([identity.org_id, identity.source, identity.external_id]);
}

function recordBodyText(record: IngestRecord): string | undefined {
  return record.content?.find((part) => part.role === "body" && part.text !== undefined)?.text;
}

function echoNeedle(record: IngestRecord): {
  conversation: string;
  text: string;
  attachments: string[];
} | null {
  if (isLocalOutboundId(record.external_id)) {
    return null;
  }
  if (surfaceFromParts(record.content ?? [])?.kind !== "user") {
    return null;
  }
  const text = normalizeUtterance(recordBodyText(record));
  const attachments = attachmentDigestsFromParts(record.content ?? []);
  if (!text && attachments.length === 0) {
    return null;
  }
  if (
    !text &&
    record.direction_tags &&
    !record.direction_tags.includes("outbound")
  ) {
    return null;
  }
  return {
    conversation: conversationId(record.source, record.external_id),
    text,
    attachments,
  };
}
