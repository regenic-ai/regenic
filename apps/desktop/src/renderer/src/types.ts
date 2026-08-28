export type NavId = "inbox" | "recipes" | "engine" | "settings";

export type KernelMode = "local" | "custom";
export type Locale = "en" | "zh";
export type DataPathSource = "env" | "settings" | "repo" | "default" | "relocated";
export type DataDirectoryAction = "migrate" | "empty" | "adopt" | "replace";

export interface DataDirectoryView {
  path: string;
  database: string;
  blobRoot: string;
  source: DataPathSource;
  envOverride: boolean;
  productRoot: string;
  checkoutRoot?: string;
  relocatedFrom?: string;
  splitLayout: boolean;
  canChange: boolean;
  remoteWarning: boolean;
}

export interface DataDirectoryPlan {
  path: string;
  currentRoot: string;
  sameAsCurrent: boolean;
  sourceHasData: boolean;
  destHasData: boolean;
  destLooksLikeStore: boolean;
  remoteWarning: boolean;
  relocatedTo?: string;
  pickedPath?: string;
  canChange: boolean;
  reason?: string;
}

export interface SourceRetentionView {
  path: string;
  size: string;
  bytes: number;
  canDelete: boolean;
}

export interface KernelSettingsView {
  mode: KernelMode;
  customOrigin: string;
  activeOrigin: string;
  locale: Locale;
  dataDirectory: DataDirectoryView;
  sourceRetention?: SourceRetentionView;
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
export type ThreadActivity = "awaiting_user" | "working";
export type ListTitleMode = "conversation" | "face" | "prompt";
export type PromptPresentation = "choice" | "approval" | "plan_review";
export type ReceiptState = "sent" | "read";

export interface MessageReceipt {
  state: ReceiptState;
  read_at?: string;
  read_count?: number;
}

export interface PromptOption {
  label: string;
  description?: string;
  emphasized?: boolean;
}

export interface PromptQuestion {
  id: string;
  prompt: string;
  options?: PromptOption[];
  multi_select?: boolean;
  allow_custom?: boolean;
}

export interface ThreadPrompt {
  prompt_id: string;
  presentation: PromptPresentation;
  title?: string;
  detail?: string;
  questions: PromptQuestion[];
}

export interface PromptAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

export function normalizeListTitle(value: unknown): ListTitleMode {
  if (value === "conversation" || value === "prompt") {
    return value;
  }
  return "face";
}

export type RecordClass = "utterance" | "task" | "status" | "prompt";
export type ThreadFacet = "chat" | "agent" | "ticket";
export type AttentionClass =
  | "waiting_you"
  | "needs_ack"
  | "running"
  | "unread"
  | "quiet";
export type InboxSortMode = "normal" | "attention";
export type WorkItemStatus =
  | "open"
  | "running"
  | "waiting_human"
  | "done"
  | "failed"
  | "skipped";

export type WorkDeliveryStatus =
  | "queued"
  | "running"
  | "write_back"
  | "acked"
  | "dead";

export type WorkWriteBackState = "pending" | "sent" | "skipped" | "failed";

export interface WorkDeliveryFace {
  status: WorkDeliveryStatus;
  write_back: WorkWriteBackState;
  attempts: number;
  last_error?: string;
}

export interface WorkFace {
  id: string;
  status: WorkItemStatus;
  recipe_id?: string;
  executor_type?: string;
  agent_thread_id?: string;
  head_event_id?: string;
  can_write_back?: boolean;
  has_result?: boolean;
  result_summary?: string;
  delivery?: WorkDeliveryFace;
  updated_at?: string;
}

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
  await_reply?: boolean;
  list_title?: ListTitleMode;
  thread_id?: string;
  title?: string | null;
  pinned?: boolean;
  pref_updated_at?: string | null;
  conversation_label?: string | null;
  conversation_kind?: string | null;
  actor_label?: string | null;
  activity?: ThreadActivity;
  prompts?: ThreadPrompt[];
  unread?: boolean;
  unread_count?: number;
  can_receipt?: boolean;
  receipt?: MessageReceipt;
  record_class?: RecordClass;
  thread_facet?: ThreadFacet;
  attention?: AttentionClass;
  work?: WorkFace;
}

export interface ExecutorCatalogField {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  default?: string;
  hint?: string;
  kind?: "text" | "textarea" | "select";
  options?: Array<{ value: string; label: string }>;
}

export type ExecutorKind = "local_connector" | "http";
export type ExecutorInstallStatus = "enabled" | "disabled";

