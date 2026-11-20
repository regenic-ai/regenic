import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import {
  assertInboxDispositionTransition,
  sameInboxDispositionCommand,
  sameDispositionContent,
  type ArrangementDecision,
  type InboxDispositionCommand,
  type InboxDispositionTransition,
  type InboxDispositionTransitionResult,
  type InboxItem,
} from "./arrangement";
import { rankConversationDirectory } from "./conversation-directory";
import type {
  ConversationDirectoryEntry,
  ConversationDirectoryQuery,
} from "./conversation-directory";
import type {
  AuthorityStore,
  BlobReservation,
  BlobInventoryRecord,
  BlobInventoryPage,
  BlobInventoryPageQuery,
  BlobObject,
  BlobStoreEntry,
  BlobRecord,
  FencedBlobStore,
  ConversationPref,
  ConversationPrefPatch,
  ConversationPolicyFold,
  ConversationPolicyFoldResult,
  ConversationPolicyVisibility,
  ConversationVisibilityUpdate,
  ConversationVisibilityUpdateResult,
  EventListQuery,
  EventAttachmentReferenceBackfill,
  EventRecord,
  EventRevision,
  InboxQuery,
  InboxSummary,
  CommitSyncPage,
  CommitSyncPageResult,
  ConversationIntakeCommit,
  IngestAppend,
  IngestCommitRequest,
  NewEvent,
  NewOutboundAttempt,
  OutboundAttemptPut,
  OutboundAttemptRecord,
  RepointContentInput,
  ReserveBlobWritesInput,
  SourceIdentity,
  SourceIdentityAliasBind,
  StoreClearResult,
  StoreFootprint,
  TombstoneEvent,
} from "./ingestion";
import { MemoryWorkStore } from "./memory-work-store";
import { type WorkRunStartClaim, type WorkStore } from "./work";
import type { Recipe, WorkItem, WorkRun } from "./work";
import type { WorkAcknowledgment } from "./work-transition";
import {
  assertBlobInventoryPageQuery,
} from "./ingestion";
import {
  AuthorityConflictError,
  DispositionRepairConflictError,
  BlobGenerationConflictError,
  BlobReservationConflictError,
  assertConversationPolicyVisibility,
  assertEventDispositionBinding,
  assertIngestDispositionBindings,
  assertSyncPageAttemptBinding,
  assertDispositionRepairs,
  collectAvailableBlobs,
  conversationVisibilityCommand,
  mergeConversationReadCursor,
  putUniqueBlobs,
  sameConversationVisibilityCommand,
} from "./ingestion";
import {
  eventThreadId,
  headsScanQuery,
  isPushInboxDecision,
  isWorkTriggerDecision,
  isFinishedWorkTriggerDecision,
  matchesEventQuery,
  selectInboxItems,
  summarizeInboxItems,
} from "./inbox-query";
import { normalizeInboxListView } from "./list-surface";

function sourceKey(identity: SourceIdentity): string {
  return JSON.stringify([identity.org_id, identity.source, identity.external_id]);
}

export class MemoryBlobStore implements FencedBlobStore {
  private readonly blobs = new Map<
    string,
    { bytes: Uint8Array; media_type: string }
  >();
  private readonly generations = new Map<
    string,
    { generation: number; state: "ready" | "deleted" }
  >();

  async put(
    hash: string,
    bytes: Uint8Array,
    mediaType: string,
  ): Promise<void> {
    this.assertBlobHash(hash, bytes);
    const generation = this.generations.get(hash);
    if (generation) {
      throw new BlobGenerationConflictError(hash, 0, generation.generation);
    }
    if (!this.blobs.has(hash)) {
      this.blobs.set(hash, {
        bytes: new Uint8Array(bytes),
        media_type: mediaType,
      });
    }
  }
  async putMany(items: readonly BlobObject[]): Promise<void> {
    await putUniqueBlobs(
      (hash, bytes, mediaType) => this.put(hash, bytes, mediaType),
      items,
    );
  }

  async *enumerate(): AsyncIterable<BlobStoreEntry> {
    for (const [hash, blob] of [...this.blobs.entries()].sort(([left], [right]) =>
      left.localeCompare(right))) {
      if (this.generations.get(hash)?.state === "deleted") continue;
      yield { hash, byte_size: blob.bytes.byteLength };
    }
  }

  async putFenced(
    hash: string,
    bytes: Uint8Array,
    mediaType: string,
    generation: number,
  ): Promise<void> {
    this.assertBlobHash(hash, bytes);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error("Blob generation must be a positive safe integer");
    }
    const current = this.generations.get(hash);
    if (current && (
      generation < current.generation ||
      (generation === current.generation && current.state === "deleted")
    )) {
      throw new BlobGenerationConflictError(hash, generation, current.generation);
    }
    this.generations.set(hash, { generation, state: "ready" });
    this.blobs.set(hash, { bytes: new Uint8Array(bytes), media_type: mediaType });
  }

  async get(hash: string): Promise<Uint8Array> {
    if (this.generations.get(hash)?.state === "deleted") {
      throw new Error(`Blob not found: ${hash}`);
    }
    const blob = this.blobs.get(hash);
    if (!blob) {
      throw new Error(`Blob not found: ${hash}`);
    }

    return new Uint8Array(blob.bytes);
  }

  async getMany(hashes: readonly string[]): Promise<Map<string, Uint8Array>> {
    return collectAvailableBlobs((hash) => this.get(hash), hashes);
  }

  async delete(hash: string): Promise<void> {
    const generation = this.generations.get(hash);
    if (generation) {
      throw new BlobGenerationConflictError(hash, 0, generation.generation);
    }
    this.blobs.delete(hash);
  }

  async deleteFenced(hash: string, generation: number): Promise<void> {
    const current = this.generations.get(hash);
    if (current && generation < current.generation) {
      throw new BlobGenerationConflictError(hash, generation, current.generation);
    }
    if (current && generation === current.generation && current.state !== "deleted") {
      throw new BlobGenerationConflictError(hash, generation, current.generation);
    }
    this.generations.set(hash, { generation, state: "deleted" });
    this.blobs.delete(hash);
  }

  async exists(hash: string): Promise<boolean> {
    return this.generations.get(hash)?.state !== "deleted" && this.blobs.has(hash);
  }

  async clear(): Promise<void> {
    this.blobs.clear();
    this.generations.clear();
  }

  get size(): number {
    return this.blobs.size;
  }

  private assertBlobHash(hash: string, bytes: Uint8Array): void {
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== hash) {
      throw new Error(`Blob hash mismatch: expected ${hash}, received ${actualHash}`);
    }
  }
}

interface MemoryBlobReservationState {
  state: "reserved" | "available" | "deleting" | "protected";
  generation: number;
  claim_token?: string;
  lease_owner?: string;
  lease_expires_at?: number;
}

function prefKey(orgId: string, threadId: string): string {
  return `${orgId}\0${threadId}`;
}

function mergeAttentionPref(
  current: ConversationPref | undefined,
  patch: ConversationPrefPatch,
): ConversationPref {
  const hidden = current?.hidden ?? false;
  return {
    org_id: patch.org_id,
    thread_id: patch.thread_id,
    title: current?.title ?? null,
    pinned: current?.pinned ?? false,
    hidden,
    hidden_reason: hidden ? current?.hidden_reason ?? null : null,
    visibility_version: current?.visibility_version ?? 0,
    ...mergeConversationReadCursor(current ?? null, patch),
    updated_at: patch.updated_at,
  };
}

function cloneDisposition(decision: ArrangementDecision): ArrangementDecision {
  return { ...decision, reason_codes: [...decision.reason_codes] };
}

function restoreMapEntries<K, V>(map: Map<K, V>, keys: Iterable<K>): () => void {
  const before = [...new Set(keys)].map((key) => [key, map.get(key)] as const);
  return () => {
    for (const [key, value] of before) {
      if (value === undefined) map.delete(key);
      else map.set(key, value);
    }
  };
}

