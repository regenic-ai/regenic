import type {
  ArrangementDecision,
  InboxDispositionTransition,
  InboxDispositionTransitionResult,
  InboxItem,
} from "./arrangement";
import type {
  ConversationDirectoryEntry,
  ConversationDirectoryQuery,
  ConversationNameUpdate,
} from "./conversation-directory";
import type { SyncPollHint, SyncStore } from "./sync-contracts";
import type { SyncWorkStore } from "./sync-work";
import type { DeliveryReceipt } from "./egress";
import type { WorkItemObservation } from "./work-transition";


import type {
  BackfillRange,
  ChannelConnector,
  ConnectorCapabilities,
  ConnectorCursor,
  ConnectorInstallation,
  ConnectorInstallationStatus,
  ConnectorPollOptions,
  ConnectorQuotaHint,
  ConnectorSourceMode,
  ContentPart,
  ExternalPrincipalRef,
  ExternalScopeRef,
  ExternalThreadRef,
  IngestBatch,
  IngestBatchResult,
  IngestErrorCode,
  IngestOperation,
  IngestRecord,
  IngestRecordResult,
  IngestRecordStatus,
  JsonValue,
  MembershipBatch,
  NewConnectorInstallation,
  PollResult,
  PushWatermark,
  VerifiedWebhook,
  WebhookRequest,
  WeightHints,
} from "@regenic/connector-contract";
export {
  INGEST_SCHEMA_VERSION,
} from "@regenic/connector-contract";
export type {
  BackfillRange,
  ChannelConnector,
  ConnectorCapabilities,
  ConnectorCursor,
  ConnectorInstallation,
  ConnectorInstallationStatus,
  ConnectorLimits,
  ConnectorPollOptions,
  ConnectorQuotaHint,
  ConnectorSourceMode,
  ContentPart,
  ContentPartRole,
  ExternalPrincipalRef,
  ExternalScopeRef,
  ExternalThreadRef,
  IngestBatch,
  IngestBatchResult,
  IngestErrorCode,
  IngestOperation,
  IngestRecord,
  IngestRecordResult,
  IngestRecordStatus,
  JsonPrimitive,
  JsonValue,
  MembershipBatch,
  NewConnectorInstallation,
  PollResult,
  PushWatermark,
  PushWatermarkPage,
  VerifiedWebhook,
  WebhookRequest,
  WeightHints,
} from "@regenic/connector-contract";

export interface BlobObject {
  hash: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface BlobStoreEntry {
  hash: string;
  byte_size: number;
}

export interface BlobStore {
  put(hash: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  putMany(items: readonly BlobObject[]): Promise<void>;
  enumerate(): AsyncIterable<BlobStoreEntry>;
  get(hash: string): Promise<Uint8Array>;
  getMany(hashes: readonly string[]): Promise<Map<string, Uint8Array>>;
  delete(hash: string): Promise<void>;
  exists(hash: string): Promise<boolean>;
  clear(): Promise<void>;
}

export interface FencedBlobStore extends BlobStore {
  putFenced(
    hash: string,
    bytes: Uint8Array,
    mediaType: string,
    generation: number,
  ): Promise<void>;
  deleteFenced(hash: string, generation: number): Promise<void>;
}

export class BlobGenerationConflictError extends Error {
  constructor(
    readonly hash: string,
    readonly requestedGeneration: number,
    readonly currentGeneration: number,
  ) {
    super(
      `Blob generation ${requestedGeneration} is stale for ${hash}; current generation is ${currentGeneration}`,
    );
    this.name = "BlobGenerationConflictError";
  }
}

/** One inbox page can name hundreds of blobs. Opening them all at once hits EMFILE. */
const BLOB_READ_CONCURRENCY = 8;

export async function collectAvailableBlobs(
  get: (hash: string) => Promise<Uint8Array>,
  hashes: readonly string[],
): Promise<Map<string, Uint8Array>> {
  const unique = [...new Set(hashes.filter((hash) => hash.length > 0))];
  const found = new Map<string, Uint8Array>();
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(BLOB_READ_CONCURRENCY, unique.length) },
    async () => {
      while (cursor < unique.length) {
        const hash = unique[cursor];
        cursor += 1;
        try {
          found.set(hash, await get(hash));
        } catch {
          // Missing or unreadable blobs stay absent; callers treat that as empty.
        }
      }
    },
  );
  await Promise.all(workers);
  return found;
}