export interface ExecutorCatalogEntry {
  executor_type: string;
  label: string;
  description?: string;
  params_label?: string;
  source?: string;
  attach?: "interactive" | "absentee";
  installation_id?: string;
  kind?: ExecutorKind;
  fields: ExecutorCatalogField[];
}

export interface EngineExecutorView {
  id: string;
  kind: ExecutorKind;
  name: string;
  status: ExecutorInstallStatus;
  label: string;
  detail: string | null;
  connector_id?: string;
  base_url?: string;
  auth_env?: string;
}

export interface ExecutorKindField {
  key: string;
  label: string;
  required: boolean;
  placeholder?: string;
  hint?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface ExecutorKindCatalogItem {
  kind: ExecutorKind;
  title: string;
  description: string;
  credential_hint: string;
  installed: boolean;
  instance_count: number;
  setup_ready: boolean;
  fields: ExecutorKindField[];
  docs: CatalogDocRef[];
}

export interface RecipeMatch {
  record_class?: RecordClass;
  thread_facet?: ThreadFacet;
  source?: string;
  thread_id?: string;
}

export type RecipeTriggerKind = "push" | "pull" | "manual";

export interface RecipeTrigger {
  kind: RecipeTriggerKind;
  interval_ms?: number;
  coalesce?: boolean;
}

export interface RecipeLastRun {
  status: string;
  at: string;
  summary?: string;
}

export interface RecipeView {
  id: string;
  org_id: string;
  name: string;
  match: RecipeMatch;
  trigger: RecipeTrigger;
  executor_type: string;
  executor_config: Record<string, string>;
  can_write_back: boolean;
  include_context: boolean;
  enabled: boolean;
  next_run_at?: string;
  last_run?: RecipeLastRun;
  created_at: string;
  updated_at: string;
}

export interface RecipeSeed {
  thread_id: string;
  source?: string;
  title?: string;
}

export interface RecipeSourceOption {
  id: string;
  label: string;
}

export interface RecipeConversationOption {
  id: string;
  label: string;
  source?: string;
  can_send?: boolean;
}

export interface UiPrefsView {
  inbox_sort: InboxSortMode;
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

export interface CatalogDocRef {
  id: string;
  title: string;
  href: string;
  href_zh: string;
}

export interface ConnectorCatalogItem {
  connector_type: string;
  title: string;
  description: string;
  credential_hint: string;
  installed: boolean;
  instance_count: number;
  setup_ready: boolean;
  singleton: boolean;
  fields: ConnectorField[];
  prerequisites: ConnectorPrerequisite[];
  docs: CatalogDocRef[];
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
  await_reply?: boolean;
  list_title?: ListTitleMode;
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

export interface LocalNetworkWatch {
  kind: "ok" | "proxy" | "blocked";
  proxy: string | null;
  hint: string | null;
}

export type PullPhase = "idle" | "pulling";
export type PullStreamPhase = "idle" | "pulling" | "catching_up" | "error";
export type PullStreamWork = "live" | "history";

export interface PullStreamStatus {
  stream_key: string;
  thread_id: string | null;
  label: string | null;
  phase: PullStreamPhase;
  work?: PullStreamWork | null;
  last_error: string | null;
}

export interface PullStatusView {
  interval_ms: number;
  last_tick_at: string | null;
  last_error: string | null;
  last_error_hint: string | null;
  network: LocalNetworkWatch;
  phase: PullPhase;
  catching_up_count: number;
  last_accepted_count: number;
  last_pages: number;
  streams: PullStreamStatus[];
}

export interface ProcessMemoryView {
  rss_bytes: number;
  heap_used_bytes: number;
}

export interface PersonalEngineView {
  kernel: "running" | "stopped";
  org_id: string;
  database_path: string | null;
  inbox_count: number;
  inbox_digest?: string;
  memory?: ProcessMemoryView;
  pull?: PullStatusView;
  installations: EngineInstallationView[];
  catalog: ConnectorCatalogItem[];
  executor_installations: EngineExecutorView[];
  executor_catalog: ExecutorKindCatalogItem[];
}

export interface StoreView {
  events: number;
  conversations: number;
  work_items: number;
  blobs: number;
  recipes: number;
  connectors: number;
  executors: number;
}

export interface StoreClearView {
  cleared: {
    events: number;
    conversations: number;
    work_items: number;
    blobs: number;
  };
  kept: {
    recipes: number;
    connectors: number;
    executors: number;
  };
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

export interface WhatsAppImportView {
  file_hash: string;
  accepted_count: number;
  duplicate_count: number;
  invalid_line_count: number;
  errors: Array<{ line: number; code: string; message: string }>;
}
