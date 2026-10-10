import type { SyncPollHint } from "./sync";

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
  evidence_class?: "metric" | "demo" | "user_verbatim" | "decision_record" | "opinion";
  role_tier?: number;
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
    | { bytes: Uint8Array; text?: never; external_locator?: string }
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

export interface ConnectorPollOptions {
  /** One older/history page instead of the live/recent page. */
  older?: boolean;
  /** One latest page for the thread the user just opened. Serializable across hosts. */
  latest?: boolean;
  /**
   * In-process cancellation. Hosts build this from their deadline.
   * It is not part of the JSON envelope.
   */
  signal?: AbortSignal;
  /**
   * Download attachments.
   * - `false`: text/history only; enqueue media jobs but do not download.
   * - `true`: media lane only; drain queued downloads without fetching text.
   * - omitted: text page and drain (legacy connectors / tests).
   */
  media?: boolean;
}

export interface PollResult {
  batch: IngestBatch;
  next_cursor?: string;
  has_more?: boolean;
  /** Remaining attachment jobs after this page. Opaque to the kernel. */
  media_pending?: boolean;
  /** Optional lifecycle hint so core scheduling stays wire-agnostic. Required for poll connectors. */
  poll_hint?: SyncPollHint;
}

export interface BackfillRange {
  from: string;
  to: string;
}

export interface MembershipBatch {
  scope: ExternalScopeRef;
  members: ExternalPrincipalRef[];
}

export type ConnectorSourceMode = "poll" | "webhook" | "hybrid";

export const INGEST_RECORD_TYPES = [
  "message",
  "thread_reply",
  "task",
  "thread_status",
  "prompt",
] as const;

export type IngestRecordType = (typeof INGEST_RECORD_TYPES)[number];

export function isIngestRecordType(value: unknown): value is IngestRecordType {
  return (
    value === "message" ||
    value === "thread_reply" ||
    value === "task" ||
    value === "thread_status" ||
    value === "prompt"
  );
}

export interface ConnectorQuotaHint {
  tokens: number;
  window_ms: number;
}

export interface ChannelConnector {
  readonly source: string;
  /**
   * Declared pull/push mode. Omit for poll-only.
   * Undeclared methods must not exist; the kernel never infers them.
   */
  readonly source_mode?: ConnectorSourceMode;
  /**
   * Optional install-level token bucket. The kernel applies one default
   * from env; a connector may declare a tighter budget. Not per-source.
   */
  readonly quota?: ConnectorQuotaHint;

  poll?(
    cursor: ConnectorCursor | null,
    options?: ConnectorPollOptions,
  ): Promise<PollResult>;
  capabilities?(): ConnectorCapabilities;
  verifyWebhook?(request: WebhookRequest): Promise<VerifiedWebhook>;
  handleWebhook?(webhook: VerifiedWebhook): Promise<IngestBatch>;
  backfill?(range: BackfillRange): AsyncIterable<IngestBatch>;
  syncMembers?(scope: ExternalScopeRef): Promise<MembershipBatch>;
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
