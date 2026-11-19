import { randomUUID } from "node:crypto";
import { ArrangementService } from "./arrangement-service";
import type { PersonalDispatchPolicy } from "./personal-dispatch-policy";
import {
  blobsForCanonical,
  canonicalizeRecordContent,
  ContentUnavailableError,
  extraBlobsForCanonical,
  type CanonicalContent,
} from "./canonicalization";
import type {
  AuthorityStore,
  BlobReservation,
  BlobObject,
  FencedBlobStore,
  ConnectorRuntimeStore,
  CommitSyncPage,
  ConversationPolicyVisibility,
  EventRecord,
  IngestBatchResult,
  IngestCommitRequest,
  IngestErrorCode,
  IngestRecord,
  IngestRecordResult,
  NewEvent,
  ReserveBlobWritesInput,
  SourceIdentity,
  SyncPageCommit,
} from "./ingestion";
import {
  AuthorityConflictError,
  DispositionRepairConflictError,
  collectAvailableBlobs,
  IngestPageProcessingError,
  ingestAttemptQuarantines,
  ingestAttemptSummary,
} from "./ingestion";
import {
  CONTENT_PARTS_MEDIA_TYPE,
  attachmentHashesFromStoredParts,
  parseStoredContentParts,
} from "./content-parts";
import {
  validateIngestBatch,
  type IngestValidationIssue,
} from "./ingestion-schema";
import {
  collectListSurfacePatches,
} from "./list-surface";
import { threadIdOf } from "./thread-surface";
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
import {
  isOccupiedRecipeSlot,
  recipeAllowsPushDispatch,
  shouldAcceptPushRecord,
} from "./recipe-trigger";
import { recipeConversationTitle, recipeTextMatches } from "./recipe-match";
import { isPushInboxDecision } from "./inbox-query";
import {
  openOrUpdateWorkItem,
  selectRecipeForSubject,
  workSubjectFromEvent,
} from "./work-policy";
import type { WorkItemObservation } from "./work-transition";
import {
  isActiveWorkStatus,
  type WorkItem,
  type WorkStore,
} from "./work";

export type IngestSubmissionResult =
  | ({ valid: true } & IngestBatchResult & { page_committed?: boolean })
  | {
      valid: false;
      error_code: Extract<IngestErrorCode, "invalid_envelope" | "invalid_record">;
      issues: IngestValidationIssue[];
    };

type InspectedRecord =
  | { kind: "result"; result: IngestRecordResult }
  | {
      kind: "replay_needs_repair";
      record: IngestRecord;
      event: EventRecord;
      identity?: SourceIdentity;
    }
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
  kind: "create";
  index: number;
  eventId: string;
  identity: SourceIdentity;
  record: IngestRecord;
  canonical: CanonicalContent;
}

interface PlannedRevision extends Omit<PlannedCreate, "kind"> {
  kind: "revise";
  current: EventRecord;
  originalRecord: IngestRecord;
}

interface PlannedCreateAfterTombstone extends Omit<PlannedCreate, "kind"> {
  kind: "create_after_tombstone";
  precedingEventId: string;
  current: EventRecord;
}

interface PlannedTombstone {
  kind: "tombstone";
  index: number;
  eventId: string;
  identity: SourceIdentity;
  record: IngestRecord;
  current: EventRecord | null;
}

interface PlannedReplay {
  kind: "replay";
  index: number;
  eventId: string;
  identity: SourceIdentity;
  record: IngestRecord;
  event: EventRecord;
}

type PlannedEvent =
  | PlannedCreate
  | PlannedRevision
  | PlannedCreateAfterTombstone
  | PlannedTombstone;
type PlannedConversationEffect = PlannedEvent | PlannedReplay;

export class IngestionService {
  private static readonly BLOB_WRITE_LEASE_MS = 120_000;
  private readonly arrangement: ArrangementService;

  constructor(
    private readonly blobStore: FencedBlobStore,
    private readonly authorityStore: AuthorityStore & WorkStore,
  ) {
    this.arrangement = new ArrangementService(authorityStore);
  }