export class MemoryAuthorityStore
  extends MemoryWorkStore
  implements AuthorityStore, WorkStore
{
  private readonly currentBySource = new Map<string, EventRecord>();
  private readonly events: EventRecord[] = [];
  private readonly blobs = new Map<string, BlobRecord>();
  private readonly backfilledAttachmentReferences = new Set<string>();
  private readonly blobReservationStates = new Map<string, MemoryBlobReservationState>();
  private readonly dispositions = new Map<string, ArrangementDecision>();
  private readonly ingestionLifecycleEvents: Array<{
    org_id: string;
    thread_id: string;
    aggregate_type: "source_event";
    aggregate_id: string;
    aggregate_version: 1;
    event_type: "current_work_changed";
    payload: {
      source: "ingestion";
      previous: { event_id: string; disposition: ArrangementDecision["disposition"] | null } | null;
      result: ArrangementDecision;
    };
  }> = [];
  private readonly currentWorkVisibilityEvents: Array<{
    org_id: string;
    thread_id: string;
    aggregate_type: "conversation";
    aggregate_id: string;
    aggregate_version: number;
    event_type: "visibility_changed";
    payload: {
      hidden: false; hidden_reason: null;
      cause: "current_work_ingested" | "current_work_disposition_changed" | "current_work_disposition_restored"
        | "current_work_visibility_reconciled";
      event_id: string;
    };
  }> = [];
  private readonly tombstoneVisibilityEvents: Array<{
    org_id: string;
    thread_id: string;
    aggregate_type: "conversation";
    aggregate_id: string;
    aggregate_version: number;
    event_type: "visibility_changed";
    payload: {
      hidden: true; hidden_reason: "policy";
      cause: "tombstone_visibility_reconciled"; event_id: string;
    };
  }> = [];
  private readonly policyVisibilityEvents: Array<{
    org_id: string;
    thread_id: string;
    aggregate_type: "conversation";
    aggregate_id: string;
    aggregate_version: number;
    event_type: "visibility_changed";
    payload: {
      hidden: boolean; hidden_reason: "policy" | null;
      cause: "policy_visibility_applied";
    };
  }> = [];
  private readonly dispositionTransitions: Array<{
    command: InboxDispositionCommand;
    previous: ArrangementDecision;
    decision: ArrangementDecision;
  }> = [];
  private readonly dispositionCommands = new Map<string, {
    command: InboxDispositionCommand;
    previous: ArrangementDecision;
    decision: ArrangementDecision;
  }>();
  private readonly prefs = new Map<string, ConversationPref>();
  private readonly visibilityCommands = new Map<
    string,
    { command: string; pref: ConversationPref }
  >();
  private readonly acknowledgmentLifecycleEvents: Array<{
    org_id: string;
    thread_id: string;
    aggregate_type: "work_item" | "source_event" | "conversation";
    aggregate_id: string;
    aggregate_version: number;
    event_type: "work_acknowledged" | "current_work_changed" | "visibility_changed";
    command_id?: string;
    dedupe_key: string;
    payload: unknown;
    occurred_at: string;
    created_at: string;
  }> = [];

  listAcknowledgmentLifecycleEvents(): typeof this.acknowledgmentLifecycleEvents {
    return structuredClone(this.acknowledgmentLifecycleEvents);
  }

  protected override conversationVisibilityVersion(orgId: string, threadId: string): number {
    return this.prefs.get(prefKey(orgId, threadId))?.visibility_version ?? 0;
  }

  protected override hasCurrentWorkEvidence(eventId: string, orgId: string, threadId: string): boolean {
    return super.hasCurrentWorkEvidence(eventId, orgId, threadId)
      && [...this.currentBySource.values()].some((event) =>
      event.id === eventId && event.org_id === orgId && eventThreadId(event) === threadId
      && event.operation !== "tombstone"
      && this.dispositions.get(event.id)?.disposition === "current_work");
  }

  protected override hasWorkTriggerEvidence(item: WorkItem, recipe?: Recipe): boolean {
    const decision = item.head_event_id ? this.dispositions.get(item.head_event_id) : undefined;
    return Boolean(decision
      && (super.hasWorkTriggerEvidence(item, recipe) || decision.disposition === "pending")
      && isWorkTriggerDecision(decision.disposition, decision.reason_codes, item, recipe)
      && [...this.currentBySource.values()].some((event) =>
        event.id === item.head_event_id && event.org_id === item.org_id
        && eventThreadId(event) === item.thread_id && event.operation !== "tombstone"));
  }

  protected override restoreAcknowledgedTriggerForManualRetry(
    input: WorkRunStartClaim,
    item: WorkItem,
  ): void {
    const eventId = item.head_event_id;
    if (!eventId || ![...this.currentBySource.values()].some((event) =>
      event.id === eventId && event.org_id === item.org_id
      && eventThreadId(event) === item.thread_id && event.operation !== "tombstone")) return;
    const previous = this.dispositions.get(eventId);
    if (previous?.org_id !== item.org_id || previous.disposition !== "outside_current_work"
      || !previous.reason_codes.includes("result_acknowledged")) return;
    const result: ArrangementDecision = {
      ...cloneDisposition(previous),
      version: (previous.version ?? 0) + 1,
      disposition: "current_work",
      reason_codes: previous.reason_codes.filter((reason) => reason !== "result_acknowledged"),
      decided_at: input.run.created_at,
    };
    this.dispositions.set(eventId, result);
    this.setCurrentWorkEvidence(eventId, true);
    this.acknowledgmentLifecycleEvents.push({
      org_id: item.org_id,
      thread_id: item.thread_id,
      aggregate_type: "source_event",
      aggregate_id: eventId,
      aggregate_version: result.version ?? 0,
      event_type: "current_work_changed",
      dedupe_key: JSON.stringify(["source_event", eventId, result.version ?? 0, "current_work_changed"]),
      payload: {
        source: "manual_retry",
        work_item_id: item.id,
        previous: cloneDisposition(previous),
        result: cloneDisposition(result),
      },
      occurred_at: input.run.created_at,
      created_at: input.run.created_at,
    });
  }

  protected override hasAcknowledgmentTrigger(input: WorkAcknowledgment, item: WorkItem | null, run?: WorkRun | null): boolean {
    if (item && !item.head_event_id && !input.trigger_event_id.trim()) return true;
    const event = this.events.find((candidate) =>
      candidate.id === input.trigger_event_id && candidate.org_id === input.expected_item.org_id);
    const decision = this.dispositions.get(input.trigger_event_id);
    return !!item && !!event
      && eventThreadId(event) === item.thread_id
      && decision?.org_id === item.org_id
      && (super.hasAcknowledgmentTrigger(input, item, run) || decision.disposition === "pending")
      && isFinishedWorkTriggerDecision(decision.disposition, decision.reason_codes, item, run ?? null);
  }

  protected override hasExternalAcknowledgmentConflict(orgId: string, commandId: string): boolean {
    const key = `${orgId}\0${commandId}`;
    return this.visibilityCommands.has(key) || this.dispositionCommands.has(key);
  }

  protected override prepareAcknowledgmentConflictEffects(input: WorkAcknowledgment): () => void {
    const patch = input.conversation_attention;
    if (!patch) return () => {};
    const key = prefKey(patch.org_id, patch.thread_id);
    const pref = mergeAttentionPref(this.prefs.get(key), patch);
    return () => this.prefs.set(key, pref);
  }

  private hasOtherCurrentWork(item: WorkItem, excludedEventId: string): boolean {
    return [...this.currentBySource.values()].some((event) =>
      event.org_id === item.org_id && event.id !== excludedEventId
      && eventThreadId(event) === item.thread_id
      && event.operation !== "tombstone"
      && this.dispositions.get(event.id)?.disposition === "current_work");
  }

  protected override prepareAcknowledgmentEffects(input: WorkAcknowledgment, item: WorkItem): () => void {
    if (!input.trigger_event_id.trim()) {
      const key = prefKey(item.org_id, item.thread_id);
      const currentPref = this.prefs.get(key);
      const attentionPref = input.conversation_attention
        ? mergeAttentionPref(currentPref, input.conversation_attention)
        : undefined;
      const pref = attentionPref ?? currentPref;
      const visibilityVersion = pref?.visibility_version ?? 0;
      const shouldFold = !this.hasOtherCurrentWork(item, input.trigger_event_id)
        && !this.hasUnsettledWorkForThread(item.org_id, item.thread_id, item)
        && visibilityVersion === (item.visibility_intent_version ?? 0)
        && !(pref?.hidden === true && pref.hidden_reason !== "policy");
      const folded: ConversationPref | undefined = shouldFold ? {
        org_id: item.org_id, thread_id: item.thread_id,
        title: pref?.title ?? null, pinned: pref?.pinned ?? false,
        hidden: true, hidden_reason: "policy", visibility_version: visibilityVersion,
        last_read_at: pref?.last_read_at ?? null,
        last_read_external_id: pref?.last_read_external_id ?? null,
        updated_at: input.now,
      } : undefined;
      const version = item.version ?? 0;
      const eventBase = {
        org_id: item.org_id, thread_id: item.thread_id,
        occurred_at: input.issued_at, created_at: input.now,
      };
      const lifecycleEvents: typeof this.acknowledgmentLifecycleEvents = [
        ...(folded ? [{
          ...eventBase, aggregate_type: "conversation" as const, aggregate_id: item.thread_id,
          aggregate_version: visibilityVersion, event_type: "visibility_changed" as const,
          dedupe_key: JSON.stringify(["conversation", item.thread_id, "policy_fold", item.id, version]),
          payload: { hidden: true, hidden_reason: "policy", cause: "result_acknowledged" },
        }] : []),
        {
          ...eventBase, aggregate_type: "work_item", aggregate_id: item.id,
          aggregate_version: version, event_type: "work_acknowledged", command_id: input.command_id,
          dedupe_key: JSON.stringify(["work_item", item.id, version, "work_acknowledged"]),
          payload: { command: structuredClone(input), item: structuredClone(item) },
        },
      ];
      return () => {
        if (folded) this.prefs.set(key, folded);
        else if (attentionPref) this.prefs.set(key, attentionPref);
        this.acknowledgmentLifecycleEvents.push(...lifecycleEvents);
      };
    }
    const current = this.dispositions.get(input.trigger_event_id);
    if (!current) throw new Error("Acknowledgment trigger disposition disappeared");
    const decision: ArrangementDecision = {
      ...cloneDisposition(current),
      disposition: "outside_current_work",
      reason_codes: [...new Set([...current.reason_codes, "result_acknowledged"])],
      decided_at: input.now,
      version: (current.version ?? 0) + 1,
    };
    const key = prefKey(item.org_id, item.thread_id);
    const currentPref = this.prefs.get(key);
    const attentionPref = input.conversation_attention
      ? mergeAttentionPref(currentPref, input.conversation_attention)
      : undefined;
    const pref = attentionPref ?? currentPref;
    const visibilityVersion = pref?.visibility_version ?? 0;
    const shouldFold = !this.hasOtherCurrentWork(item, input.trigger_event_id)
      && !this.hasUnsettledWorkForThread(item.org_id, item.thread_id, item)
      && visibilityVersion === (item.visibility_intent_version ?? 0)
      && !(pref?.hidden === true && pref.hidden_reason !== "policy");
    const folded: ConversationPref | undefined = shouldFold ? {
      org_id: item.org_id, thread_id: item.thread_id,
      title: pref?.title ?? null, pinned: pref?.pinned ?? false,
      hidden: true, hidden_reason: "policy", visibility_version: visibilityVersion,
      last_read_at: pref?.last_read_at ?? null,
      last_read_external_id: pref?.last_read_external_id ?? null,
      updated_at: input.now,
    } : undefined;
    const eventBase = {
      org_id: item.org_id, thread_id: item.thread_id,
      occurred_at: input.issued_at, created_at: input.now,
    };
    const version = item.version ?? 0;
    const lifecycleEvents: typeof this.acknowledgmentLifecycleEvents = [
      ...(folded ? [{
        ...eventBase, aggregate_type: "conversation" as const, aggregate_id: item.thread_id,
        aggregate_version: visibilityVersion, event_type: "visibility_changed" as const,
        dedupe_key: JSON.stringify(["conversation", item.thread_id, "policy_fold", item.id, version]),
        payload: { hidden: true, hidden_reason: "policy", cause: "result_acknowledged" },
      }] : []),
      {
        ...eventBase, aggregate_type: "source_event", aggregate_id: input.trigger_event_id,
        aggregate_version: version, event_type: "current_work_changed",
        dedupe_key: JSON.stringify(["source_event", input.trigger_event_id, version, "current_work_changed"]),
        payload: { work_item_id: item.id, disposition: "outside_current_work", reason: "result_acknowledged" },
      },
      {
        ...eventBase, aggregate_type: "work_item", aggregate_id: item.id,
        aggregate_version: version, event_type: "work_acknowledged", command_id: input.command_id,
        dedupe_key: JSON.stringify(["work_item", item.id, version, "work_acknowledged"]),
        payload: { command: structuredClone(input), item: structuredClone(item) },
      },
    ];
    return () => {
      this.dispositions.set(input.trigger_event_id, decision);
      if (folded) this.prefs.set(key, folded);
      else if (attentionPref) this.prefs.set(key, attentionPref);
      this.acknowledgmentLifecycleEvents.push(...lifecycleEvents);
    };
  }

  protected override onWorkDismissed(item: WorkItem, now: string): void {
    const key = prefKey(item.org_id, item.thread_id);
    const pref = this.prefs.get(key);
    this.setConversationPolicyVisibilityWithinTurn({
      org_id: item.org_id,
      thread_id: item.thread_id,
      hidden: true,
      expected_visibility_version: pref?.visibility_version ?? 0,
      updated_at: now,
      ...(item.head_event_id
        ? { fold_excluded_current_work_event_id: item.head_event_id }
        : {}),
    });
  }

  private readonly outboundAttempts = new Map<string, OutboundAttemptRecord>();
  private nextId = 1;

  async findBlob(contentHash: string): Promise<BlobRecord | null> {
    const blob = this.blobs.get(contentHash);
    return blob ? { ...blob } : null;
  }

  async findBlobs(
    contentHashes: readonly string[],
  ): Promise<Map<string, BlobRecord>> {
    const found = new Map<string, BlobRecord>();
    for (const hash of new Set(contentHashes.filter((item) => item.length > 0))) {
      const blob = this.blobs.get(hash);
      if (blob) {
        found.set(hash, { ...blob });
      }
    }
    return found;
  }

  async inspectBlobInventory(
    contentHashes: readonly string[],
  ): Promise<Map<string, BlobInventoryRecord>> {
    const referenced = new Map<string, number>();
    for (const event of this.events) {
      if (event.content_hash) {
        referenced.set(event.content_hash, (referenced.get(event.content_hash) ?? 0) + 1);
      }
    }
    for (const attempt of this.outboundAttempts.values()) {
      if (attempt.recovery_hash) {
        referenced.set(attempt.recovery_hash, (referenced.get(attempt.recovery_hash) ?? 0) + 1);
      }
    }
    for (const reference of this.backfilledAttachmentReferences) {
      const hash = reference.slice(reference.lastIndexOf("\0") + 1);
      referenced.set(hash, (referenced.get(hash) ?? 0) + 1);
    }
    const found = new Map<string, BlobInventoryRecord>();
    for (const hash of new Set(contentHashes.filter((item) => item.length > 0))) {
      const blob = this.blobs.get(hash);
      if (!blob) continue;
      const reservation = this.blobReservationStates.get(hash);
      found.set(hash, {
        ...blob,
        // The in-memory authority has no complete durable reference ledger.
        state: "protected",
        generation: reservation?.generation ?? 0,
        unreferenced_at: null,
        write_lease_expires_at: null,
        reference_count: referenced.get(hash) ?? 0,
      });
    }
    return found;
  }

  async listBlobInventoryPage(query: BlobInventoryPageQuery): Promise<BlobInventoryPage> {
    assertBlobInventoryPageQuery(query);
    const hashes = [...this.blobs.keys()]
      .filter((hash) => query.after_hash === undefined || hash > query.after_hash)
      .sort()
      .slice(0, query.limit + 1);
    const hasMore = hashes.length > query.limit;
    const pageHashes = hashes.slice(0, query.limit);
    const records = await this.inspectBlobInventory(pageHashes);
    const entries = pageHashes.flatMap((hash) => {
      const record = records.get(hash);
      return record ? [record] : [];
    });
    return {
      entries,
      next_after_hash: hasMore ? entries.at(-1)?.content_hash ?? null : null,
    };
  }

  async reserveBlobWrites(input: ReserveBlobWritesInput): Promise<BlobReservation[]> {
    if (!input.owner_id.trim() ||
      !Number.isSafeInteger(input.lease_duration_ms) ||
      input.lease_duration_ms < 1) {
      throw new Error("Blob reservation owner and positive lease duration are required");
    }
    const blobs = [...new Map(input.blobs.map((blob) => [blob.content_hash, blob])).values()]
      .sort((left, right) => left.content_hash.localeCompare(right.content_hash));
    const forceWrite = new Set(input.force_write_hashes ?? []);
    const now = Date.now();
    for (const blob of blobs) {
      if (!/^[a-f0-9]{64}$/.test(blob.content_hash) ||
        !Number.isSafeInteger(blob.byte_size) || blob.byte_size < 0 ||
        !blob.media_type.trim()) {
        throw new Error("Invalid Blob reservation metadata");
      }
      const state = this.blobReservationStates.get(blob.content_hash);
      if (state?.state === "deleting" ||
        (state?.claim_token && (state.lease_expires_at ?? 0) > now)) {
        throw new BlobReservationConflictError(blob.content_hash);
      }
    }
    if ([...forceWrite].some((hash) => !blobs.some((blob) => blob.content_hash === hash))) {
      throw new Error("Forced Blob writes must be included in the reservation batch");
    }
    const plans: BlobReservation[] = [];

    for (const blob of blobs) {
      let state = this.blobReservationStates.get(blob.content_hash);
      if (!state) {
        this.blobs.set(blob.content_hash, {
          content_hash: blob.content_hash,
          media_type: blob.media_type,
          byte_size: blob.byte_size,
          created_at: new Date(now).toISOString(),
        });
        state = { state: "reserved", generation: 1 };
        this.blobReservationStates.set(blob.content_hash, state);
      }

      const needsWrite = state.state === "reserved" || forceWrite.has(blob.content_hash);
      if (!needsWrite) {
        state.claim_token = undefined;
        state.lease_owner = undefined;
        state.lease_expires_at = undefined;
        plans.push({
          content_hash: blob.content_hash,
          generation: state.generation,
          mode: "reuse",
        });
        continue;
      }

      if (state.generation > 0) state.generation += 1;
      if (state.state !== "protected") state.state = "reserved";
      state.claim_token = randomUUID();
      state.lease_owner = input.owner_id;
      state.lease_expires_at = now + input.lease_duration_ms;
      plans.push({
        content_hash: blob.content_hash,
        generation: state.generation,
        mode: "write",
        claim_token: state.claim_token,
      });
    }
    return plans;
  }

  async releaseBlobReservations(
    reservations: readonly BlobReservation[],
  ): Promise<void> {
    for (const reservation of reservations) {
      if (reservation.mode !== "write") continue;
      const state = this.blobReservationStates.get(reservation.content_hash);
      if (state?.generation !== reservation.generation ||
        state.claim_token !== reservation.claim_token) continue;
      state.claim_token = undefined;
      state.lease_owner = undefined;
      state.lease_expires_at = undefined;
    }
  }

  async findBySourceIdentity(
    identity: SourceIdentity,
  ): Promise<EventRecord | null> {
    const event = this.currentBySource.get(sourceKey(identity));
    return event ? cloneEvent(event) : null;
  }

  async bindSourceIdentityAliases(input: SourceIdentityAliasBind): Promise<void> {
    const event = this.events.find(
      (item) => item.org_id === input.org_id && item.id === input.event_id,
    );
    if (!event) {
      throw new Error(`Unknown event for identity alias: ${input.event_id}`);
    }
    const aliases = input.aliases.flatMap((alias) => {
      const externalId = alias.external_id.trim();
      return alias.source.trim() && externalId
        ? [sourceKey({ org_id: input.org_id, source: alias.source, external_id: externalId })]
        : [];
    });
    if (aliases.some((key) => !this.currentBySource.has(key))
      && ![...this.currentBySource.values()].some((head) =>
        head.org_id === input.org_id && head.id === input.event_id)) {
      throw new AuthorityConflictError();
    }
    for (const key of aliases) {
      if (!this.currentBySource.has(key)) {
        this.currentBySource.set(key, event);
      }
    }
  }

  async getOutboundAttempt(
    orgId: string,
    clientRequestId: string,
  ): Promise<OutboundAttemptRecord | null> {
    const row = this.outboundAttempts.get(`${orgId}\0${clientRequestId}`);
    return row ? structuredClone(row) : null;
  }

  async claimOutboundAttempt(input: NewOutboundAttempt): Promise<boolean> {
    const key = `${input.org_id}\0${input.client_request_id}`;
    const previous = this.outboundAttempts.get(key);
    if (previous && (
      previous.status !== "rejected" || previous.thread_id !== input.thread_id ||
      previous.event_id != null || previous.receipt != null || previous.channel_message_ids != null
    )) {
      return false;
    }
    this.commitOutboundRecoveryBlob(input);
    this.outboundAttempts.set(key, {
      org_id: input.org_id,
      client_request_id: input.client_request_id,
      thread_id: input.thread_id,
      status: "pending",
      recovery_hash: input.recovery_hash,
      created_at: previous?.created_at ?? input.now,
      updated_at: input.now,
    });
    return true;
  }

  async putOutboundAttempt(
    input: OutboundAttemptPut,
  ): Promise<OutboundAttemptRecord> {
    const key = `${input.org_id}\0${input.client_request_id}`;
    const previous = this.outboundAttempts.get(key);
    const record: OutboundAttemptRecord = {
      org_id: input.org_id,
      client_request_id: input.client_request_id,
      thread_id: input.thread_id,
      event_id: input.event_id,
      status: input.status,
      channel_message_ids: input.channel_message_ids?.slice(),
      recovery_hash: input.recovery_hash ?? previous?.recovery_hash,
      receipt: structuredClone(input.receipt ?? previous?.receipt),
      created_at: previous?.created_at ?? input.now,
      updated_at: input.now,
    };
    this.commitOutboundRecoveryBlob({
      ...input,
      recovery_hash: input.recovery_hash ?? previous?.recovery_hash,
    });
    this.outboundAttempts.set(key, record);
    return structuredClone(record);
  }

  private commitOutboundRecoveryBlob(
    input: NewOutboundAttempt | OutboundAttemptPut,
  ): void {
    const recoveryHash = input.recovery_hash;
    const expected = new Set(recoveryHash ? [recoveryHash] : []);
    if (input.blob_reservations !== undefined) {
      const hashes = new Set(input.blob_reservations.map((item) => item.content_hash));
      if (hashes.size !== input.blob_reservations.length || hashes.size !== expected.size
        || [...expected].some((hash) => !hashes.has(hash))) {
        throw new Error("Outbound recovery reservations must exactly match the stored recovery hash");
      }
      this.validateBlobReservations(input.blob_reservations, expected);
    } else if (recoveryHash) {
      const state = this.blobReservationStates.get(recoveryHash);
      if (state?.state === "reserved" || state?.state === "deleting"
        || state?.claim_token && (state.lease_expires_at ?? 0) > Date.now()) {
        throw new BlobReservationConflictError(recoveryHash);
      }
    }

    if (recoveryHash && input.blob_reservations === undefined) {
      this.rememberBlob({
        content_hash: recoveryHash,
        media_type: "application/vnd.regenic.reply-recovery+json",
        byte_size: 0,
      });
      const state = this.blobReservationStates.get(recoveryHash);
      if (state) state.state = "protected";
    } else {
      for (const reservation of input.blob_reservations ?? []) {
        const state = this.blobReservationStates.get(reservation.content_hash);
        if (!state) throw new BlobReservationConflictError(reservation.content_hash);
        if (reservation.mode === "write") {
          state.state = state.state === "protected" ? "protected" : "available";
          state.claim_token = undefined;
          state.lease_owner = undefined;
          state.lease_expires_at = undefined;
        }
      }
    }
  }

  async getEvent(orgId: string, eventId: string): Promise<EventRecord | null> {
    const event = this.events.find(
      (item) => item.org_id === orgId && item.id === eventId,
    );
    return event ? cloneEvent(event) : null;
  }

  async listEvents(
    orgId: string,
    query?: EventListQuery,
  ): Promise<EventRecord[]> {
    const matched = this.events
      .filter((event) => matchesEventQuery(event, orgId, query))
      .map(cloneEvent);
    if (query?.order === "ingested") {
      matched.sort((left, right) =>
        left.ingested_at.localeCompare(right.ingested_at) || left.id.localeCompare(right.id));
    } else if (query?.order === "recent") {
      matched.reverse();
    }
    const limit = query?.limit;
    if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) {
      return matched.slice(0, limit);
    }
    return matched;
  }

  async backfillEventAttachmentReferences(
    input: EventAttachmentReferenceBackfill,
  ): Promise<void> {
    const event = this.events.find((item) =>
      item.org_id === input.org_id && item.id === input.event_id);
    if (!event || event.content_hash !== input.expected_content_hash) {
      throw new Error("Event changed during attachment reference backfill");
    }
    if (!/^[a-f0-9]{64}$/.test(input.expected_content_hash) ||
      input.attachment_hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
      throw new Error("Invalid Event attachment reference hash");
    }
    for (const hash of new Set(input.attachment_hashes)) {
      if (!this.blobs.has(hash)) {
        this.blobs.set(hash, {
          content_hash: hash,
          media_type: "application/octet-stream",
          byte_size: 0,
          created_at: event.ingested_at,
        });
      }
      this.backfilledAttachmentReferences.add(`${input.org_id}\0${input.event_id}\0${hash}`);
    }
  }

  async putDispositionIfAbsent(decision: ArrangementDecision): Promise<boolean> {
    return this.putDispositionIfAbsentWithinTurn(decision);
  }

  private putDispositionIfAbsentWithinTurn(decision: ArrangementDecision): boolean {
    const event = this.events.find(
      (event) => event.id === decision.event_id && event.org_id === decision.org_id,
    );
    if (!event) {
      throw new Error("Disposition event is not owned by the requested organization");
    }
    if (this.dispositions.has(decision.event_id)) {
      return false;
    }
    this.dispositions.set(decision.event_id, {
      ...decision,
      version: decision.version ?? 0,
      reason_codes: [...decision.reason_codes],
    });
    this.setCurrentWorkEvidence(
      decision.event_id,
      decision.disposition === "current_work",
    );
    if (decision.disposition === "current_work") {
      this.unfoldCurrentWork(event, "current_work_disposition_restored", decision.decided_at);
    }
    return true;
  }

  listInboxDispositionTransitions(): Array<{
    command: InboxDispositionCommand;
    previous: ArrangementDecision;
    decision: ArrangementDecision;
  }> {
    return structuredClone(this.dispositionTransitions);
  }

  async transitionDisposition(
    input: InboxDispositionTransition,
  ): Promise<InboxDispositionTransitionResult> {
    const { expected, decision, command } = input;
    assertInboxDispositionTransition(input);
    const commandKey = `${command.org_id}\0${command.command_id}`;
    if (this.hasAcknowledgmentCommand(command.org_id, command.command_id)) {
      return { outcome: "command_conflict" };
    }
    const priorCommand = this.dispositionCommands.get(commandKey);
    if (priorCommand) {
      return sameInboxDispositionCommand(priorCommand.command, command)
        ? { outcome: "replayed", decision: cloneDisposition(priorCommand.decision) }
        : { outcome: "command_conflict" };
    }
    const event = this.events.find((candidate) =>
      candidate.id === command.event_id && candidate.org_id === command.org_id);
    if (!event) return { outcome: "conflict" };
    const current = this.dispositions.get(expected.event_id);
    if (!current || current.org_id !== expected.org_id
      || !isDeepStrictEqual(current, expected)) return { outcome: "conflict" };
    const previous = cloneDisposition(current);
    const saved = {
      ...cloneDisposition(decision),
      version: (current.version ?? 0) +
        (sameDispositionContent(current, decision) ? 0 : 1),
    };
    this.dispositions.set(decision.event_id, saved);
    this.setCurrentWorkEvidence(
      decision.event_id,
      decision.disposition === "current_work",
    );
    if (saved.disposition === "current_work") {
      this.unfoldCurrentWork(event, "current_work_disposition_changed", decision.decided_at);
    }
    const transition = {
      command: { ...command },
      previous,
      decision: cloneDisposition(saved),
    };
    this.dispositionCommands.set(commandKey, transition);
    this.dispositionTransitions.push(transition);
    return { outcome: "applied", decision: cloneDisposition(saved) };
  }

  async getDisposition(eventId: string): Promise<ArrangementDecision | null> {
    const decision = this.dispositions.get(eventId);
    return decision
      ? { ...decision, reason_codes: [...decision.reason_codes] }
      : null;
  }

  async listInbox(orgId: string, query?: InboxQuery): Promise<InboxItem[]> {
    const useDecided =
      query?.siblings ||
      query?.heads ||
      query?.disposition === "pending" ||
      normalizeInboxListView(query?.list) === "hidden";
    const items = useDecided
      ? await this.decidedInbox(orgId, headsScanQuery(query) ?? query)
      : this.currentWorkInbox(
          orgId,
          query?.disposition ?? "current_work",
          query?.push_candidates,
        );
    return selectInboxItems(items, query).sort((left, right) => {
      const byTime = left.event.occurred_at.localeCompare(right.event.occurred_at);
      if (byTime !== 0) {
        return byTime;
      }
      return left.event.id.localeCompare(right.event.id);
    });
  }

  async searchConversationDirectory(
    orgId: string,
    query?: ConversationDirectoryQuery,
  ): Promise<ConversationDirectoryEntry[]> {
    const exact = query?.thread_id?.trim();
    const lists = exact || !query?.list || query.list === "all"
      ? (["shown", "hidden"] as const)
      : ([query.list] as const);
    const seen = new Map<string, ConversationDirectoryEntry>();
    for (const list of lists) {
      const items = await this.listInbox(orgId, {
        heads: true,
        ...(list === "hidden" ? { list: "hidden" as const } : {}),
      });
      for (const item of items) {
        const threadId = item.event.thread_id?.trim();
        if (!threadId || seen.has(threadId)) {
          continue;
        }
        const pref = this.prefs.get(prefKey(orgId, threadId));
        seen.set(threadId, {
          thread_id: threadId,
          source: item.event.source,
          pref_title: pref?.title ?? null,
          catalog_label: null,
          hidden: pref?.hidden === true,
          has_current_work: item.decision.disposition === "current_work",
          face_occurred_at: item.event.occurred_at,
        });
      }
    }
    return rankConversationDirectory([...seen.values()], query);
  }

  async summarizeInbox(orgId: string): Promise<InboxSummary> {
    const prefs = [...this.prefs.values()].filter((pref) => pref.org_id === orgId);
    return {
      ...summarizeInboxItems(this.currentWorkInbox(orgId), prefs),
      hidden_count: this.hiddenInboxCount(orgId),
    };
  }

  private hiddenInboxCount(orgId: string): number {
    const hidden = this.hiddenThreadIds(orgId);
    if (hidden.size === 0) {
      return 0;
    }
    const withFace = new Set<string>();
    for (const event of this.events) {
      if (event.org_id !== orgId || !this.dispositions.has(event.id)) {
        continue;
      }
      if (event.operation === "tombstone") {
        continue;
      }
      const id = eventThreadId(event);
      if (hidden.has(id)) {
        withFace.add(id);
      }
    }
    return withFace.size;
  }

  private currentWorkInbox(
    orgId: string,
    disposition: "current_work" | "pending" = "current_work",
    pushCandidates = false,
  ): InboxItem[] {
    const hidden = this.hiddenThreadIds(orgId, pushCandidates);
    return [...this.currentBySource.values()].flatMap((event) => {
      const decision = this.dispositions.get(event.id);
      if (!decision || event.org_id !== orgId) {
        return [];
      }
      const eligible = pushCandidates && disposition === "current_work"
        ? isPushInboxDecision(decision)
        : decision.disposition === disposition;
      if (!eligible) {
        return [];
      }
      if (disposition === "current_work" && event.operation === "tombstone") {
        return [];
      }
      if (hidden.has(eventThreadId(event))) {
        return [];
      }
      return [
        {
          decision: {
            ...decision,
            reason_codes: [...decision.reason_codes],
          },
          event: { ...event },
        },
      ];
    });
  }

  private async decidedInbox(
    orgId: string,
    query?: InboxQuery,
  ): Promise<InboxItem[]> {
    const scoped = Boolean(query?.source || query?.target || query?.thread_ids);
    const hiddenList = normalizeInboxListView(query?.list) === "hidden";
    const hidden = this.hiddenThreadIds(orgId);
    const allowed = query?.heads && !hiddenList
      ? new Set([...this.currentBySource.values()]
          .filter((event) => event.org_id === orgId && event.operation !== "tombstone"
            && this.dispositions.get(event.id)?.disposition === "current_work"
            && (scoped || !hidden.has(eventThreadId(event))))
          .map(eventThreadId))
      : scoped
        ? undefined
        : hiddenList
          ? hidden
          : new Set(this.currentWorkInbox(orgId).map((item) => eventThreadId(item.event)));
    if (allowed && allowed.size === 0) {
      return [];
    }
    return this.events.flatMap((event) => {
      if (!matchesEventQuery(event, orgId, query)) {
        return [];
      }
      if (allowed && !allowed.has(eventThreadId(event))) {
        return [];
      }
      const decision = this.dispositions.get(event.id);
      if (!decision || (query?.disposition && decision.disposition !== query.disposition)) {
        return [];
      }
      return [
        {
          decision: {
            ...decision,
            reason_codes: [...decision.reason_codes],
          },
          event: { ...event },
        },
      ];
    });
  }

  private hiddenThreadIds(orgId: string, humanOnly = false): Set<string> {
    return new Set(
      [...this.prefs.values()]
        .filter((pref) => pref.org_id === orgId && pref.hidden &&
          (!humanOnly || pref.hidden_reason !== "policy"))
        .map((pref) => pref.thread_id),
    );
  }

  async listConversationPrefs(orgId: string): Promise<ConversationPref[]> {
    return [...this.prefs.values()]
      .filter((pref) => pref.org_id === orgId)
      .map((pref) => ({ ...pref }));
  }

  async getConversationPref(
    orgId: string,
    threadId: string,
  ): Promise<ConversationPref | null> {
    const pref = this.prefs.get(prefKey(orgId, threadId));
    return pref ? { ...pref } : null;
  }

  async putConversationPref(
    input: ConversationPrefPatch,
  ): Promise<ConversationPref> {
    if ("hidden" in input || "hidden_reason" in input || "expected_visibility_version" in input) {
      throw new Error("Conversation visibility must use a visibility command");
    }
    const current = this.prefs.get(prefKey(input.org_id, input.thread_id));
    const hidden = current?.hidden ?? false;
    const readCursor = mergeConversationReadCursor(current ?? null, input);
    const next: ConversationPref = {
      org_id: input.org_id,
      thread_id: input.thread_id,
      title: input.title !== undefined ? input.title : (current?.title ?? null),
      pinned: input.pinned !== undefined ? input.pinned : (current?.pinned ?? false),
      hidden,
      hidden_reason: hidden ? (current?.hidden_reason ?? null) : null,
      visibility_version: current?.visibility_version ?? 0,
      ...readCursor,
      updated_at: input.updated_at,
    };
    this.prefs.set(prefKey(input.org_id, input.thread_id), next);
    return { ...next };
  }

  async setConversationVisibility(
    input: ConversationVisibilityUpdate,
  ): Promise<ConversationVisibilityUpdateResult> {
    const key = prefKey(input.org_id, input.thread_id);
    const command = JSON.stringify(conversationVisibilityCommand(input));
    const commandKey = input.command_id === undefined
      ? undefined
      : `${input.org_id}\0${input.command_id}`;
    if (commandKey !== undefined) {
      if (input.command_id !== undefined && this.hasAcknowledgmentCommand(input.org_id, input.command_id)) {
        return { outcome: "command_conflict" };
      }
      const previous = this.visibilityCommands.get(commandKey);
      if (previous) {
        return sameConversationVisibilityCommand(
          JSON.parse(previous.command),
          conversationVisibilityCommand(input),
        )
          ? { outcome: "replayed", pref: { ...previous.pref } }
          : { outcome: "command_conflict" };
      }
    }
    const current = this.prefs.get(key);
    const currentVersion = current?.visibility_version ?? 0;
    if (currentVersion !== input.expected_version) {
      return { outcome: "conflict", current_version: currentVersion };
    }
    const hidden = input.hidden;
    const next: ConversationPref = {
      org_id: input.org_id,
      thread_id: input.thread_id,
      title: input.title !== undefined ? input.title : (current?.title ?? null),
      pinned: input.pinned !== undefined ? input.pinned : (current?.pinned ?? false),
      hidden,
      hidden_reason: input.hidden ? "human" : null,
      visibility_version: currentVersion + 1,
      last_read_at: current?.last_read_at ?? null,
      last_read_external_id: current?.last_read_external_id ?? null,
      updated_at: input.updated_at,
    };
    this.prefs.set(key, next);
    if (commandKey !== undefined) {
      this.visibilityCommands.set(commandKey, { command, pref: { ...next } });
    }
    return { outcome: "applied", pref: { ...next } };
  }

  async setConversationPolicyHidden(
    input: ConversationPolicyFold,
  ): Promise<ConversationPolicyFoldResult> {
    return this.setConversationPolicyVisibility({
      ...input,
      hidden: true,
    });
  }

  async setConversationPolicyVisibility(
    input: ConversationPolicyVisibility,
  ): Promise<ConversationPolicyFoldResult> {
    return this.setConversationPolicyVisibilityWithinTurn(input);
  }

  private setConversationPolicyVisibilityWithinTurn(
    input: ConversationPolicyVisibility,
  ): ConversationPolicyFoldResult {
    assertConversationPolicyVisibility(input);
    const key = prefKey(input.org_id, input.thread_id);
    const current = this.prefs.get(key);
    const currentVersion = current?.visibility_version ?? 0;
    if (currentVersion !== input.expected_visibility_version) {
      return { outcome: "conflict", current_version: currentVersion };
    }
    const unfoldEventIds = input.unfold_current_work_event_ids;
    const unfoldEventIdSet = unfoldEventIds ? new Set(unfoldEventIds) : undefined;
    const candidates = unfoldEventIds
      ? new Map([...this.currentBySource.values()].filter((event) =>
        event.org_id === input.org_id && eventThreadId(event) === input.thread_id &&
        event.operation !== "tombstone" && unfoldEventIdSet?.has(event.id) &&
        this.dispositions.get(event.id)?.disposition === "current_work" &&
        this.dispositions.get(event.id)?.org_id === input.org_id).map((event) => [event.id, event]))
      : undefined;
    const unfoldEvent = unfoldEventIds?.map((id) => candidates?.get(id)).find((event) => event !== undefined);
    if (unfoldEventIds && !unfoldEvent) {
      return { outcome: "unchanged" };
    }
    const tombstoneIds = input.fold_current_tombstone_event_ids;
    const tombstoneIdSet = tombstoneIds ? new Set(tombstoneIds) : undefined;
    const currentTombstones = tombstoneIds
      ? new Map([...this.currentBySource.values()].filter((event) =>
        event.org_id === input.org_id && eventThreadId(event) === input.thread_id &&
        event.operation === "tombstone" && tombstoneIdSet?.has(event.id))
        .map((event) => [event.id, event]))
      : undefined;
    const tombstone = tombstoneIds?.map((id) => currentTombstones?.get(id))
      .find((event) => event !== undefined);
    if (tombstoneIds && !tombstone) {
      return { outcome: "unchanged" };
    }
    const excludedCurrentWorkEventId = input.fold_excluded_current_work_event_id;
    if (excludedCurrentWorkEventId && ![...this.currentBySource.values()].some((event) =>
      event.org_id === input.org_id && event.id === excludedCurrentWorkEventId
      && eventThreadId(event) === input.thread_id && event.operation !== "tombstone"
      && this.dispositions.get(event.id)?.disposition === "current_work"
      && this.dispositions.get(event.id)?.org_id === input.org_id)) {
      return { outcome: "unchanged" };
    }
    const excludedCurrentWorkEventIds = excludedCurrentWorkEventId
      ? new Set([excludedCurrentWorkEventId])
      : undefined;
    if (input.hidden && (
      this.hasUnsettledWorkForThread(input.org_id, input.thread_id)
      || [...this.currentBySource.values()].some((event) => event.org_id === input.org_id
        && eventThreadId(event) === input.thread_id
        && !excludedCurrentWorkEventIds?.has(event.id)
        && event.operation !== "tombstone"
        && this.dispositions.get(event.id)?.disposition === "current_work")
    )) {
      return { outcome: "unchanged" };
    }
    if (
      input.hidden
        ? current?.hidden === true && current.hidden_reason !== "policy"
        : current?.hidden !== true || current.hidden_reason !== "policy"
    ) {
      return { outcome: "unchanged" };
    }
    if (current?.hidden === input.hidden) {
      return { outcome: "unchanged" };
    }
    if (unfoldEvent) {
      const pref = this.unfoldCurrentWork(unfoldEvent, "current_work_visibility_reconciled", input.updated_at);
      if (!pref) throw new Error("Current-work visibility reconciliation lost its target");
      return { outcome: "applied", pref: { ...pref } };
    }
    const next: ConversationPref = {
      org_id: input.org_id,
      thread_id: input.thread_id,
      title: current?.title ?? null,
      pinned: current?.pinned ?? false,
      hidden: input.hidden,
      hidden_reason: input.hidden ? "policy" : null,
      visibility_version: currentVersion,
      last_read_at: current?.last_read_at ?? null,
      last_read_external_id: current?.last_read_external_id ?? null,
      updated_at: input.updated_at,
    };
    this.prefs.set(key, next);
    if (tombstone) {
      this.tombstoneVisibilityEvents.push({
        org_id: input.org_id, thread_id: input.thread_id, aggregate_type: "conversation",
        aggregate_id: input.thread_id, aggregate_version: currentVersion,
        event_type: "visibility_changed",
        payload: { hidden: true, hidden_reason: "policy",
          cause: "tombstone_visibility_reconciled", event_id: tombstone.id },
      });
    } else {
      this.policyVisibilityEvents.push({
        org_id: input.org_id, thread_id: input.thread_id, aggregate_type: "conversation",
        aggregate_id: input.thread_id, aggregate_version: currentVersion,
        event_type: "visibility_changed",
        payload: { hidden: input.hidden, hidden_reason: input.hidden ? "policy" : null,
          cause: "policy_visibility_applied" },
      });
    }
    return { outcome: "applied", pref: { ...next } };
  }

  async summarizeStore(orgId: string): Promise<StoreFootprint> {
    return this.storeFootprint(orgId);
  }

  private unfoldCurrentWork(
    event: EventRecord,
    cause: "current_work_ingested" | "current_work_disposition_changed" | "current_work_disposition_restored"
      | "current_work_visibility_reconciled",
    now: string,
  ): ConversationPref | undefined {
    const threadId = eventThreadId(event);
    const key = prefKey(event.org_id, threadId);
    const pref = this.prefs.get(key);
    if (event.operation === "tombstone" || !pref?.hidden || pref.hidden_reason !== "policy"
      || ![...this.currentBySource.values()].some((head) => head.org_id === event.org_id && head.id === event.id)) {
      return;
    }
    const next = { ...pref, hidden: false, hidden_reason: null, updated_at: now };
    this.prefs.set(key, next);
    this.currentWorkVisibilityEvents.push({
      org_id: event.org_id, thread_id: threadId, aggregate_type: "conversation",
      aggregate_id: threadId, aggregate_version: pref.visibility_version,
      event_type: "visibility_changed",
      payload: { hidden: false, hidden_reason: null, cause, event_id: event.id },
    });
    return next;
  }

  private persistIngestionDisposition(
    event: EventRecord,
    decision: ArrangementDecision,
    previousEventId?: string,
  ): void {
    const current = this.dispositions.get(decision.event_id);
    const saved = {
      ...cloneDisposition(decision),
      version: current
        ? (current.version ?? 0) + (sameDispositionContent(current, decision) ? 0 : 1)
        : decision.version ?? 0,
    };
    this.dispositions.set(decision.event_id, saved);
    this.setCurrentWorkEvidence(
      decision.event_id,
      decision.disposition === "current_work",
    );
    const previous = previousEventId
      ? this.dispositions.get(previousEventId)
      : undefined;
    if (
      decision.disposition !== "current_work" &&
      previous?.disposition !== "current_work"
    ) {
      return;
    }
    const threadId = eventThreadId(event);
    if (saved.disposition === "current_work") {
      this.unfoldCurrentWork(event, "current_work_ingested", event.ingested_at);
    }
    this.ingestionLifecycleEvents.push({
      org_id: event.org_id,
      thread_id: threadId,
      aggregate_type: "source_event",
      aggregate_id: event.id,
      aggregate_version: 1,
      event_type: "current_work_changed",
      payload: {
        source: "ingestion",
        previous: previousEventId
          ? {
              event_id: previousEventId,
              disposition: previous?.disposition ?? null,
            }
          : null,
        result: cloneDisposition(saved),
      },
    });
  }

  async clearOperationalData(
    orgId: string,
    _now: string,
  ): Promise<StoreClearResult> {
    const before = this.storeFootprint(orgId);
    const hashes = new Set(
      this.events.flatMap((event) =>
        event.org_id === orgId && event.content_hash ? [event.content_hash] : [],
      ),
    );
    const keptEvents = this.events.filter((event) => event.org_id !== orgId);
    this.events.length = 0;
    this.events.push(...keptEvents);
    for (const [key, event] of [...this.currentBySource]) {
      if (event.org_id === orgId) {
        this.currentBySource.delete(key);
      }
    }
    for (const [eventId, decision] of [...this.dispositions]) {
      if (decision.org_id === orgId) {
        this.dispositions.delete(eventId);
        this.setCurrentWorkEvidence(eventId, false);
      }
    }
    const retainedLifecycleEvents = this.ingestionLifecycleEvents.filter(
      (event) => event.org_id !== orgId,
    );
    this.ingestionLifecycleEvents.length = 0;
    this.ingestionLifecycleEvents.push(...retainedLifecycleEvents);
    const retainedVisibilityEvents = this.currentWorkVisibilityEvents.filter(
      (event) => event.org_id !== orgId,
    );
    this.currentWorkVisibilityEvents.length = 0;
    this.currentWorkVisibilityEvents.push(...retainedVisibilityEvents);
    const retainedTombstoneVisibilityEvents = this.tombstoneVisibilityEvents.filter(
      (event) => event.org_id !== orgId,
    );
    this.tombstoneVisibilityEvents.length = 0;
    this.tombstoneVisibilityEvents.push(...retainedTombstoneVisibilityEvents);
    const retainedPolicyVisibilityEvents = this.policyVisibilityEvents.filter(
      (event) => event.org_id !== orgId,
    );
    this.policyVisibilityEvents.length = 0;
    this.policyVisibilityEvents.push(...retainedPolicyVisibilityEvents);
    const retainedAcknowledgments = this.acknowledgmentLifecycleEvents.filter(
      (event) => event.org_id !== orgId,
    );
    this.acknowledgmentLifecycleEvents.length = 0;
    this.acknowledgmentLifecycleEvents.push(...retainedAcknowledgments);
    for (const [key, transition] of this.dispositionCommands) {
      if (transition.command.org_id === orgId) this.dispositionCommands.delete(key);
    }
    const retainedTransitions = this.dispositionTransitions.filter(
      (transition) => transition.command.org_id !== orgId,
    );
    this.dispositionTransitions.length = 0;
    this.dispositionTransitions.push(...retainedTransitions);
    for (const [key, pref] of [...this.prefs]) {
      if (pref.org_id === orgId) {
        this.prefs.delete(key);
      }
    }
    for (const key of this.visibilityCommands.keys()) {
      if (key.startsWith(`${orgId}\0`)) {
        this.visibilityCommands.delete(key);
      }
    }
    this.dropOperationalWork(orgId);
    for (const hash of hashes) {
      if (!this.events.some((event) => event.content_hash === hash)) {
        this.blobs.delete(hash);
      }
    }
    const after = this.storeFootprint(orgId);
    return {
      cleared: {
        events: before.events,
        conversations: before.conversations,
        work_items: before.work_items,
        blobs: before.blobs,
        context_artifacts: before.context_artifacts,
        context_snapshots: before.context_snapshots,
        context_snapshot_index: before.context_snapshot_index,
        context_bundles: before.context_bundles,
        context_checkpoints: before.context_checkpoints,
      },
      kept: {
        recipes: after.recipes,
        connectors: after.connectors,
        executors: after.executors,
      },
    };
  }

  private storeFootprint(orgId: string): StoreFootprint {
    const events = this.events.filter((event) => event.org_id === orgId);
    return {
      events: events.length,
      conversations: new Set(events.map((event) => eventThreadId(event))).size,
      work_items: this.workItemCount(orgId),
      blobs: new Set(
        events.flatMap((event) => (event.content_hash ? [event.content_hash] : [])),
      ).size,
      context_artifacts: 0,
      context_snapshots: 0,
      context_snapshot_index: 0,
      context_bundles: 0,
      context_checkpoints: 0,
      recipes: this.recipeCount(orgId),
      connectors: 0,
      executors: this.executorCount(orgId),
    };
  }

  async append(input: NewEvent): Promise<EventRecord> {
    return this.addContentEvent(input, "create");
  }

  async commitIngest(request: IngestCommitRequest): Promise<EventRecord[]> {
    const prepared = structuredClone(request);
    return this.withIngestRollback(prepared, [], () => this.commitIngestWithinTurn(prepared));
  }

  async commitConversationIntake(
    request: ConversationIntakeCommit,
  ): Promise<EventRecord[]> {
    const prepared = structuredClone(request);
    const repairs = prepared.disposition_repairs ?? [];
    assertDispositionRepairs(repairs);
    for (const visibility of prepared.visibility) {
      assertConversationPolicyVisibility(visibility);
    }
    return this.withIngestRollback(prepared.ingest, prepared.visibility, () => {
      this.applyDispositionRepairsWithinTurn(repairs);
      const events = this.commitIngestWithinTurn(prepared.ingest);
      for (const observation of prepared.work_observations) {
        const result = this.observeWorkItemWithinTurn(observation);
        if (result.outcome === "conflict") throw new AuthorityConflictError();
      }
      for (const visibility of prepared.visibility) {
        this.setConversationPolicyVisibilityWithinTurn(visibility);
      }
      return events;
    }, repairs);
  }

  private applyDispositionRepairsWithinTurn(
    repairs: readonly {
      identities: SourceIdentity[];
      decision: ArrangementDecision;
    }[],
  ): void {
    for (const { identities, decision } of repairs) {
      const event = this.events.find((row) =>
        row.org_id === decision.org_id && row.id === decision.event_id);
      if (!event || identities.some((identity) =>
        this.currentBySource.get(sourceKey(identity))?.id !== decision.event_id)) {
        throw new AuthorityConflictError();
      }
      if (!this.putDispositionIfAbsentWithinTurn(decision)) {
        throw new DispositionRepairConflictError();
      }
    }
  }

  private withIngestRollback<T>(
    request: IngestCommitRequest | undefined,
    prefs: readonly ConversationPolicyVisibility[],
    commit: () => T,
    dispositionRepairs: readonly {
      decision: ArrangementDecision;
    }[] = [],
  ): T {
    const appends = request?.appends ?? [];
    const decisions = [
      ...(request?.dispositions ?? []),
      ...dispositionRepairs.map((repair) => repair.decision),
    ];
    const prefKeys = prefs.map((pref) => prefKey(pref.org_id, pref.thread_id));
    for (const input of appends) {
      if (input.id !== undefined) {
        prefKeys.push(prefKey(input.org_id, eventThreadId({
          ...input, id: input.id, operation: input.operation ?? "create",
          ingested_at: input.occurred_at,
        })));
      }
    }
    for (const repair of dispositionRepairs) {
      const event = this.events.find((row) =>
        row.org_id === repair.decision.org_id && row.id === repair.decision.event_id);
      if (event) prefKeys.push(prefKey(event.org_id, eventThreadId(event)));
    }
    const restore = [
      restoreMapEntries(this.currentBySource, appends.map(sourceKey)),
      restoreMapEntries(this.blobs, appends.flatMap((input) =>
        [...(input.content_hash ? [input.content_hash] : []),
          ...(input.extra_blobs ?? []).map((blob) => blob.content_hash),
          ...(request?.blob_reservations ?? []).map((blob) => blob.content_hash)])),
      restoreMapEntries(this.blobReservationStates, [
        ...appends.flatMap((input) =>
          [...(input.content_hash ? [input.content_hash] : []),
            ...(input.extra_blobs ?? []).map((blob) => blob.content_hash)]),
        ...(request?.blob_reservations ?? []).map((blob) => blob.content_hash),
      ]),
      restoreMapEntries(this.dispositions, decisions.map((decision) => decision.event_id)),
      restoreMapEntries(this.prefs, prefKeys),
    ];
    const workState = this.snapshotWorkItemObservationState();
    const evidence = decisions.map((decision) => ({
      id: decision.event_id,
      present: super.hasCurrentWorkEvidence(decision.event_id, decision.org_id, ""),
    }));
    const nextId = this.nextId;
    const eventCount = this.events.length;
    const ingestionCount = this.ingestionLifecycleEvents.length;
    const currentWorkVisibilityCount = this.currentWorkVisibilityEvents.length;
    const tombstoneVisibilityCount = this.tombstoneVisibilityEvents.length;
    const policyVisibilityCount = this.policyVisibilityEvents.length;
    try {
      return commit();
    } catch (error) {
      for (const restoreEntries of restore) restoreEntries();
      this.restoreWorkItemObservationState(workState);
      for (const item of evidence) super.setCurrentWorkEvidence(item.id, item.present);
      this.nextId = nextId;
      this.events.length = eventCount;
      this.ingestionLifecycleEvents.length = ingestionCount;
      this.currentWorkVisibilityEvents.length = currentWorkVisibilityCount;
      this.tombstoneVisibilityEvents.length = tombstoneVisibilityCount;
      this.policyVisibilityEvents.length = policyVisibilityCount;
      throw error;
    }
  }

  private commitIngestWithinTurn(request: IngestCommitRequest): EventRecord[] {
    assertIngestDispositionBindings(request);
    const ids = new Set(this.events.map((event) => event.id));
    for (const input of request.appends) {
      if (input.id === undefined) continue;
      if (ids.has(input.id)) throw new Error("Event ID already exists");
      ids.add(input.id);
    }
    let nextId = this.nextId;
    const appends: Array<IngestAppend & { id: string }> = request.appends.map((input) => {
      if (input.id !== undefined) return { ...input, id: input.id };
      let id: string;
      do {
        id = `event-${nextId++}`;
      } while (ids.has(id));
      ids.add(id);
      return { ...input, id };
    });
    const simulatedHeads = new Map<string, EventRecord | null>();
    for (const input of appends) {
      const key = sourceKey(input);
      const current = simulatedHeads.has(key)
        ? simulatedHeads.get(key) ?? null
        : this.currentBySource.get(key) ?? null;
      this.assertExpectedHead(input.expected_head_id, current);
      simulatedHeads.set(key, {
        id: input.id,
        org_id: input.org_id,
        source: input.source,
        external_id: input.external_id,
        operation: input.operation ?? "create",
        occurred_at: input.occurred_at,
        ingested_at: input.occurred_at,
      });
    }
    this.completeBlobReservations(request);
    this.nextId = nextId;
    const events: EventRecord[] = [];
    for (const input of appends) {
      if (input.operation === "tombstone") {
        const current = this.currentBySource.get(sourceKey(input)) ?? null;
        events.push(this.addEvent({
          ...input,
          operation: "tombstone",
          content_hash: current?.content_hash ?? input.content_hash,
          parent_event_id: current?.id,
        }));
      } else {
        events.push(this.addContentEvent(
          input,
          input.operation === "revise" ? "revise" : "create",
        ));
      }
    }
    const eventsById = new Map(events.map((event) => [event.id, event]));
    const appendsByEventId = new Map(
      events.map((event, index) => [event.id, appends[index]]),
    );
    for (const decision of request.dispositions) {
      const event = eventsById.get(decision.event_id);
      if (event) {
        this.persistIngestionDisposition(
          event,
          decision,
          appendsByEventId.get(event.id)?.parent_event_id,
        );
      } else {
        throw new Error("Ingest disposition event was not created");
      }
    }
    return events;
  }

  private completeBlobReservations(request: IngestCommitRequest): void {
    const referenced = new Set(request.appends.flatMap((append) => [
      ...(append.content_hash ? [append.content_hash] : []),
      ...(append.extra_blobs ?? []).map((blob) => blob.content_hash),
    ]));
    const reservations = request.blob_reservations ?? [];
    this.validateBlobReservations(reservations, referenced);
    for (const reservation of reservations) {
      if (reservation.mode !== "write") continue;
      const state = this.blobReservationStates.get(reservation.content_hash);
      if (!state) throw new BlobReservationConflictError(reservation.content_hash);
      state.state = state.state === "protected" ? "protected" : "available";
      state.claim_token = undefined;
      state.lease_owner = undefined;
      state.lease_expires_at = undefined;
    }
  }

  private validateBlobReservations(
    reservations: readonly BlobReservation[],
    referenced: ReadonlySet<string>,
  ): void {
    const hashes = new Set<string>();
    const now = Date.now();
    for (const reservation of reservations) {
      if (hashes.has(reservation.content_hash) || !referenced.has(reservation.content_hash)) {
        throw new Error("Blob reservations must uniquely match owner content in the commit");
      }
      hashes.add(reservation.content_hash);
      const state = this.blobReservationStates.get(reservation.content_hash);
      if (!state || state.generation !== reservation.generation) {
        throw new BlobReservationConflictError(reservation.content_hash);
      }
      if (reservation.mode === "write") {
        if (state.claim_token !== reservation.claim_token ||
          (state.lease_expires_at ?? 0) <= now ||
          (state.state !== "reserved" && state.state !== "protected")) {
          throw new BlobReservationConflictError(reservation.content_hash);
        }
      } else if (
        (state.state !== "available" && state.state !== "protected") ||
        state.claim_token !== undefined
      ) {
        throw new BlobReservationConflictError(reservation.content_hash);
      }
    }
  }

  async commitSyncPage(input: CommitSyncPage): Promise<CommitSyncPageResult> {
    const page = structuredClone(input);
    assertSyncPageAttemptBinding(page);
    assertDispositionRepairs(page.disposition_repairs ?? [], page.attempt.org_id);
    for (const pref of page.prefs ?? []) assertConversationPolicyVisibility(pref);
    return this.withIngestRollback(page.ingest, page.prefs ?? [], () => {
      this.applyDispositionRepairsWithinTurn(page.disposition_repairs ?? []);
      const events = page.ingest ? this.commitIngestWithinTurn(page.ingest) : [];
      for (const observation of page.work_observations ?? []) {
        const result = this.observeWorkItemWithinTurn(observation);
        if (result.outcome === "conflict") throw new AuthorityConflictError();
      }
      for (const pref of page.prefs ?? []) {
        this.setConversationPolicyVisibilityWithinTurn(pref);
      }
      return {
        attempt: {
          ...page.attempt,
          status:
            page.settle.retryable_failure_count === 0 ? "succeeded" : "failed",
          finished_at: page.settle.finished_at,
          accepted_count: page.settle.accepted_count,
          duplicate_count: page.settle.duplicate_count,
          quarantined_count: page.settle.quarantined_count,
          retryable_failure_count: page.settle.retryable_failure_count,
          error_code: page.settle.error_code,
        },
        events,
      };
    }, page.disposition_repairs ?? []);
  }

  async appendRevision(input: EventRevision): Promise<EventRecord> {
    assertEventDispositionBinding(input);
    const request: IngestCommitRequest = {
      appends: [input],
      dispositions: input.disposition ? [input.disposition] : [],
      blob_reservations: input.blob_reservations,
    };
    return this.withIngestRollback(request, [], () => {
      this.completeBlobReservations(request);
      const event = this.addContentEvent(input, "revise");
      if (input.disposition) {
        this.persistIngestionDisposition(event, input.disposition, input.parent_event_id);
      }
      return event;
    });
  }

  async markTombstone(input: TombstoneEvent): Promise<EventRecord> {
    assertEventDispositionBinding(input);
    const current = this.currentBySource.get(sourceKey(input)) ?? null;
    this.assertExpectedHead(input.expected_head_id, current);
    const event = this.addEvent({
      ...input,
      operation: "tombstone",
      content_hash: current?.content_hash,
      parent_event_id: current?.id,
    });
    if (input.disposition) {
      this.persistIngestionDisposition(event, input.disposition, current?.id);
    }
    return event;
  }

  allEvents(): readonly EventRecord[] {
    return this.events.map(cloneEvent);
  }

  listIngestionLifecycleEvents(): typeof this.ingestionLifecycleEvents {
    return structuredClone(this.ingestionLifecycleEvents);
  }

  listCurrentWorkVisibilityEvents(): typeof this.currentWorkVisibilityEvents {
    return structuredClone(this.currentWorkVisibilityEvents);
  }

  listTombstoneVisibilityEvents(): typeof this.tombstoneVisibilityEvents {
    return structuredClone(this.tombstoneVisibilityEvents);
  }

  listPolicyVisibilityEvents(): typeof this.policyVisibilityEvents {
    return structuredClone(this.policyVisibilityEvents);
  }

  async repointContentHash(input: RepointContentInput): Promise<number> {
    if (!this.events.some((event) => event.content_hash === input.old_content_hash)) {
      return 0;
    }
    const referencedHashes = new Set([
      input.new_content_hash,
      ...(input.extra_blobs ?? []).map((blob) => blob.content_hash),
    ]);
    if (input.blob_reservations) {
      const reservationHashes = new Set(input.blob_reservations.map((item) => item.content_hash));
      if (reservationHashes.size !== input.blob_reservations.length
        || reservationHashes.size !== referencedHashes.size
        || [...referencedHashes].some((hash) => !reservationHashes.has(hash))) {
        throw new Error("Content repoint reservations must exactly match its Blob references");
      }
      this.validateBlobReservations(input.blob_reservations, referencedHashes);
    } else {
      for (const hash of referencedHashes) {
        const state = this.blobReservationStates.get(hash);
        if (state?.state === "reserved" || state?.state === "deleting"
          || state?.claim_token && (state.lease_expires_at ?? 0) > Date.now()) {
          throw new BlobReservationConflictError(hash);
        }
      }
    }

    this.rememberBlob({
      content_hash: input.new_content_hash,
      media_type: input.content_media_type,
      byte_size: input.content_byte_size,
    });
    for (const blob of input.extra_blobs ?? []) {
      this.rememberBlob(blob);
    }
    if (input.blob_reservations) {
      for (const reservation of input.blob_reservations) {
        const state = this.blobReservationStates.get(reservation.content_hash);
        if (reservation.mode === "write" && state) {
          state.state = state.state === "protected" ? "protected" : "available";
          state.claim_token = undefined;
          state.lease_owner = undefined;
          state.lease_expires_at = undefined;
        }
      }
    } else {
      for (const hash of referencedHashes) {
        const state = this.blobReservationStates.get(hash);
        if (state) state.state = "protected";
      }
    }
    let updated = 0;
    for (const event of this.events) {
      if (event.content_hash === input.old_content_hash) {
        event.content_hash = input.new_content_hash;
        updated += 1;
      }
    }
    const stillUsed = this.events.some(
      (event) => event.content_hash === input.old_content_hash,
    );
    if (!stillUsed && input.old_content_hash !== input.new_content_hash) {
      this.blobs.delete(input.old_content_hash);
    }
    return updated;
  }

  async vacuumStore(): Promise<void> {}

  private rememberBlob(input: {
    content_hash: string;
    media_type: string;
    byte_size: number;
  }): void {
    if (this.blobs.has(input.content_hash)) {
      return;
    }
    this.blobs.set(input.content_hash, {
      content_hash: input.content_hash,
      media_type: input.media_type,
      byte_size: input.byte_size,
      created_at: new Date().toISOString(),
    });
    this.blobReservationStates.set(input.content_hash, {
      state: "protected",
      generation: 0,
    });
  }

  private addContentEvent(
    input: NewEvent & { parent_event_id?: string },
    operation: "create" | "revise",
  ): EventRecord {
    const current = this.currentBySource.get(sourceKey(input)) ?? null;
    this.assertExpectedHead(input.expected_head_id, current);
    if (input.id !== undefined && this.events.some((event) => event.id === input.id)) {
      throw new Error("Event ID already exists");
    }
    this.rememberBlob({
      content_hash: input.content_hash,
      media_type: input.content_media_type,
      byte_size: input.content_byte_size,
    });
    for (const blob of input.extra_blobs ?? []) {
      this.rememberBlob(blob);
    }
    return this.addEvent({
      ...input,
      operation,
      parent_event_id: operation === "revise" ? input.parent_event_id : undefined,
    });
  }

  private addEvent(
    input: SourceIdentity &
      Pick<EventRecord, "operation" | "occurred_at"> &
      Partial<
        Pick<
          EventRecord,
          | "id"
          | "content_hash"
          | "parent_event_id"
          | "thread_id"
          | "actor_id"
          | "required_scope_ids"
          | "direction_tags"
          | "weight_hints"
          | "attrs"
        >
      >,
  ): EventRecord {
    let id = input.id;
    if (id !== undefined && this.events.some((event) => event.id === id)) {
      throw new Error("Event ID already exists");
    }
    if (id === undefined) {
      do {
        id = `event-${this.nextId++}`;
      } while (this.events.some((event) => event.id === id));
    }
    const event: EventRecord = {
      id,
      org_id: input.org_id,
      source: input.source,
      external_id: input.external_id,
      operation: input.operation,
      content_hash: input.content_hash,
      parent_event_id: input.parent_event_id,
      thread_id: input.thread_id,
      actor_id: input.actor_id,
      required_scope_ids: input.required_scope_ids
        ? [...input.required_scope_ids]
        : undefined,
      direction_tags: input.direction_tags ? [...input.direction_tags] : undefined,
      weight_hints: input.weight_hints ? structuredClone(input.weight_hints) : undefined,
      attrs: input.attrs ? structuredClone(input.attrs) : undefined,
      occurred_at: input.occurred_at,
      ingested_at: new Date().toISOString(),
    };
    this.events.push(event);
    this.currentBySource.set(sourceKey(input), event);
    return event;
  }

  private assertExpectedHead(
    expectedHeadId: string | null,
    current: EventRecord | null,
  ): void {
    if ((current?.id ?? null) !== expectedHeadId) {
      throw new AuthorityConflictError();
    }
  }
}

function cloneEvent(event: EventRecord): EventRecord {
  return {
    ...event,
    ...(event.required_scope_ids
      ? { required_scope_ids: [...event.required_scope_ids] }
      : {}),
    ...(event.direction_tags ? { direction_tags: [...event.direction_tags] } : {}),
    ...(event.weight_hints ? { weight_hints: structuredClone(event.weight_hints) } : {}),
    ...(event.attrs ? { attrs: structuredClone(event.attrs) } : {}),
  };
}