export async function putUniqueBlobs(
  put: (hash: string, bytes: Uint8Array, mediaType: string) => Promise<void>,
  items: readonly BlobObject[],
): Promise<void> {
  const seen = new Set<string>();
  const unique: BlobObject[] = [];
  for (const item of items) {
    if (seen.has(item.hash)) {
      continue;
    }
    seen.add(item.hash);
    unique.push(item);
  }
  await Promise.all(
    unique.map((item) => put(item.hash, item.bytes, item.mediaType)),
  );
}

export interface SourceIdentity {
  org_id: string;
  source: string;
  external_id: string;
}

export class AuthorityConflictError extends Error {
  constructor() {
    super("Source head changed during ingestion");
    this.name = "AuthorityConflictError";
  }
}

export class DispositionRepairConflictError extends AuthorityConflictError {
  constructor() {
    super();
    this.message = "Disposition already exists during repair";
    this.name = "DispositionRepairConflictError";
  }
}

export class IngestPageProcessingError extends Error {
  constructor(
    readonly original_error: unknown,
    readonly partial_records: readonly IngestRecordResult[],
  ) {
    super(
      original_error instanceof Error
        ? original_error.message
        : "Ingestion page failed after partial processing",
    );
    this.name = "IngestPageProcessingError";
  }
}

export interface BlobRecord {
  content_hash: string;
  media_type: string;
  byte_size: number;
  created_at: string;
}

export interface BlobInventoryRecord extends BlobRecord {
  state: "reserved" | "available" | "deleting" | "protected";
  generation: number;
  unreferenced_at: string | null;
  write_lease_expires_at: string | null;
  reference_count: number;
}

export interface BlobInventoryPageQuery {
  after_hash?: string;
  limit: number;
}

export interface BlobInventoryPage {
  entries: BlobInventoryRecord[];
  next_after_hash: string | null;
}

export function assertBlobInventoryPageQuery(query: BlobInventoryPageQuery): void {
  if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 1000) {
    throw new Error("Blob inventory page limit must be between 1 and 1000");
  }
  if (query.after_hash !== undefined && !/^[a-f0-9]{64}$/.test(query.after_hash)) {
    throw new Error("Blob inventory cursor must be a lowercase SHA-256 hash");
  }
}

export interface EventRecord extends SourceIdentity {
  id: string;
  operation: IngestOperation;
  content_hash?: string;
  parent_event_id?: string;
  thread_id?: string;
  actor_id?: string;
  required_scope_ids?: string[];
  direction_tags?: string[];
  weight_hints?: WeightHints;
  attrs?: Record<string, JsonValue>;
  occurred_at: string;
  ingested_at: string;
}

export interface EventAttachmentReferenceBackfill {
  org_id: string;
  event_id: string;
  expected_content_hash: string;
  attachment_hashes: string[];
}

export interface BlobMetaInput {
  content_hash: string;
  media_type: string;
  byte_size: number;
}

export interface ReserveBlobWritesInput {
  owner_id: string;
  lease_duration_ms: number;
  blobs: BlobMetaInput[];
  force_write_hashes?: string[];
}

export type BlobReservation = {
  content_hash: string;
  generation: number;
} & (
  | { mode: "write"; claim_token: string }
  | { mode: "reuse" }
);

export class BlobReservationConflictError extends Error {
  readonly code = "blob_reservation_conflict";

  constructor(contentHash: string) {
    super(`Blob reservation is busy or unavailable: ${contentHash}`);
    this.name = "BlobReservationConflictError";
  }
}

export interface NewEvent extends SourceIdentity {
  id?: string;
  content_hash: string;
  content_media_type: string;
  content_byte_size: number;
  extra_blobs?: BlobMetaInput[];
  thread_id?: string;
  actor_id?: string;
  required_scope_ids?: string[];
  direction_tags?: string[];
  weight_hints?: WeightHints;
  attrs?: Record<string, JsonValue>;
  occurred_at: string;
  expected_head_id: string | null;
}