  async ingest(
    input: unknown,
    page?: SyncPageCommit,
    pageRuntimeStore?: ConnectorRuntimeStore,
  ): Promise<IngestSubmissionResult> {
    const validation = validateIngestBatch(input);
    if (!validation.success) {
      return {
        valid: false,
        error_code: validation.error_code,
        issues: validation.issues,
      };
    }

    const batch = validation.data;
    const atomicPageStore =
      page && pageRuntimeStore?.atomicSyncPage === true &&
      Object.is(this.authorityStore, pageRuntimeStore)
        ? pageRuntimeStore
        : undefined;
    if (page && !atomicPageStore) {
      throw new Error(
        "Sync-page ingestion requires the same atomic Authority and runtime store",
      );
    }
    const records: IngestRecordResult[] = new Array(batch.records.length);
    const overlay = new PendingIngestOverlay();
    const pendingCreates: PlannedCreate[] = [];
    const bufferedEvents: PlannedEvent[] = [];
    let mixedWrites = false;
    const pendingIngest: IngestCommitRequest = {
      appends: [],
      dispositions: [],
      blob_reservations: [],
    };
    const dispositionRepairs: NonNullable<CommitSyncPage["disposition_repairs"]> = [];
    const repairEffectItems = new Map<
      NonNullable<CommitSyncPage["disposition_repairs"]>[number],
      PlannedReplay
    >();
    const repairRecordIndexes = new Map<
      NonNullable<CommitSyncPage["disposition_repairs"]>[number],
      number[]
    >();
    const completedRecordIndexes = new Set<number>();
    const pendingDuplicateIndexes = new Set<number>();
    const markCompleted = (index: number) => {
      completedRecordIndexes.add(index);
    };
    const isPendingEvent = (eventId: string) =>
      pendingCreates.some((item) => item.eventId === eventId) ||
      bufferedEvents.some((item) => item.eventId === eventId);
    const markResolvedDuplicates = (items: readonly PlannedEvent[]) => {
      const eventIds = new Set<string>();
      for (const item of items) {
        eventIds.add(item.eventId);
        const resolvedId = records[item.index]?.event_id;
        if (resolvedId) eventIds.add(resolvedId);
      }
      for (const index of pendingDuplicateIndexes) {
        const record = records[index];
        if (record?.status === "duplicate" && record.event_id && eventIds.has(record.event_id)) {
          markCompleted(index);
        }
      }
    };
    const atomic = atomicPageStore !== undefined;
    const dispatchPolicy = await this.arrangement.policyFor(batch.org_id);

    const flushCreates = async () => {
      if (pendingCreates.length === 0) {
        return;
      }
      const planned = pendingCreates.splice(0, pendingCreates.length);
      if (atomic && !mixedWrites) {
        await this.bufferPlannedEvents(
          planned,
          records,
          pendingIngest,
          bufferedEvents,
          dispatchPolicy,
        );
        return;
      }
      await this.commitCreates(
        planned,
        records,
        dispatchPolicy,
        markCompleted,
        markResolvedDuplicates,
      );
      overlay.clear();
    };
    const flushDispositionRepairs = async () => {
      const repairs = dispositionRepairs.splice(0, dispositionRepairs.length);
      if (repairs.length === 0) return;
      const items = repairs.flatMap((repair) => {
        const item = repairEffectItems.get(repair);
        return item ? [item] : [];
      });
      if (items.length !== repairs.length) {
        throw new Error("Missing planned effects for disposition repair");
      }
      const effects = await this.prepareConversationEffects(
        items,
        repairs.map((repair) => repair.decision),
      );
      await this.commitDispositionRepairs(repairs, effects);
      for (const repair of repairs) {
        for (const index of repairRecordIndexes.get(repair) ?? []) {
          markCompleted(index);
        }
      }
    };
    const flushBufferedEvents = async () => {
      if (pendingIngest.appends.length === 0) return;
      const planned = bufferedEvents.splice(0, bufferedEvents.length);
      const request: IngestCommitRequest = {
        appends: pendingIngest.appends.splice(0, pendingIngest.appends.length),
        dispositions: pendingIngest.dispositions.splice(0, pendingIngest.dispositions.length),
        blob_reservations: pendingIngest.blob_reservations?.splice(
          0,
          pendingIngest.blob_reservations.length,
        ),
      };
      try {
        const effects = await this.prepareConversationEffects(
          planned,
          request.dispositions,
        );
        const events = await this.authorityStore.commitConversationIntake({
          ingest: request,
          ...effects,
        });
        if (events.length !== request.appends.length) {
          throw new Error("Atomic ingestion did not return every buffered event");
        }
        for (const item of planned) markCompleted(item.index);
        markResolvedDuplicates(planned);
      } catch (error) {
        await this.authorityStore.releaseBlobReservations(request.blob_reservations ?? []);
        throw error;
      }
      overlay.clear();
    };

    try {
      for (const [index, record] of batch.records.entries()) {
        const inspected = await this.inspectRecord(batch.org_id, record, overlay);
        if (inspected.kind === "result") {
          records[index] = inspected.result;
          if (
            inspected.result.status === "duplicate" &&
            inspected.result.event_id &&
            isPendingEvent(inspected.result.event_id)
          ) {
            pendingDuplicateIndexes.add(index);
          } else {
            markCompleted(index);
          }
          continue;
        }
        if (inspected.kind === "replay_needs_repair" &&
          inspected.identity &&
          inspected.identity.org_id === inspected.event.org_id &&
          ((inspected.identity.source === record.source &&
            inspected.identity.external_id === record.external_id) ||
            (inspected.identity.source === inspected.event.source &&
              inspected.identity.external_id === inspected.event.external_id))) {
          const repairIdentity = inspected.identity;
          const existingRepair = dispositionRepairs.find((repair) =>
            repair.decision.event_id === inspected.event.id);
          if (existingRepair) {
            if (!existingRepair.identities.some((identity) =>
              identity.source === repairIdentity.source &&
              identity.external_id === repairIdentity.external_id)) {
              existingRepair.identities.push(repairIdentity);
            }
            repairRecordIndexes.get(existingRepair)?.push(index);
          } else {
            const repair = {
              identities: [repairIdentity],
              decision: this.arrangement.decide(
                inspected.event, record, undefined, dispatchPolicy,
              ),
            };
            dispositionRepairs.push(repair);
            repairEffectItems.set(repair, {
              kind: "replay",
              index,
              eventId: inspected.event.id,
              identity: {
                org_id: inspected.event.org_id,
                source: inspected.event.source,
                external_id: inspected.event.external_id,
              },
              record,
              event: inspected.event,
            });
            repairRecordIndexes.set(repair, [index]);
          }
          records[index] = duplicateResult(record, inspected.event);
          continue;
        }
        if (inspected.kind === "create") {
          const eventId = randomUUID();
          overlay.rememberCreate(
            inspected.identity,
            previewCreate(eventId, inspected.identity, inspected.record, inspected.canonical),
            inspected.record,
            inspected.canonical,
          );
          pendingCreates.push({
            kind: "create",
            index,
            eventId,
            identity: inspected.identity,
            record: inspected.record,
            canonical: inspected.canonical,
          });
          continue;
        }
        if (atomic && !mixedWrites && inspected.kind === "create_after_tombstone") {
          await flushCreates();
          const planned: PlannedCreateAfterTombstone = {
            kind: "create_after_tombstone",
            index,
            eventId: randomUUID(),
            precedingEventId: randomUUID(),
            identity: inspected.identity,
            record: inspected.record,
            canonical: inspected.canonical,
            current: inspected.current,
          };
          await this.bufferPlannedEvents(
            [planned], records, pendingIngest, bufferedEvents, dispatchPolicy,
          );
          overlay.rememberCurrent(
            planned.identity, previewPlannedEvent(planned), planned.record, planned.canonical,
          );
          continue;
        }
        if (atomic && !mixedWrites && inspected.kind === "revise") {
          await flushCreates();
          const planned: PlannedRevision = {
            kind: "revise",
            index,
            eventId: randomUUID(),
            identity: inspected.identity,
            record: inspected.record,
            originalRecord: record,
            canonical: inspected.canonical,
            current: inspected.current,
          };
          await this.bufferPlannedEvents(
            [planned], records, pendingIngest, bufferedEvents, dispatchPolicy,
          );
          overlay.rememberCurrent(
            planned.identity, previewPlannedEvent(planned), planned.record, planned.canonical,
          );
          continue;
        }
        if (atomic && !mixedWrites && inspected.kind === "tombstone") {
          await flushCreates();
          const planned: PlannedTombstone = {
            kind: "tombstone",
            index,
            eventId: randomUUID(),
            identity: inspected.identity,
            record: inspected.record,
            current: inspected.current,
          };
          await this.bufferPlannedEvents(
            [planned], records, pendingIngest, bufferedEvents, dispatchPolicy,
          );
          overlay.rememberCurrent(
            planned.identity, previewPlannedEvent(planned), planned.record,
          );
          continue;
        }
        mixedWrites = true;
        await flushCreates();
        await flushDispositionRepairs();
        await flushBufferedEvents();
        records[index] = await this.ingestRecord(batch.org_id, record, dispatchPolicy);
        markCompleted(index);
      }

      await flushCreates();

      let pageCommitted = false;
      let pageCommitAttempted = false;
      if (atomicPageStore && page && !mixedWrites) {
        pageCommitAttempted = true;
        const effects = await this.prepareConversationEffects(
          [
            ...bufferedEvents,
            ...dispositionRepairs.flatMap((repair) => {
              const item = repairEffectItems.get(repair);
              return item ? [item] : [];
            }),
          ],
          [...pendingIngest.dispositions, ...dispositionRepairs.map((repair) => repair.decision)],
        );
        try {
          pageCommitted = await this.commitPreparedPage(
            page,
            pendingIngest,
            records,
            bufferedEvents,
            effects,
            atomicPageStore,
            dispositionRepairs,
          );
        } catch (error) {
          if (!(error instanceof AuthorityConflictError)) throw error;
          const failedEventIds = new Set([
            ...bufferedEvents.map((item) => item.eventId),
            ...dispositionRepairs.map((repair) => repair.decision.event_id),
          ]);
          const failedIndexes = new Set([
            ...bufferedEvents.map((item) => item.index),
            ...dispositionRepairs.flatMap((repair) =>
              repairRecordIndexes.get(repair) ?? []),
            ...[...pendingDuplicateIndexes].filter((index) =>
              failedEventIds.has(records[index]?.event_id ?? "")),
          ]);
          for (const index of failedIndexes) {
            records[index] = this.concurrentUpdate(batch.records[index]);
          }
        }
      }
      if (!pageCommitAttempted) {
        await flushDispositionRepairs();
      }

      return {
        valid: true,
        connector_id: batch.connector_id,
        delivery_id: batch.delivery_id,
        records,
        ...(pageCommitted ? { page_committed: true } : {}),
      };
    } catch (error) {
      await this.authorityStore.releaseBlobReservations(pendingIngest.blob_reservations ?? []);
      if (page && (!atomic || mixedWrites) && completedRecordIndexes.size > 0) {
        const partialRecords = [...completedRecordIndexes]
          .flatMap((index) => records[index] ? [records[index]] : []);
        throw new IngestPageProcessingError(error, partialRecords);
      }
      throw error;
    }
  }

