import type { ArrangementDecision, InboxItem } from "./arrangement";

export const INGEST_SCHEMA_VERSION = "1.0" as const;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ExternalPrincipalRef {
  id: string;
  display_name?: string;
}

export interface ExternalScopeRef {
  id: string;
  name?: string;
}

export interface ExternalThreadRef {
  id: string;
}

export interface WeightHints {
  urgency?: number;
  importance?: number;
}

export type ContentPartRole =
  | "body"
  | "attachment"
  | "transcript"
  | "metadata";

interface ContentPartBase {
  role: ContentPartRole;
  media_type: string;
  source_filename?: string;
}

export type ContentPart = ContentPartBase &
  (
    | { bytes: Uint8Array; text?: never; external_locator?: never }
    | { bytes?: never; text: string; external_locator?: never }
    | { bytes?: never; text?: never; external_locator: string }
  );

export type IngestOperation = "create" | "revise" | "tombstone";

export interface IngestRecord {
  operation: IngestOperation;
  source: string;
  external_id: string;
  revision_id?: string;
  occurred_at: string;
  actor: ExternalPrincipalRef;
  scope: ExternalScopeRef;
  type: string;
  thread?: ExternalThreadRef;
  parent_external_id?: string;
  content?: ContentPart[];
  direction_tags?: string[];
  weight_hints?: WeightHints;
  attrs?: Record<string, JsonValue>;
}

export interface IngestBatch {
  schema_version: typeof INGEST_SCHEMA_VERSION;
  connector_id: string;
  org_id: string;
  delivery_id: string;
  records: IngestRecord[];
  next_cursor?: string;
  received_at: string;
}

export type IngestRecordStatus =
  | "accepted"
  | "duplicate"
  | "quarantined"
  | "retryable_failure";

export type IngestErrorCode =
  | "invalid_envelope"
  | "invalid_record"
  | "connector_mismatch"
  | "authority_boundary_mismatch"
  | "principal_unresolved"
  | "scope_unresolved"
  | "content_unavailable"
  | "source_identity_conflict"
  | "concurrent_source_update"
  | "internal_error"
  | "unsupported_record_type";

export interface IngestRecordResult {
  external_id: string;
  status: IngestRecordStatus;
  event_id?: string;
  error_code?: IngestErrorCode;
}

export interface IngestBatchResult {
  connector_id: string;
  delivery_id: string;
  records: IngestRecordResult[];
}

export interface ConnectorCapabilities {
  webhook: boolean;
  poll: boolean;
  backfill: boolean;
  member_sync: boolean;
  edits: boolean;
  tombstones: boolean;
  attachments: boolean;
}

export interface WebhookRequest {
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: Uint8Array;
  received_at: string;
}

export interface VerifiedWebhook {
  body: Uint8Array;
  verified_at: string;
}

export interface ConnectorCursor {
  value: string;
}

export interface PollResult {
  batch: IngestBatch;
  next_cursor?: string;
}

export interface BackfillRange {
  from: string;
  to: string;
}

export interface MembershipBatch {
  scope: ExternalScopeRef;
  members: ExternalPrincipalRef[];
}

export interface ChannelConnector {
  readonly source: string;

  capabilities(): ConnectorCapabilities;
  verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook>;
  handleWebhook(webhook: VerifiedWebhook): Promise<IngestBatch>;
  poll(cursor: ConnectorCursor | null): Promise<PollResult>;
  backfill(range: BackfillRange): AsyncIterable<IngestBatch>;
  syncMembers(scope: ExternalScopeRef): Promise<MembershipBatch>;
}

export interface BlobStore {
  put(hash: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  get(hash: string): Promise<Uint8Array>;
  delete(hash: string): Promise<void>;
  exists(hash: string): Promise<boolean>;
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
  occurred_at: string;
  ingested_at: string;
}

export interface NewEvent extends SourceIdentity {
  content_hash: string;
  content_media_type: string;
  content_byte_size: number;
  occurred_at: string;
  expected_head_id: string | null;
}

export interface EventRevision extends NewEvent {
  parent_event_id: string;
  revision_id?: string;
}

export interface TombstoneEvent extends SourceIdentity {
  occurred_at: string;
  expected_head_id: string | null;
}

export interface ConversationPref {
  org_id: string;
  thread_id: string;
  title: string | null;
  pinned: boolean;
  updated_at: string;
}

export interface ConversationPrefPatch {
  org_id: string;
  thread_id: string;
  title?: string | null;
  pinned?: boolean;
  updated_at: string;
}

export interface AuthorityStore {
  findBlob(contentHash: string): Promise<BlobRecord | null>;
  findBySourceIdentity(identity: SourceIdentity): Promise<EventRecord | null>;
  listEvents(orgId: string): Promise<EventRecord[]>;
  append(input: NewEvent): Promise<EventRecord>;
  appendRevision(input: EventRevision): Promise<EventRecord>;
  markTombstone(input: TombstoneEvent): Promise<EventRecord>;
  putDisposition(decision: ArrangementDecision): Promise<void>;
  getDisposition(eventId: string): Promise<ArrangementDecision | null>;
  listInbox(orgId: string): Promise<InboxItem[]>;
  listConversationPrefs(orgId: string): Promise<ConversationPref[]>;
  getConversationPref(
    orgId: string,
    threadId: string,
  ): Promise<ConversationPref | null>;
  putConversationPref(input: ConversationPrefPatch): Promise<ConversationPref>;
}

export type ConnectorInstallationStatus =
  | "enabled"
  | "disabled"
  | "needs_attention";

export interface ConnectorInstallation {
  id: string;
  org_id: string;
  connector_type: string;
  status: ConnectorInstallationStatus;
  config: Record<string, JsonValue>;
  credentials_ref?: string;
  created_at: string;
  updated_at: string;
}

export interface NewConnectorInstallation {
  id: string;
  org_id: string;
  connector_type: string;
  status: ConnectorInstallationStatus;
  config: Record<string, JsonValue>;
  credentials_ref?: string;
  created_at: string;
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

export interface ConnectorRuntimeStore {
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
  settleAttempt(input: SettleIngestAttempt): Promise<IngestAttempt>;
  listAttempts(installationId: string): Promise<IngestAttempt[]>;
  listQuarantines(installationId: string): Promise<IngestQuarantine[]>;
  getCursor(
    installationId: string,
    streamKey: string,
  ): Promise<ConnectorStreamCursor | null>;
}