export interface RepointContentInput {
  old_content_hash: string;
  new_content_hash: string;
  content_media_type: string;
  content_byte_size: number;
  extra_blobs?: BlobMetaInput[];
  blob_reservations?: BlobReservation[];
}

export type IngestAppend = (NewEvent & {
  operation?: Exclude<IngestOperation, "tombstone">;
  parent_event_id?: string;
  revision_id?: string;
}) | (Omit<NewEvent, "content_hash" | "content_media_type" | "content_byte_size"> & {
  operation: "tombstone";
  content_hash?: string;
  content_media_type?: string;
  content_byte_size?: number;
  parent_event_id?: string;
  revision_id?: string;
});

export interface IngestCommitRequest {
  appends: IngestAppend[];
  /** Each decision must belong to a uniquely identified event in this commit. */
  dispositions: ArrangementDecision[];
  blob_reservations?: BlobReservation[];
}

export interface DispositionRepair {
  identities: SourceIdentity[];
  decision: ArrangementDecision;
}

export interface ConversationIntakeCommit {
  ingest: IngestCommitRequest;
  work_observations: WorkItemObservation[];
  visibility: ConversationPolicyVisibility[];
  disposition_repairs?: DispositionRepair[];
}

export function assertDispositionRepairs(
  repairs: readonly DispositionRepair[],
  orgId?: string,
): void {
  const eventIds = new Set<string>();
  for (const repair of repairs) {
    if (
      !repair.decision.event_id ||
      repair.identities.length === 0 ||
      (orgId !== undefined && repair.decision.org_id !== orgId) ||
      repair.identities.some((identity) =>
        !identity.source ||
        !identity.external_id ||
        identity.org_id !== repair.decision.org_id ||
        (orgId !== undefined && identity.org_id !== orgId)) ||
      eventIds.has(repair.decision.event_id)
    ) {
      throw new Error("Disposition repairs require unique existing event identities");
    }
    eventIds.add(repair.decision.event_id);
  }
}

export function assertIngestDispositionBindings(request: IngestCommitRequest): void {
  const appends = new Map<string, IngestAppend>();
  for (const append of request.appends) {
    if (append.id === undefined) continue;
    if (appends.has(append.id)) throw new Error("Ingest event IDs must be unique within a commit");
    appends.set(append.id, append);
  }
  const assigned = new Set<string>();
  for (const decision of request.dispositions) {
    const append = appends.get(decision.event_id);
    if (!decision.event_id || !append || append.org_id !== decision.org_id || assigned.has(decision.event_id)) {
      throw new Error("Ingest dispositions must match one event and organization in the same commit");
    }
    assigned.add(decision.event_id);
  }
}

export function assertEventDispositionBinding(input: {
  id?: string;
  org_id: string;
  disposition?: ArrangementDecision;
}): void {
  if (input.disposition && (!input.id || input.disposition.event_id !== input.id
    || input.disposition.org_id !== input.org_id)) {
    throw new Error("Event disposition must match the new event ID and organization");
  }
}

export interface CommitSyncPage {
  attempt: NewIngestAttempt;
  ingest?: IngestCommitRequest;
  work_observations?: WorkItemObservation[];
  disposition_repairs?: DispositionRepair[];
  settle: SettleIngestAttempt;
  prefs?: ConversationPolicyVisibility[];
}

export function assertSyncPageAttemptBinding(input: CommitSyncPage): void {
  if (input.attempt.id !== input.settle.attempt_id
    || input.attempt.connector_installation_id !== input.settle.installation_id
    || input.attempt.stream_key !== input.settle.stream_key) {
    throw new Error("Sync page attempt identity must match its settlement");
  }
  const orgId = input.attempt.org_id;
  if (input.ingest?.appends.some((event) => event.org_id !== orgId)
    || input.ingest?.dispositions.some((decision) => decision.org_id !== orgId)
    || input.prefs?.some((pref) => pref.org_id !== orgId)) {
    throw new Error("Sync page data must belong to the attempt organization");
  }
  const repairs = input.disposition_repairs ?? [];
  assertDispositionRepairs(repairs, orgId);
}

