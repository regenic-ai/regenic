import type { ArrangementDecision, InboxItem } from "./arrangement";
import type { SyncPollHint, SyncStore } from "./sync-contracts";
import type { SyncWorkStore } from "./sync-work";


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
  VerifiedWebhook,
  WebhookRequest,
  WeightHints,
} from "@regenic/connector-contract";

export interface BlobObject {
  hash: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface BlobStore {
  put(hash: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  putMany(items: readonly BlobObject[]): Promise<void>;
  get(hash: string): Promise<Uint8Array>;
  getMany(hashes: readonly string[]): Promise<Map<string, Uint8Array>>;
  delete(hash: string): Promise<void>;
  exists(hash: string): Promise<boolean>;
  clear(): Promise<void>;
}

export async function collectAvailableBlobs(
  get: (hash: string) => Promise<Uint8Array>,
  hashes: readonly string[],
): Promise<Map<string, Uint8Array>> {
  const found = new Map<string, Uint8Array>();
  await Promise.all(
    [...new Set(hashes.filter((hash) => hash.length > 0))].map(async (hash) => {
      try {
        found.set(hash, await get(hash));
      } catch {
        // Missing or unreadable blobs stay absent; callers treat that as empty.
      }
    }),
  );
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

export interface BlobRecord {
  content_hash: string;
  media_type: string;
  byte_size: number;
  created_at: string;
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

export interface BlobMetaInput {
  content_hash: string;
  media_type: string;
  byte_size: number;
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
}

export interface IngestCommitRequest {
  appends: NewEvent[];
  dispositions: ArrangementDecision[];
}

export interface CommitSyncPage {
  attempt: NewIngestAttempt;
  ingest?: IngestCommitRequest;
  settle: SettleIngestAttempt;
  prefs?: ConversationPrefPatch[];
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
}

export interface TombstoneEvent extends SourceIdentity {
  thread_id?: string;
  actor_id?: string;
  required_scope_ids?: string[];
  occurred_at: string;
  expected_head_id: string | null;
}

export interface ConversationPref {
  org_id: string;
  thread_id: string;
  title: string | null;
  pinned: boolean;
  /** List surface. Independent of tombstone, current_work, and WorkItem. */
  hidden: boolean;
  hidden_reason: "human" | "policy" | null;
  last_read_at: string | null;
  last_read_external_id: string | null;
  updated_at: string;
}

export interface ConversationPrefPatch {
  org_id: string;
  thread_id: string;
  title?: string | null;
  pinned?: boolean;
  hidden?: boolean;
  hidden_reason?: "human" | "policy" | null;
  last_read_at?: string | null;
  last_read_external_id?: string | null;
  updated_at: string;
}

export interface EventListQuery {
  source?: string;
  target?: string;
  since?: string;
  since_id?: string;
  before?: string;
  before_id?: string;
  thread_ids?: string[];
  limit?: number;
}

export interface InboxQuery extends EventListQuery {
  heads?: boolean;
  siblings?: boolean;
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
  status: "pending" | "accepted" | "sent" | "failed";
  channel_message_ids?: string[];
  created_at: string;
  updated_at: string;
}

export interface OutboundAttemptPut {
  org_id: string;
  client_request_id: string;
  thread_id: string;
  event_id?: string;
  status: "pending" | "accepted" | "sent" | "failed";
  channel_message_ids?: string[];
  now: string;
}

export interface AuthorityStore {
  findBlob(contentHash: string): Promise<BlobRecord | null>;
  findBlobs(
    contentHashes: readonly string[],
  ): Promise<Map<string, BlobRecord>>;
  findBySourceIdentity(identity: SourceIdentity): Promise<EventRecord | null>;
  /**
   * Point additional `(source, external_id)` heads at an existing Event so
   * channel-native pull ids resolve to the local outbound without content echo.
   */
  bindSourceIdentityAliases(input: SourceIdentityAliasBind): Promise<void>;
  getOutboundAttempt(
    orgId: string,
    clientRequestId: string,
  ): Promise<OutboundAttemptRecord | null>;
  putOutboundAttempt(input: OutboundAttemptPut): Promise<OutboundAttemptRecord>;
  getEvent(orgId: string, eventId: string): Promise<EventRecord | null>;
  listEvents(orgId: string, query?: EventListQuery): Promise<EventRecord[]>;
  append(input: NewEvent): Promise<EventRecord>;
  appendRevision(input: EventRevision): Promise<EventRecord>;
  markTombstone(input: TombstoneEvent): Promise<EventRecord>;
  commitIngest(request: IngestCommitRequest): Promise<EventRecord[]>;
  repointContentHash(input: RepointContentInput): Promise<number>;
  vacuumStore(): Promise<void>;
  putDisposition(decision: ArrangementDecision): Promise<void>;
  getDisposition(eventId: string): Promise<ArrangementDecision | null>;
  listInbox(orgId: string, query?: InboxQuery): Promise<InboxItem[]>;
  summarizeInbox(orgId: string): Promise<InboxSummary>;
  listConversationPrefs(orgId: string): Promise<ConversationPref[]>;
  getConversationPref(
    orgId: string,
    threadId: string,
  ): Promise<ConversationPref | null>;
  putConversationPref(input: ConversationPrefPatch): Promise<ConversationPref>;
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
  now: string;
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

export interface ConnectorRuntimeStore extends SyncStore, SyncWorkStore {
  createInstallation(input: NewConnectorInstallation): Promise<ConnectorInstallation>;
  findInstallation(id: string): Promise<ConnectorInstallation | null>;
  listInstallations(orgId: string): Promise<ConnectorInstallation[]>;
  setInstallationStatus(input: SetConnectorInstallationStatus): Promise<ConnectorInstallation | null>;
  updateInstallationConfig(input: SetConnectorInstallationConfig): Promise<ConnectorInstallation | null>;
  deleteInstallation(id: string, orgId: string): Promise<boolean>;
  acquireLease(input: AcquireConnectorLease): Promise<ConnectorLease | null>;
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