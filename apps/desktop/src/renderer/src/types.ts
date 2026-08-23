export type NavId = "inbox" | "engine" | "settings";

export type KernelMode = "local" | "custom";

export interface KernelSettingsView {
  mode: KernelMode;
  customOrigin: string;
  activeOrigin: string;
}

export interface ArrangementDecision {
  event_id: string;
  org_id: string;
  disposition: "current_work" | "outside_current_work" | "pending";
  layer: string;
  reason_codes: string[];
  score: number;
  decided_at: string;
}

export interface EventRecord {
  id: string;
  org_id: string;
  source: string;
  external_id: string;
  operation: string;
  content_hash?: string;
  parent_event_id?: string;
  occurred_at: string;
  ingested_at: string;
}

export interface InboxAttachment {
  filename: string;
  media_type: string;
  data_base64?: string;
}

export type MessageKind = "user" | "assistant" | "system";
export type MessageDirection = "inbound" | "outbound";

export interface InboxViewItem {
  decision: ArrangementDecision;
  event: EventRecord;
  body_text?: string;
  media_type?: string;
  attachments?: InboxAttachment[];
  channel: string;
  channel_label: string;
  kind: MessageKind;
  direction: MessageDirection;
  can_send: boolean;
  thread_id?: string;
  title?: string | null;
  pinned?: boolean;
  pref_updated_at?: string | null;
  conversation_label?: string | null;
  conversation_kind?: string | null;
  actor_label?: string | null;
}

export interface IngestAttempt {
  id: string;
  status: "running" | "succeeded" | "failed";
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
  retryable_failure_count: number;
  started_at: string;
  finished_at?: string;
  error_code?: string;
}

export interface ConnectorFieldWhen {
  field: string;
  value: string;
}

export interface ConnectorField {
  key: string;
  label: string;
  required: boolean;
  placeholder?: string;
  default?: string;
  multiple?: boolean;
  options?: { value: string; label: string }[];
  visible_when?: ConnectorFieldWhen;
}

export interface ConnectorPrerequisite {
  kind: "env" | "local_service";
  key: string;
  label: string;
  required: boolean;
  hint?: string;
  ready: boolean;
  visible_when?: ConnectorFieldWhen;
}

export interface ConnectorCatalogItem {
  connector_type: string;
  title: string;
  description: string;
  credential_hint: string;
  installed: boolean;
  instance_count: number;
  setup_ready: boolean;
  fields: ConnectorField[];
  prerequisites: ConnectorPrerequisite[];
}

export interface EngineInstallationView {
  id: string;
  connector_type: string;
  status: "enabled" | "disabled" | "needs_attention";
  label: string;
  detail: string | null;
  settings?: Record<string, string>;
  syncable: boolean;
  can_reply: boolean;
  can_create: boolean;
  channel?: string;
  channel_label?: string;
  last_attempt: IngestAttempt | null;
}

export interface CreatedConversation {
  thread_id: string;
  channel: string;
  channel_label: string;
  can_send: boolean;
  title?: string | null;
  pinned?: boolean;
  opened_at?: string;
}

export interface ConversationPrefView {
  thread_id: string;
  title: string | null;
  pinned: boolean;
  updated_at: string;
}

export interface ConnectorSyncView {
  installation_id: string;
  pages_attempted: number;
  streams_attempted: number;
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
  last_run_status: "completed" | "retryable_failure" | "lease_unavailable" | "idle";
  installation: EngineInstallationView;
}

export interface PullStatusView {
  interval_ms: number;
  last_tick_at: string | null;
  last_error: string | null;
}

export interface PersonalEngineView {
  kernel: "running" | "stopped";
  org_id: string;
  database_path: string | null;
  inbox_count: number;
  inbox_digest?: string;
  pull?: PullStatusView;
  installations: EngineInstallationView[];
  catalog: ConnectorCatalogItem[];
}

export type EngineChipState = "running" | "syncing" | "stopped";

export interface ReplyAttachmentInput {
  filename: string;
  media_type: string;
  data_base64: string;
}

export interface ReplyView {
  accepted: true;
  source: string;
  thread_id: string;
  rpc_id?: string;
  item: InboxViewItem;
}