export function assertAttemptInstallationBinding(
  attempt: Pick<NewIngestAttempt, "org_id" | "connector_installation_id">,
  installation: Pick<ConnectorInstallation, "id" | "org_id"> | null | undefined,
): void {
  if (!installation || installation.id !== attempt.connector_installation_id
    || installation.org_id !== attempt.org_id) {
    throw new Error("Ingest attempt installation does not belong to its organization");
  }
}

export function assertAttemptSettlementBinding(
  attempt: IngestAttempt | null | undefined,
  input: SettleIngestAttempt,
): asserts attempt is IngestAttempt {
  if (!attempt) throw new Error(`Ingest attempt not found: ${input.attempt_id}`);
  if (attempt.connector_installation_id !== input.installation_id
    || attempt.stream_key !== input.stream_key) {
    throw new Error("Ingest attempt does not match settlement installation and stream");
  }
  if (attempt.status !== "running") throw new Error("Ingest attempt is not running");
}

export interface CommitSyncPageResult {
  attempt: IngestAttempt;
  events: EventRecord[];
}

/** Hint from ConnectorRunner so create-only pages share one Authority commit. */
export interface SyncPageCommit {
  attempt: NewIngestAttempt;
  settle: Omit<
    SettleIngestAttempt,
    | "accepted_count"
    | "duplicate_count"
    | "quarantined_count"
    | "retryable_failure_count"
    | "error_code"
    | "quarantines"
  >;
}

export interface EventRevision extends NewEvent {
  parent_event_id: string;
  revision_id?: string;
  disposition?: ArrangementDecision;
  blob_reservations?: BlobReservation[];
}

export interface TombstoneEvent extends SourceIdentity {
  id?: string;
  thread_id?: string;
  actor_id?: string;
  required_scope_ids?: string[];
  occurred_at: string;
  expected_head_id: string | null;
  disposition?: ArrangementDecision;
}

export interface ConversationPref {
  org_id: string;
  thread_id: string;
  title: string | null;
  pinned: boolean;
  /** List surface. Independent of tombstone, current_work, and WorkItem. */
  hidden: boolean;
  hidden_reason: "human" | "policy" | null;
  visibility_version: number;
  last_read_at: string | null;
  last_read_external_id: string | null;
  updated_at: string;
}

export interface ConversationPrefPatch {
  org_id: string;
  thread_id: string;
  title?: string | null;
  pinned?: boolean;
  last_read_at?: string | null;
  last_read_external_id?: string | null;
  updated_at: string;
}

export type ConversationReadCursorPatch = Pick<
  ConversationPrefPatch,
  "org_id" | "thread_id" | "last_read_at" | "last_read_external_id" | "updated_at"
>;

export function mergeConversationReadCursor(
  current: Pick<ConversationPref, "last_read_at" | "last_read_external_id"> | null,
  patch: Pick<ConversationPrefPatch, "last_read_at" | "last_read_external_id">,
): Pick<ConversationPref, "last_read_at" | "last_read_external_id"> {
  const next = {
    last_read_at:
      patch.last_read_at !== undefined
        ? patch.last_read_at
        : (current?.last_read_at ?? null),
    last_read_external_id:
      patch.last_read_external_id !== undefined
        ? patch.last_read_external_id
        : (current?.last_read_external_id ?? null),
  };
  const currentTime = current?.last_read_at
    ? Date.parse(current.last_read_at)
    : Number.NaN;
  const nextTime = next.last_read_at ? Date.parse(next.last_read_at) : Number.NaN;
  if (Number.isFinite(currentTime) && (!Number.isFinite(nextTime) || nextTime < currentTime)) {
    return {
      last_read_at: current?.last_read_at ?? null,
      last_read_external_id: current?.last_read_external_id ?? null,
    };
  }
  return next;
}

export interface ConversationPrefWrite extends ConversationPrefPatch {
  hidden?: boolean;
  hidden_reason?: "human" | "policy" | null;
}