  private async ingestRecord(
    orgId: string,
    record: IngestRecord,
    dispatchPolicy?: PersonalDispatchPolicy,
  ): Promise<IngestRecordResult> {
    const policy = dispatchPolicy ?? await this.arrangement.policyFor(orgId);
    const inspected = await this.inspectRecord(orgId, record);
    if (inspected.kind === "result") {
      return inspected.result;
    }
    if (inspected.kind === "replay_needs_repair") {
      return this.replayed(inspected.record, inspected.event, policy, inspected.identity);
    }
    return this.persistInspected(inspected, policy);
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
    const overlayCanonical = overlay?.canonical(identity);
    const current =
      overlayCurrent ?? (await this.authorityStore.findBySourceIdentity(identity));

    if (
      current &&
      record.operation !== "tombstone" &&
      current.external_id !== record.external_id
    ) {
      // Channel-native id aliased to a local `:out:` Event — identity bind wins.
      return this.replayedInspected(record, current, overlayCurrent, identity);
    }

    if (record.operation === "tombstone") {
      if (current?.operation === "tombstone") {
        return this.replayedInspected(record, current, overlayCurrent, identity);
      }
      return { kind: "tombstone", identity, record, current };
    }

    const merged = await this.mergeRecordContent(record, current, overlayCanonical);
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
      return this.replayedInspected(record, current, overlayCurrent, identity);
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
      return this.replayedInspected(record, echoed, undefined, echoed);
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
      const existing = await this.existingResolution(current, overlayCanonical);
      const incoming = resolutionFromCanonical(canonical);
      if (incomingWorsensAttachments(existing, incoming)) {
        return this.replayedInspected(record, current, overlayCurrent, identity);
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
          return this.replayedInspected(record, current, overlayCurrent, identity);
        }
        if (await this.sameBodySurfaceCorrection(current, merged, overlayCanonical)) {
          return {
            kind: "revise",
            identity,
            record: {
              ...merged,
              operation: "revise",
              revision_id: merged.revision_id ?? "surface-correction",
            },
            canonical,
            current,
          };
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
    pendingCanonical?: CanonicalContent,
  ): Promise<IngestRecord> {
    if (!current || !record.content) {
      return record;
    }
    const stored = await this.readEventBytes(current, pendingCanonical);
    const pendingBlobs = new Map(
      pendingCanonical?.blobs.map((blob) => [blob.hash, blob.bytes]) ?? [],
    );
    const content = await preserveResolvedAttachments(
      record.content,
      stored?.bytes,
      stored?.mediaType,
      async (hash) => {
        try {
          return pendingBlobs.get(hash) ?? await this.blobStore.get(hash);
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
    identity?: SourceIdentity,
  ): Promise<InspectedRecord> {
    if (!overlayCurrent && !(await this.authorityStore.getDisposition(event.id))) {
      return { kind: "replay_needs_repair", record, event, identity };
    }
    return {
      kind: "result",
      result: duplicateResult(record, event),
    };
  }

  private async persistBlobsWithReservations(
    blobs: readonly BlobObject[],
    alreadyReserved: readonly BlobReservation[] = [],
  ): Promise<BlobReservation[]> {
    const existing = new Set(alreadyReserved.map((reservation) => reservation.content_hash));
    const unique = new Map<string, BlobObject>();
    for (const blob of blobs) {
      if (!existing.has(blob.hash)) unique.set(blob.hash, blob);
    }
    if (unique.size === 0) return [];

    const items = [...unique.values()];
    const reserveInput: ReserveBlobWritesInput = {
      owner_id: randomUUID(),
      lease_duration_ms: IngestionService.BLOB_WRITE_LEASE_MS,
      blobs: items.map((blob) => ({
        content_hash: blob.hash,
        media_type: blob.mediaType,
        byte_size: blob.bytes.byteLength,
      })),
    };
    const reservations = await this.authorityStore.reserveBlobWrites(reserveInput);
    const byHash = new Map(items.map((blob) => [blob.hash, blob]));
    const completed = new Map(reservations.map((reservation) => [
      reservation.content_hash,
      reservation,
    ]));
    try {
      for (const reservation of reservations) {
        const blob = byHash.get(reservation.content_hash);
        if (!blob) throw new Error("Authority reserved an unrequested Blob");
        if (reservation.mode === "write") {
          await this.blobStore.putFenced(
            blob.hash,
            blob.bytes,
            blob.mediaType,
            reservation.generation,
          );
          continue;
        }

        if (await this.blobStore.exists(blob.hash)) {
          const stored = await this.blobStore.get(blob.hash);
          if (!Buffer.from(stored).equals(Buffer.from(blob.bytes))) {
            throw new Error(`Stored Blob bytes do not match reserved content: ${blob.hash}`);
          }
          continue;
        }

        const [repair] = await this.authorityStore.reserveBlobWrites({
          ...reserveInput,
          blobs: reserveInput.blobs.filter((item) => item.content_hash === blob.hash),
          force_write_hashes: [blob.hash],
        });
        if (!repair || repair.mode !== "write") {
          throw new Error(`Missing Blob could not be claimed for repair: ${blob.hash}`);
        }
        completed.set(blob.hash, repair);
        await this.blobStore.putFenced(
          blob.hash,
          blob.bytes,
          blob.mediaType,
          repair.generation,
        );
      }
      return [...completed.values()];
    } catch (error) {
      await this.authorityStore.releaseBlobReservations([...completed.values()]);
      throw error;
    }
  }

  private async commitCreates(
    creates: PlannedCreate[],
    records: IngestRecordResult[],
    dispatchPolicy: PersonalDispatchPolicy,
    markCompleted: (index: number) => void,
    markResolvedDuplicates: (items: readonly PlannedEvent[]) => void,
  ): Promise<void> {
    const blobs = new Map<string, BlobObject>();
    for (const item of creates) {
      for (const blob of blobsForCanonical(item.canonical)) {
        if (!blobs.has(blob.hash)) {
          blobs.set(blob.hash, blob);
        }
      }
    }
    const blobReservations = await this.persistBlobsWithReservations([...blobs.values()]);

    const appends: NewEvent[] = creates.map((item) => ({
      id: item.eventId,
      ...item.identity,
      ...eventContextMetadata(item.record),
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
        undefined,
        dispatchPolicy,
      ),
    );

    try {
      const request: IngestCommitRequest = {
        appends,
        dispositions,
        blob_reservations: blobReservations,
      };
      const effects = await this.prepareConversationEffects(creates, dispositions);
      const events = await this.authorityStore.commitConversationIntake({
        ingest: request,
        ...effects,
      });
      for (const [index, item] of creates.entries()) {
        const event = events[index];
        if (!event) throw new Error("Atomic ingestion did not return its created event");
        records[item.index] = {
          external_id: item.record.external_id,
          status: "accepted",
          event_id: event.id,
        };
        markCompleted(item.index);
      }
    } catch (error) {
      await this.authorityStore.releaseBlobReservations(blobReservations);
      if (error instanceof AuthorityConflictError) {
        throw error;
      }
      throw error;
    }
    reconcilePendingDuplicates(records, creates);
    markResolvedDuplicates(creates);
  }

  private async prepareConversationEffects(
    items: readonly PlannedConversationEffect[],
    dispositions: readonly import("./arrangement").ArrangementDecision[],
  ): Promise<{
    work_observations: WorkItemObservation[];
    visibility: ConversationPolicyVisibility[];
  }> {
    const decisions = new Map(dispositions.map((decision) => [decision.event_id, decision]));
    const decidedItems = items.filter((item) => decisions.has(item.eventId));
    const candidates = decidedItems.filter((item) => {
      const decision = decisions.get(item.eventId);
      return item.kind !== "tombstone"
        && item.kind !== "create_after_tombstone"
        && !(item.kind === "replay" && item.event.operation === "tombstone")
        && Boolean(decision && isPushInboxDecision(decision));
    });
    const work_observations: WorkItemObservation[] = [];
    if (candidates.length > 0) {
      const orgId = candidates[0].identity.org_id;
      const [recipes, hiddenIds] = await Promise.all([
        this.authorityStore.listRecipes(orgId),
        this.authorityStore.listHiddenExecutorThreadIds(orgId),
      ]);
      const hidden = new Set(hiddenIds);
      const foreground = new Map<string, WorkItem | null>();
      for (const planned of candidates) {
        const event = planned.kind === "replay" ? planned.event : previewPlannedEvent(planned);
        const threadId = event.thread_id ?? conversationId(event.source, event.external_id, event.id);
        if (hidden.has(threadId)) continue;
        const surface = surfaceFromParts(planned.record.content ?? []);
        if (!shouldAcceptPushRecord({
          kind: surface?.kind,
          direction: surface?.direction,
          external_id: planned.record.external_id,
          type: surface?.type ?? planned.record.type,
        })) continue;

        let existing = foreground.get(threadId);
        if (existing === undefined) {
          existing = await this.authorityStore.getWorkItemByThread(orgId, threadId);
          // Scheduled and manual work without a message anchor must not absorb new intake.
          if (existing && !existing.head_event_id) existing = null;
        }
        const bodyText = planned.record.content?.find((part) =>
          part.role === "body" && part.text !== undefined,
        )?.text;
        const pref = await this.authorityStore.getConversationPref(orgId, threadId);
        const subject = workSubjectFromEvent({
          type: surface?.type ?? planned.record.type,
          source: planned.identity.source,
          thread_id: threadId,
          unit_kind: surface?.unit_kind,
          body_text: bodyText,
          title: recipeConversationTitle({
            customTitle: pref?.title,
            conversationLabel: surface?.conversation_label,
          }),
          prompts: false,
          hint: surface?.thread_facet,
          prior_facet: existing && isActiveWorkStatus(existing.status)
            ? existing.thread_facet
            : undefined,
        });
        if (!subject) continue;
        const recipe = selectRecipeForSubject(recipes, subject);
        if (decisions.get(planned.eventId)?.disposition === "pending"
          && (subject.record_class !== "utterance" || !recipe || !recipeAllowsPushDispatch(recipe))) {
          continue;
        }
        if (await this.authorityStore.getWorkItemByUnitKey(orgId, threadId, planned.eventId)) {
          continue;
        }

        let reusable = existing;
        if (
          reusable &&
          !isOccupiedRecipeSlot(reusable.status) &&
          reusable.head_event_id !== planned.eventId &&
          recipe?.trigger.kind === "push" &&
          (recipe.match.text_contains || recipe.match.text_excludes)
        ) {
          const previous = reusable.head_event_id
            ? await this.authorityStore.getEvent(orgId, reusable.head_event_id)
            : null;
          const previousText = previous?.content_hash
            ? bodyTextFromStored(
              await this.blobStore.get(previous.content_hash),
              CONTENT_PARTS_MEDIA_TYPE,
            )
            : undefined;
          if (!recipeTextMatches(recipe.match, previousText)) reusable = null;
        }
        const next = openOrUpdateWorkItem({
          existing: reusable,
          org_id: orgId,
          subject,
          head_event_id: planned.eventId,
          recipe,
          now: new Date().toISOString(),
        });
        if (!next || next === reusable) continue;
        work_observations.push({ expected_item: reusable ?? null, item: next });
        foreground.set(threadId, next);
      }
    }

    const visibilityEvents = decidedItems.map((item) =>
      item.kind === "replay" ? item.event : previewPlannedEvent(item),
    );
    const visibility = visibilityEvents.length === 0
      ? []
      : await collectListSurfacePatches(
        this.authorityStore,
        visibilityEvents[0].org_id,
        visibilityEvents.map((event) => event.id),
        {
          events: visibilityEvents,
          dispositions,
          now: new Date().toISOString(),
        },
      );
    return { work_observations, visibility };
  }

  private async commitDispositionRepairs(
    repairs: NonNullable<CommitSyncPage["disposition_repairs"]>,
    effects: {
      work_observations: WorkItemObservation[];
      visibility: ConversationPolicyVisibility[];
    },
  ): Promise<void> {
    try {
      await this.authorityStore.commitConversationIntake({
        ingest: { appends: [], dispositions: [] },
        disposition_repairs: repairs,
        ...effects,
      });
    } catch (error) {
      if (!(error instanceof DispositionRepairConflictError)) throw error;
    }
  }

  private async bufferPlannedEvents(
    items: PlannedEvent[],
    records: IngestRecordResult[],
    pendingIngest: IngestCommitRequest,
    bufferedEvents: PlannedEvent[],
    dispatchPolicy: PersonalDispatchPolicy,
  ): Promise<void> {
    const blobs = new Map<string, BlobObject>();
    for (const item of items) {
      if (item.kind === "tombstone") continue;
      for (const blob of blobsForCanonical(item.canonical)) {
        if (!blobs.has(blob.hash)) {
          blobs.set(blob.hash, blob);
        }
      }
    }
    const reservations = await this.persistBlobsWithReservations(
      [...blobs.values()],
      pendingIngest.blob_reservations,
    );
    pendingIngest.blob_reservations?.push(...reservations);
    for (const item of items) {
      if (item.kind === "tombstone") {
        pendingIngest.appends.push({
          id: item.eventId,
          ...item.identity,
          ...eventContextMetadata(item.record),
          operation: "tombstone",
          occurred_at: item.record.occurred_at,
          expected_head_id: item.current?.id ?? null,
          ...(item.current?.id ? { parent_event_id: item.current.id } : {}),
        });
      } else if (item.kind === "create_after_tombstone") {
        pendingIngest.appends.push({
          id: item.precedingEventId,
          ...item.identity,
          ...eventContextMetadata(item.record),
          content_hash: item.canonical.hash,
          content_media_type: item.canonical.media_type,
          content_byte_size: item.canonical.bytes.byteLength,
          extra_blobs: extraBlobsForCanonical(item.canonical),
          occurred_at: item.record.occurred_at,
          expected_head_id: item.current.id,
        });
        pendingIngest.appends.push({
          id: item.eventId,
          ...item.identity,
          ...eventContextMetadata(item.record),
          operation: "tombstone",
          parent_event_id: item.precedingEventId,
          content_hash: item.canonical.hash,
          content_media_type: item.canonical.media_type,
          content_byte_size: item.canonical.bytes.byteLength,
          extra_blobs: extraBlobsForCanonical(item.canonical),
          occurred_at: item.current.occurred_at,
          expected_head_id: item.precedingEventId,
        });
      } else {
        pendingIngest.appends.push({
          id: item.eventId,
          ...item.identity,
          ...eventContextMetadata(item.record),
          content_hash: item.canonical.hash,
          content_media_type: item.canonical.media_type,
          content_byte_size: item.canonical.bytes.byteLength,
          extra_blobs: extraBlobsForCanonical(item.canonical),
          occurred_at: item.record.occurred_at,
          expected_head_id: item.kind === "revise" ? item.current.id : null,
          ...(item.kind === "revise" ? {
            operation: "revise" as const,
            parent_event_id: item.current.id,
            revision_id: item.record.revision_id,
          } : {}),
        });
      }
      pendingIngest.dispositions.push(
        this.arrangement.decide(
          previewPlannedEvent(item),
          item.record,
          undefined,
          dispatchPolicy,
        ),
      );
      bufferedEvents.push(item);
      records[item.index] = {
        external_id: item.record.external_id,
        status: "accepted",
        event_id: item.eventId,
      };
    }
  }

  private async commitPreparedPage(
    page: SyncPageCommit,
    pendingIngest: IngestCommitRequest,
    records: IngestRecordResult[],
    bufferedEvents: PlannedEvent[],
    effects: {
      work_observations: WorkItemObservation[];
      visibility: ConversationPolicyVisibility[];
    },
    store: ConnectorRuntimeStore,
    dispositionRepairs: NonNullable<CommitSyncPage["disposition_repairs"]>,
  ): Promise<boolean> {
    const ingest =
      pendingIngest.appends.length === 0 &&
      pendingIngest.dispositions.length === 0
        ? undefined
        : pendingIngest;
    try {
      await store.commitSyncPage({
        attempt: page.attempt,
        ingest,
        ...(dispositionRepairs.length > 0
          ? { disposition_repairs: dispositionRepairs }
          : {}),
        work_observations: effects.work_observations,
        settle: {
          ...page.settle,
          attempt_id: page.attempt.id,
          ...ingestAttemptSummary(records),
          quarantines: ingestAttemptQuarantines(
            records,
            page.settle.finished_at,
            () => randomUUID(),
          ),
        },
        ...(effects.visibility.length > 0 ? { prefs: effects.visibility } : {}),
      });
      return true;
    } catch (error) {
      await this.authorityStore.releaseBlobReservations(
        pendingIngest.blob_reservations ?? [],
      );
      throw error;
    }
  }

  private async persistInspected(
    inspected: Exclude<InspectedRecord, { kind: "result" | "replay_needs_repair" }>,
    dispatchPolicy: PersonalDispatchPolicy,
  ): Promise<IngestRecordResult> {
    if (inspected.kind === "tombstone") {
      return this.ingestTombstone(
        inspected.identity,
        inspected.record,
        inspected.current,
        dispatchPolicy,
      );
    }

    const blobReservations = await this.persistBlobsWithReservations(
      blobsForCanonical(inspected.canonical),
    );
    const extraBlobs = extraBlobsForCanonical(inspected.canonical);

    try {
      if (inspected.kind === "create") {
        const eventId = randomUUID();
        const previewEvent = previewCreate(
          eventId,
          inspected.identity,
          inspected.record,
          inspected.canonical,
        );
        const disposition = this.arrangement.decide(
          previewEvent,
          inspected.record,
          undefined,
          dispatchPolicy,
        );
        const request: IngestCommitRequest = {
          appends: [{
            id: eventId,
            ...inspected.identity,
            ...eventContextMetadata(inspected.record),
            content_hash: inspected.canonical.hash,
            content_media_type: inspected.canonical.media_type,
            content_byte_size: inspected.canonical.bytes.byteLength,
            extra_blobs: extraBlobs,
            occurred_at: inspected.record.occurred_at,
            expected_head_id: null,
          }],
          dispositions: [disposition],
          blob_reservations: blobReservations,
        };
        const effects = await this.prepareConversationEffects([{
          kind: "create",
          index: 0,
          eventId,
          identity: inspected.identity,
          record: inspected.record,
          canonical: inspected.canonical,
        }], [disposition]);
        const [event] = await this.authorityStore.commitConversationIntake({
          ingest: request,
          ...effects,
        });
        if (!event) {
          throw new Error("Atomic ingestion did not return its created event");
        }
        return this.accepted(inspected.record, event);
      }

      if (inspected.kind === "create_after_tombstone") {
        const eventId = randomUUID();
        const tombstoneId = randomUUID();
        const eventInput = {
          id: eventId,
          ...inspected.identity,
          ...eventContextMetadata(inspected.record),
          content_hash: inspected.canonical.hash,
          content_media_type: inspected.canonical.media_type,
          content_byte_size: inspected.canonical.bytes.byteLength,
          extra_blobs: extraBlobs,
          occurred_at: inspected.record.occurred_at,
          expected_head_id: inspected.current.id,
        };
        const tombstonePreview: EventRecord = {
          ...previewCreate(
            tombstoneId,
            inspected.identity,
            inspected.record,
            inspected.canonical,
          ),
          operation: "tombstone",
          parent_event_id: eventId,
          occurred_at: inspected.current.occurred_at,
        };
        const disposition = this.arrangement.decide(
          tombstonePreview,
          inspected.record,
          undefined,
          dispatchPolicy,
        );
        const request: IngestCommitRequest = {
          appends: [
            eventInput,
            {
              ...eventInput,
              id: tombstoneId,
              operation: "tombstone",
              parent_event_id: eventId,
              occurred_at: inspected.current.occurred_at,
              expected_head_id: eventId,
            },
          ],
          dispositions: [disposition],
          blob_reservations: blobReservations,
        };
        const effects = await this.prepareConversationEffects([{
          kind: "tombstone",
          index: 0,
          eventId: tombstoneId,
          identity: inspected.identity,
          record: inspected.record,
          current: inspected.current,
        }], [disposition]);
        const events = await this.authorityStore.commitConversationIntake({
          ingest: request,
          ...effects,
        });
        const tombstone = events[1];
        if (!tombstone) {
          throw new Error("Atomic tombstone recreation did not return its final event");
        }
        return this.accepted(inspected.record, tombstone);
      }

      if (inspected.kind === "revise") {
        const eventId = randomUUID();
        const previewEvent = {
          ...previewCreate(
            eventId,
            inspected.identity,
            inspected.record,
            inspected.canonical,
          ),
          operation: "revise" as const,
          parent_event_id: inspected.current.id,
        };
        const disposition = this.arrangement.decide(
          previewEvent,
          inspected.record,
          undefined,
          dispatchPolicy,
        );
        const request: IngestCommitRequest = {
          appends: [{
            id: eventId,
            ...inspected.identity,
            ...eventContextMetadata(inspected.record),
            operation: "revise",
            content_hash: inspected.canonical.hash,
            content_media_type: inspected.canonical.media_type,
            content_byte_size: inspected.canonical.bytes.byteLength,
            extra_blobs: extraBlobs,
            occurred_at: inspected.record.occurred_at,
            expected_head_id: inspected.current.id,
            parent_event_id: inspected.current.id,
            revision_id: inspected.record.revision_id,
          }],
          dispositions: [disposition],
          blob_reservations: blobReservations,
        };
        const effects = await this.prepareConversationEffects([{
          kind: "revise",
          index: 0,
          eventId,
          identity: inspected.identity,
          record: inspected.record,
          canonical: inspected.canonical,
          current: inspected.current,
          originalRecord: inspected.record,
        }], [disposition]);
        const [event] = await this.authorityStore.commitConversationIntake({
          ingest: request,
          ...effects,
        });
        if (!event) throw new Error("Atomic ingestion did not return its revised event");
        return this.accepted(inspected.record, event);
      }

      throw new Error("Unsupported inspected ingestion transition");
    } catch (error) {
      await this.authorityStore.releaseBlobReservations(blobReservations);
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
    dispatchPolicy: PersonalDispatchPolicy,
  ): Promise<IngestRecordResult> {
    if (current?.operation === "tombstone") {
      return this.replayed(record, current, dispatchPolicy);
    }

    try {
      const eventId = randomUUID();
      const previewEvent = previewTombstone(eventId, identity, record, current);
      const disposition = this.arrangement.decide(
        previewEvent,
        record,
        undefined,
        dispatchPolicy,
      );
      const effects = await this.prepareConversationEffects([{
        kind: "tombstone",
        index: 0,
        eventId,
        identity,
        record,
        current,
      }], [disposition]);
      const [event] = await this.authorityStore.commitConversationIntake({
        ingest: {
          appends: [{
            id: eventId,
            ...identity,
            ...eventContextMetadata(record),
            operation: "tombstone",
            occurred_at: record.occurred_at,
            expected_head_id: current?.id ?? null,
          }],
          dispositions: [disposition],
        },
        ...effects,
      });
      if (!event) throw new Error("Atomic ingestion did not return its tombstone");
      return this.accepted(record, event);
    } catch (error) {
      if (error instanceof AuthorityConflictError) {
        return this.concurrentUpdate(record);
      }
      throw error;
    }
  }

  private accepted(
    record: IngestRecord,
    event: EventRecord,
  ): IngestRecordResult {
    return {
      external_id: record.external_id,
      status: "accepted",
      event_id: event.id,
    };
  }

  private async replayed(
    record: IngestRecord,
    event: EventRecord,
    dispatchPolicy: PersonalDispatchPolicy,
    identity: SourceIdentity = {
      org_id: event.org_id,
      source: event.source,
      external_id: event.external_id,
    },
  ): Promise<IngestRecordResult> {
    if (!(await this.authorityStore.getDisposition(event.id))) {
      const decision = this.arrangement.decide(event, record, undefined, dispatchPolicy);
      const repair = { identities: [identity], decision };
      const planned: PlannedReplay = {
        kind: "replay",
        index: 0,
        eventId: event.id,
        identity: {
          org_id: event.org_id,
          source: event.source,
          external_id: event.external_id,
        },
        record,
        event,
      };
      const effects = await this.prepareConversationEffects([planned], [decision]);
      await this.commitDispositionRepairs([repair], effects);
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
        if (!existing || normalizeUtterance(existing) !== needle.text) {
          continue;
        }
        const existingAttachments = await this.readEventAttachments(event);
        if (echoAttachmentsAgree(needle.attachments, existingAttachments)) {
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

  private async readEventText(
    event: EventRecord,
    pendingCanonical?: CanonicalContent,
  ): Promise<string | undefined> {
    const stored = await this.readEventBytes(event, pendingCanonical);
    if (!stored) {
      return undefined;
    }
    try {
      return bodyTextFromStored(stored.bytes, stored.mediaType);
    } catch {
      return undefined;
    }
  }

  private async sameBodySurfaceCorrection(
    current: EventRecord,
    incoming: IngestRecord,
    pendingCanonical?: CanonicalContent,
  ): Promise<boolean> {
    const incomingText = normalizeUtterance(recordBodyText(incoming));
    if (!incomingText) {
      return false;
    }
    const existingText = normalizeUtterance(
      await this.readEventText(current, pendingCanonical),
    );
    return incomingText === existingText;
  }

  private async existingResolution(
    event: EventRecord,
    pendingCanonical?: CanonicalContent,
  ): Promise<AttachmentResolution> {
    if (pendingCanonical) {
      return resolutionFromCanonical(pendingCanonical);
    }
    const stored = await this.readEventBytes(event, pendingCanonical);
    if (!stored) {
      return { resolvedHashes: [], unresolvedCount: 0 };
    }
    if (stored.mediaType !== CONTENT_PARTS_MEDIA_TYPE) {
      return resolutionFromStored(stored.bytes, stored.mediaType);
    }
    const parts = parseStoredContentParts(stored.bytes);
    const sidecars = parts
      ? await collectAvailableBlobs(
          (hash) => this.blobStore.get(hash),
          attachmentHashesFromStoredParts(parts),
        )
      : undefined;
    return resolutionFromStored(stored.bytes, stored.mediaType, sidecars);
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
    pendingCanonical?: CanonicalContent,
  ): Promise<{ bytes: Uint8Array; mediaType: string } | undefined> {
    if (pendingCanonical) {
      return { bytes: pendingCanonical.bytes, mediaType: pendingCanonical.media_type };
    }
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

function reconcilePendingDuplicates(
  records: IngestRecordResult[],
  items: readonly PlannedEvent[],
): void {
  const changed = new Map<string, IngestRecordResult>();
  for (const item of items) {
    const resolved = records[item.index];
    if (!resolved) throw new Error("Pending ingestion has no result");
    if ((resolved.status === "accepted" || resolved.status === "duplicate") && !resolved.event_id) {
      throw new Error("Successful ingestion has no event ID");
    }
    if (resolved.event_id !== item.eventId) changed.set(item.eventId, resolved);
  }
  if (changed.size === 0) return;
  for (const [index, record] of records.entries()) {
    if (!record || record.status !== "duplicate" || !record.event_id) continue;
    const resolved = changed.get(record.event_id);
    if (!resolved) continue;
    records[index] = resolved.status === "accepted" || resolved.status === "duplicate"
      ? { ...record, event_id: resolved.event_id }
      : { ...resolved, external_id: record.external_id };
  }
}

class PendingIngestOverlay {
  private readonly byKey = new Map<string, EventRecord>();
  private readonly canonicalByKey = new Map<string, CanonicalContent>();
  private readonly pending: Array<{ event: EventRecord; record: IngestRecord }> =
    [];

  current(identity: SourceIdentity): EventRecord | undefined {
    return this.byKey.get(identityKey(identity));
  }

  clear(): void {
    this.byKey.clear();
    this.canonicalByKey.clear();
    this.pending.length = 0;
  }

  rememberCreate(
    identity: SourceIdentity,
    event: EventRecord,
    record: IngestRecord,
    canonical: CanonicalContent,
  ): void {
    this.rememberCurrent(identity, event, record, canonical);
  }

  rememberCurrent(
    identity: SourceIdentity,
    event: EventRecord,
    record: IngestRecord,
    canonical?: CanonicalContent,
  ): void {
    this.byKey.set(identityKey(identity), event);
    const key = identityKey(identity);
    if (canonical) {
      this.canonicalByKey.set(key, canonical);
    } else {
      this.canonicalByKey.delete(key);
    }
    this.pending.push({ event, record });
  }

  canonical(identity: SourceIdentity): CanonicalContent | undefined {
    return this.canonicalByKey.get(identityKey(identity));
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
        if (!existing || existing !== needle.text) {
          continue;
        }
        if (
          echoAttachmentsAgree(
            needle.attachments,
            attachmentDigestsFromParts(item.record.content ?? []),
          )
        ) {
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

function previewPlannedEvent(item: PlannedEvent): EventRecord {
  if (item.kind === "tombstone") {
    return previewTombstone(item.eventId, item.identity, item.record, item.current);
  }
  if (item.kind === "create_after_tombstone") {
    return {
      ...previewCreate(item.eventId, item.identity, item.record, item.canonical),
      operation: "tombstone",
      parent_event_id: item.precedingEventId,
      occurred_at: item.current.occurred_at,
    };
  }
  const event = previewCreate(item.eventId, item.identity, item.record, item.canonical);
  return item.kind === "revise"
    ? { ...event, operation: "revise", parent_event_id: item.current.id }
    : event;
}

function previewPlannedEvents(item: PlannedEvent): EventRecord[] {
  if (item.kind !== "create_after_tombstone") {
    return [previewPlannedEvent(item)];
  }
  return [
    previewCreate(item.precedingEventId, item.identity, item.record, item.canonical),
    previewPlannedEvent(item),
  ];
}

function previewTombstone(
  eventId: string,
  identity: SourceIdentity,
  record: IngestRecord,
  current: EventRecord | null,
): EventRecord {
  return {
    id: eventId,
    ...identity,
    operation: "tombstone",
    ...(current?.content_hash ? { content_hash: current.content_hash } : {}),
    ...(current?.id ? { parent_event_id: current.id } : {}),
    ...eventContextMetadata(record),
    occurred_at: record.occurred_at,
    ingested_at: record.occurred_at,
  };
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
    ...eventContextMetadata(record),
    occurred_at: record.occurred_at,
    ingested_at: record.occurred_at,
  };
}

function eventContextMetadata(
  record: IngestRecord,
): Pick<NewEvent, "thread_id" | "actor_id" | "required_scope_ids" | "direction_tags" | "weight_hints" | "attrs"> {
  const attrs = {
    ...(record.attrs ? structuredClone(record.attrs) : {}),
    ...(record.thread?.id ? { native_thread_id: record.thread.id } : {}),
    ...(record.parent_external_id ? { parent_external_id: record.parent_external_id } : {}),
  };
  return {
    thread_id: conversationId(record.source, record.external_id),
    actor_id: record.actor.id,
    required_scope_ids: [
      threadIdOf({ source: record.source, target: record.scope.id }),
    ],
    ...(record.direction_tags ? { direction_tags: [...new Set(record.direction_tags)].sort() } : {}),
    ...(record.weight_hints ? { weight_hints: structuredClone(record.weight_hints) } : {}),
    ...(Object.keys(attrs).length ? { attrs } : {}),
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

function echoAttachmentsAgree(
  incoming: readonly string[],
  existing: readonly string[],
): boolean {
  // Text-only history against a captioned outbound (or text-only both sides).
  if (incoming.length === 0) {
    return true;
  }
  // Same text with attachments: require digests to be covered by outbound.
  return attachmentsCoveredBy(incoming, existing);
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