export interface ConversationVisibilityUpdate {
  org_id: string;
  thread_id: string;
  hidden: boolean;
  expected_version: number;
  command_id?: string;
  issued_at?: string;
  updated_at: string;
  title?: string | null;
  pinned?: boolean;
}

export type ConversationVisibilityCommand = Pick<
  ConversationVisibilityUpdate,
  "thread_id" | "hidden" | "expected_version"
> & {
  issued_at?: string;
  title?: string | null;
  pinned?: boolean;
};

export function conversationVisibilityCommand(
  input: ConversationVisibilityUpdate,
): ConversationVisibilityCommand {
  return {
    thread_id: input.thread_id,
    hidden: input.hidden,
    expected_version: input.expected_version,
    ...(input.issued_at !== undefined ? { issued_at: input.issued_at } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
  };
}

export function sameConversationVisibilityCommand(
  saved: unknown,
  command: ConversationVisibilityCommand,
): boolean {
  if (typeof saved !== "object" || saved === null) {
    return false;
  }
  const value = saved as Record<string, unknown>;
  const expected = command as Record<string, unknown>;
  return ["thread_id", "hidden", "expected_version", "issued_at", "title", "pinned"]
    .every((key) =>
      value[key] === expected[key] &&
      Object.prototype.hasOwnProperty.call(value, key) ===
        Object.prototype.hasOwnProperty.call(expected, key)
    );
}

export type ConversationVisibilityUpdateResult =
  | { outcome: "applied"; pref: ConversationPref }
  | { outcome: "replayed"; pref: ConversationPref }
  | { outcome: "conflict"; current_version: number }
  | { outcome: "command_conflict" };

export interface ConversationPolicyFold {
  org_id: string;
  thread_id: string;
  expected_visibility_version: number;
  updated_at: string;
}

export interface ConversationPolicyVisibility {
  org_id: string;
  thread_id: string;
  hidden: boolean;
  expected_visibility_version: number;
  updated_at: string;
  /** For ingest-derived unfolds, require at least one of these events to remain current work. */
  unfold_current_work_event_ids?: string[];
  /** For tombstone-derived folds, require at least one of these events to remain a current head. */
  fold_current_tombstone_event_ids?: string[];
  /** Exclude a dismissed work item's trigger only after verifying it is still current work. */
  fold_excluded_current_work_event_id?: string;
}

export function assertConversationPolicyVisibility(input: ConversationPolicyVisibility): void {
  const ids = input.unfold_current_work_event_ids;
  if (ids !== undefined && (input.hidden || !Array.isArray(ids) || ids.length === 0 ||
    ids.some((id) => typeof id !== "string" || !id.trim()))) {
    throw new Error("Policy unfold requires non-empty current-work event IDs");
  }
  const tombstoneIds = input.fold_current_tombstone_event_ids;
  if (tombstoneIds !== undefined && (!input.hidden || !Array.isArray(tombstoneIds) ||
    tombstoneIds.length === 0 || tombstoneIds.some((id) => typeof id !== "string" || !id.trim()))) {
    throw new Error("Policy tombstone fold requires non-empty tombstone event IDs");
  }
  const excludedEventId = input.fold_excluded_current_work_event_id;
  if (excludedEventId !== undefined &&
    (!input.hidden || typeof excludedEventId !== "string" || !excludedEventId.trim())) {
    throw new Error("Policy fold exclusion requires a non-empty current-work event ID");
  }
}

export type ConversationPolicyFoldResult =
  | { outcome: "applied"; pref: ConversationPref }
  | { outcome: "unchanged" }
  | { outcome: "conflict"; current_version: number };

export interface EventListQuery {
  source?: string;
  target?: string;
  since?: string;
  since_id?: string;
  before?: string;
  before_id?: string;
  occurred_since?: string;
  thread_ids?: string[];
  limit?: number;
  order?: "recent" | "ingested";
}

export interface InboxQuery extends EventListQuery {
  heads?: boolean;
  /**
   * Only rows that still need a work decision.
   * A row already tied to a settled work item stays in the inbox for people.
   */
  needs_work?: boolean;
  /**
   * Filter event rows by the task arrangement reason: true selects tasks,
   * false selects non-tasks, and undefined selects both.
   * Background observe pages messages separately so they cannot starve tasks.
   * Conversation faces stay on `heads`.
   */
  tasks?: boolean;
  siblings?: boolean;
  /** Default `current_work`. `pending` exposes items for explicit review. */
  disposition?: "current_work" | "pending";
  /**
   * Event scans of current work also consider automatically pending rows and
   * policy-folded threads. Human pending/hidden and outside-current-work remain
   * excluded. Does not change the disposition or the conversation list;
   * matching enabled push rules remain the execution gate for non-tasks.
   */
  push_candidates?: boolean;
  /** Default `shown`. `hidden` is the folded list, not deleted Events. */
  list?: "shown" | "hidden";
}

export interface InboxSummary {
  count: number;
  /** Conversations on the Hidden list (prefs.hidden with a thread head). */
  hidden_count: number;
  digest: string;
}

export interface StoreFootprint {
  events: number;
  conversations: number;
  work_items: number;
  blobs: number;
  context_artifacts: number;
  context_snapshots: number;
  context_snapshot_index: number;
  context_bundles: number;
  context_checkpoints: number;
  recipes: number;
  connectors: number;
  executors: number;
}

export interface StoreClearResult {
  cleared: {
    events: number;
    conversations: number;
    work_items: number;
    blobs: number;
    context_artifacts: number;
    context_snapshots: number;
    context_snapshot_index: number;
    context_bundles: number;
    context_checkpoints: number;
  };
  kept: {
    recipes: number;
    connectors: number;
    executors: number;
  };
}

export interface SourceIdentityAliasBind {
  org_id: string;
  event_id: string;
  aliases: Array<{ source: string; external_id: string }>;
}

export interface OutboundAttemptRecord {
  org_id: string;
  client_request_id: string;
  thread_id: string;
  event_id?: string;
  status: "pending" | "accepted" | "sent" | "failed" | "rejected";
  channel_message_ids?: string[];
  recovery_hash?: string;
  receipt?: DeliveryReceipt;
  created_at: string;
  updated_at: string;
}

export interface OutboundAttemptPut {
  org_id: string;
  client_request_id: string;
  thread_id: string;
  event_id?: string;
  status: OutboundAttemptRecord["status"];
  channel_message_ids?: string[];
  recovery_hash?: string;
  blob_reservations?: BlobReservation[];
  receipt?: DeliveryReceipt;
  now: string;
}

export type NewOutboundAttempt = Pick<
  OutboundAttemptPut,
  "org_id" | "client_request_id" | "thread_id" | "recovery_hash" | "blob_reservations" | "now"
>;

export interface AuthorityStore {
  findBlob(contentHash: string): Promise<BlobRecord | null>;
  findBlobs(
    contentHashes: readonly string[],
  ): Promise<Map<string, BlobRecord>>;
  inspectBlobInventory(
    contentHashes: readonly string[],
  ): Promise<Map<string, BlobInventoryRecord>>;
  listBlobInventoryPage(query: BlobInventoryPageQuery): Promise<BlobInventoryPage>;
  reserveBlobWrites(input: ReserveBlobWritesInput): Promise<BlobReservation[]>;
  releaseBlobReservations(reservations: readonly BlobReservation[]): Promise<void>;
  findBySourceIdentity(identity: SourceIdentity): Promise<EventRecord | null>;
  /**
   * Point additional `(source, external_id)` heads at an existing Event so
   * channel-native pull ids resolve to the local outbound without content echo.
   * New aliases require the event to remain a current source head.
   */
  bindSourceIdentityAliases(input: SourceIdentityAliasBind): Promise<void>;
  getOutboundAttempt(
    orgId: string,
    clientRequestId: string,
  ): Promise<OutboundAttemptRecord | null>;
  /** Claim new or explicitly rejected attempts; never reclaim ambiguous sends. */
  claimOutboundAttempt(input: NewOutboundAttempt): Promise<boolean>;
  putOutboundAttempt(input: OutboundAttemptPut): Promise<OutboundAttemptRecord>;
  getEvent(orgId: string, eventId: string): Promise<EventRecord | null>;
  listEvents(orgId: string, query?: EventListQuery): Promise<EventRecord[]>;
  backfillEventAttachmentReferences(input: EventAttachmentReferenceBackfill): Promise<void>;
  append(input: NewEvent): Promise<EventRecord>;
  appendRevision(input: EventRevision): Promise<EventRecord>;
  markTombstone(input: TombstoneEvent): Promise<EventRecord>;
  commitIngest(request: IngestCommitRequest): Promise<EventRecord[]>;
  commitConversationIntake(request: ConversationIntakeCommit): Promise<EventRecord[]>;
  repointContentHash(input: RepointContentInput): Promise<number>;
  vacuumStore(): Promise<void>;
  putDispositionIfAbsent(decision: ArrangementDecision): Promise<boolean>;
  transitionDisposition(input: InboxDispositionTransition): Promise<InboxDispositionTransitionResult>;
  getDisposition(eventId: string): Promise<ArrangementDecision | null>;
  listInbox(orgId: string, query?: InboxQuery): Promise<InboxItem[]>;
  searchConversationDirectory(
    orgId: string,
    query?: ConversationDirectoryQuery,
  ): Promise<ConversationDirectoryEntry[]>;
  rememberConversationNames(
    orgId: string,
    names: readonly ConversationNameUpdate[],
  ): Promise<void>;
  summarizeInbox(orgId: string): Promise<InboxSummary>;
  listConversationPrefs(orgId: string): Promise<ConversationPref[]>;
  getConversationPref(
    orgId: string,
    threadId: string,
  ): Promise<ConversationPref | null>;
  putConversationPref(input: ConversationPrefPatch): Promise<ConversationPref>;
  setConversationVisibility(
    input: ConversationVisibilityUpdate,
  ): Promise<ConversationVisibilityUpdateResult>;
  setConversationPolicyHidden(
    input: ConversationPolicyFold,
  ): Promise<ConversationPolicyFoldResult>;
  setConversationPolicyVisibility(
    input: ConversationPolicyVisibility,
  ): Promise<ConversationPolicyFoldResult>;
  summarizeStore(orgId: string): Promise<StoreFootprint>;
  clearOperationalData(orgId: string, now: string): Promise<StoreClearResult>;
}


export interface ConnectorStreamCursor {
  installation_id: string;
  stream_key: string;
  cursor?: string;
  cursor_version: number;
  updated_at: string;
}

export interface ConnectorLease extends ConnectorStreamCursor {
  lease_owner: string;
  claim_token: string;
  lease_expires_at: string;
}

export interface AcquireConnectorLease {
  installation_id: string;
  stream_key: string;
  lease_owner: string;
  now: string;
  lease_duration_ms: number;
  /** Interactive open-thread poll may take a lease held by background work. */
  preempt?: boolean;
}

export interface ReleaseConnectorLease {
  installation_id: string;
  stream_key: string;
  lease_owner: string;
  claim_token: string;
  now: string;
}

export interface RenewConnectorLease extends ReleaseConnectorLease {
  lease_duration_ms: number;
}

export interface SetConnectorInstallationStatus {
  id: string;
  org_id: string;
  status: ConnectorInstallationStatus;
  updated_at: string;
}

export interface SetConnectorInstallationConfig {
  id: string;
  org_id: string;
  config: Record<string, JsonValue>;
  updated_at: string;
}

export interface ResetConnectorCursor {
  installation_id: string;
  stream_key: string;
  now: string;
}

export type IngestAttemptStatus = "running" | "succeeded" | "failed";

export interface IngestAttempt {
  id: string;
  org_id: string;
  connector_installation_id: string;
  stream_key: string;
  delivery_id: string;
  started_at: string;
  finished_at?: string;
  status: IngestAttemptStatus;
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
  retryable_failure_count: number;
  error_code?: string;
}

export interface NewIngestAttempt {
  id: string;
  org_id: string;
  connector_installation_id: string;
  stream_key: string;
  delivery_id: string;
  started_at: string;
}

export interface NewIngestQuarantine {
  id: string;
  record_external_id: string;
  reason_code: IngestErrorCode;
  safe_metadata: Record<string, JsonValue>;
  created_at: string;
}

export interface IngestQuarantine extends NewIngestQuarantine {
  attempt_id: string;
  connector_installation_id: string;
  stream_key: string;
}

export interface SettleIngestAttempt {
  attempt_id: string;
  installation_id: string;
  stream_key: string;
  lease_owner: string;
  claim_token: string;
  finished_at: string;
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
  retryable_failure_count: number;
  error_code?: string;
  next_cursor?: string;
  quarantines: NewIngestQuarantine[];
}

export function ingestAttemptSummary(
  records: readonly IngestRecordResult[],
): Pick<
  SettleIngestAttempt,
  | "accepted_count"
  | "duplicate_count"
  | "quarantined_count"
  | "retryable_failure_count"
  | "error_code"
> {
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
    ...(retryable?.error_code ? { error_code: retryable.error_code } : {}),
  };
}

export function ingestAttemptQuarantines(
  records: readonly IngestRecordResult[],
  now: string,
  id: () => string,
): NewIngestQuarantine[] {
  return records
    .filter((record) => record.status === "quarantined")
    .map((record) => ({
      id: id(),
      record_external_id: record.external_id,
      reason_code: record.error_code ?? "invalid_record",
      safe_metadata: {},
      created_at: now,
    }));
}

export interface ListPushWatermarksQuery {
  stream_keys?: readonly string[];
  /** Exclusive `stream_key` cursor; pages are ordered by `stream_key`. */
  after?: string;
  limit?: number;
}

export interface PushWatermarkSummary {
  stream_count: number;
  last_updated_at?: string;
}

/** Per-stream push positions, O(installations) to summarize. */
export interface PushWatermarkStore {
  recordPushWatermark(input: PushWatermark): Promise<void>;
  listPushWatermarks(
    installationId: string,
    query?: ListPushWatermarksQuery,
  ): Promise<PushWatermark[]>;
  summarizePushWatermarks(installationId: string): Promise<PushWatermarkSummary>;
}

export interface ConnectorRuntimeStore extends SyncStore, SyncWorkStore, PushWatermarkStore {
  /** commitSyncPage atomically commits Authority data and runtime settlement in this store. */
  readonly atomicSyncPage?: true;
  createInstallation(input: NewConnectorInstallation): Promise<ConnectorInstallation>;
  findInstallation(id: string): Promise<ConnectorInstallation | null>;
  listInstallations(orgId: string): Promise<ConnectorInstallation[]>;
  setInstallationStatus(input: SetConnectorInstallationStatus): Promise<ConnectorInstallation | null>;
  updateInstallationConfig(input: SetConnectorInstallationConfig): Promise<ConnectorInstallation | null>;
  deleteInstallation(id: string, orgId: string): Promise<boolean>;
  acquireLease(input: AcquireConnectorLease): Promise<ConnectorLease | null>;
  renewLease(input: RenewConnectorLease): Promise<ConnectorLease | null>;
  releaseLease(input: ReleaseConnectorLease): Promise<boolean>;
  resetCursor(input: ResetConnectorCursor): Promise<ConnectorStreamCursor | null>;
  beginAttempt(input: NewIngestAttempt): Promise<IngestAttempt>;
  commitSyncPage(input: CommitSyncPage): Promise<CommitSyncPageResult>;
  settleAttempt(input: SettleIngestAttempt): Promise<IngestAttempt>;
  listAttempts(installationId: string, limit?: number): Promise<IngestAttempt[]>;
  latestAttempt(installationId: string): Promise<IngestAttempt | null>;
  listQuarantines(installationId: string): Promise<IngestQuarantine[]>;
  getCursor(
    installationId: string,
    streamKey: string,
  ): Promise<ConnectorStreamCursor | null>;
  listCursors(
    installationId: string,
    streamKeys?: readonly string[],
  ): Promise<ConnectorStreamCursor[]>;
}