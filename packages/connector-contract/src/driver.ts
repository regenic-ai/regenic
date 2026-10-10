import type { Plugin, PluginHandle } from "@regenic/plugin-host";
import type {
  AttentionAck,
  MessageReceipt,
  PromptAnswer,
  ThreadAttention,
  ThreadInboundCursor,
  ThreadPrompt,
} from "./attention";
import type { CopyRef, LocaleHref, PluginLocaleTable } from "./copy";
import type {
  DeliveryReceipt,
  EgressRegistry,
  RegisteredEgress,
} from "./egress";
import type {
  ChannelConnector,
  ConnectorInstallation,
  IngestBatch,
  NewConnectorInstallation,
  ConnectorSourceMode,
} from "./ingest";
import type { KeychainSecretRef } from "./credentials";
import type { SyncCatalogMember, SyncSource } from "./sync";

export interface UnitKindEntry {
  id: string;
  label: CopyRef;
}

export interface SubjectCatalog {
  kinds: UnitKindEntry[];
}

export interface ConnectorSecrets {
  read(
    connectorType: string,
    installationId: string,
    field: string,
  ): Promise<string | undefined>;
  write(ref: KeychainSecretRef, secret: string): void;
}

export interface ConnectorStreamBinding {
  stream_key?: string;
  thread_id?: string;
  label?: string;
  pace?: ConnectorStream["pace"];
}

export type RegisteredConnector = Pick<ChannelConnector, "source"> & {
  poll: NonNullable<ChannelConnector["poll"]>;
  source_mode?: ChannelConnector["source_mode"];
  quota?: ChannelConnector["quota"];
};

export interface ConnectorRegistry {
  register(
    installationId: string,
    connector: RegisteredConnector,
    binding?: ConnectorStreamBinding,
  ): () => void;
  get(
    installationId: string,
    streamKey?: string,
  ): RegisteredConnector | undefined;
  getStream(
    installationId: string,
    streamKey?: string,
  ): ConnectorStream | undefined;
  listStreams(installationId: string): ConnectorStream[];
  unregister(installationId: string, streamKey: string): boolean;
}

export interface ConnectorHost {
  get(name: "connectors"): ConnectorRegistry;
  get(name: "egress"): EgressRegistry;
  plugin<C>(plugin: Plugin<C>, config?: C): Promise<PluginHandle>;
  now(): string;
  secrets: ConnectorSecrets;
}

export interface ConversationThread {
  source: string;
  target: string;
}

/** Kernel-owned threads this install should keep live. Drivers may add a cheap peek. */
export interface ResolveStreamsOptions {
  threads?: ConversationThread[];
  /**
   * Directory members from SyncEngine. Drivers may use labels without another
   * census so live ticks stay cheap.
   */
  catalog?: readonly SyncCatalogMember[];
  /** First seed or an explicit sync. Not the paced live tick. */
  discover?: boolean;
}

/** Store-derived inbound cursor. Connectors may use it as an opaque hint. */
export interface ThreadAttentionQuery extends ConversationThread {
  latest_inbound?: ThreadInboundCursor;
}

/** Outbound ids are opaque. Connectors recognize their own message ids. */
export interface ThreadReceiptQuery extends ConversationThread {
  outbound: Array<{ external_id: string; occurred_at: string }>;
}

export type ListTitleMode = "conversation" | "face" | "prompt";
export interface ChannelCapabilities {
  sync: boolean;
  reply: boolean;
  create: boolean;
  /**
   * After an outbound, treat silence as waiting for the other side.
   * Session/agent channels set this. Chat channels leave it unset.
   */
  await_reply?: boolean;
  /**
   * How the desktop titles a conversation in lists.
   * Chat channels set `conversation` (group / DM / channel name).
   * Session/agent channels set `prompt` (first user message).
   * Omit it to keep the visible-message face.
   */
  list_title?: ListTitleMode;
  /**
   * Opening a conversation should pull a recent page through this driver.
   * Chat history sources set this. Session journals leave it unset.
   */
  hydrate_on_open?: boolean;
  /**
   * This install can list and answer live thread prompts.
   * Session agents that pause for a human set this.
   */
  prompts?: boolean;
  /**
   * This install can report and ack whether I have seen inbound.
   * Absence still uses the local last_read cursor.
   */
  attention?: boolean;
  /**
   * This install can report whether the peer has read my outbound.
   * Session agents omit it. Chat channels set it only when a real API exists.
   */
  receipts?: boolean;
  /**
   * Creating a conversation requires the first user task.
   * Desktop keeps a local draft; `createThread` receives `text` and starts the run.
   * The kernel seeds that outbound and does not await the first poll.
   * Omit it (DSH): `createThread` opens an empty session; the first text is a normal send.
   */
  create_with_task?: boolean;
  /**
   * Outbound follow-ups during `activity: working` are held by this connector
   * until the current run ends. Desktop may count them as waiting.
   * Omit it (DSH): send is accepted immediately (the peer queues).
   */
  hold_while_working?: boolean;
  /**
   * Engine may reveal a pairing / install secret for this install.
   * Requires `readPairingCode`.
   */
  pairing_code?: boolean;
  /**
   * Browser / extension Origin may authorize with a live key.
   * Requires `authorizeLiveAccess`.
   */
  browser_live?: boolean;
}

export interface ConnectorCatalogServiceState {
  ready: boolean;
  hint?: CopyRef;
}

export interface ConnectorCatalogFieldOption {
  value: string;
  label: CopyRef;
  kind?: string;
  title?: string;
}

export interface ConnectorCatalogProbe {
  services?: Record<string, ConnectorCatalogServiceState>;
  field_options?: Record<string, ConnectorCatalogFieldOption[]>;
}

/** Drivers declare their own install card. The host does not keep a parallel catalog. */
export interface DriverCatalogFieldWhen {
  field: string;
  value?: string;
  values?: string[];
}

export interface DriverInstallConfirm {
  when: DriverCatalogFieldWhen;
  warning: CopyRef;
  ack: CopyRef;
}

export interface DriverCatalogField {
  key: string;
  label: CopyRef;
  required?: boolean;
  placeholder?: CopyRef;
  default?: string;
  multiple?: boolean;
  secret?: boolean;
  options?: ConnectorCatalogFieldOption[];
  /** Restrict this field's options to the CSV values of another field. */
  filter_options_by?: string;
  /** Persist resolved option titles under this config key. */
  option_labels_key?: string;
  visible_when?: DriverCatalogFieldWhen;
}

export interface DriverCatalogPrerequisite {
  kind: "env" | "local_service";
  key: string;
  label: CopyRef;
  required?: boolean;
  hint?: CopyRef;
  visible_when?: DriverCatalogFieldWhen;
}

export interface DriverCatalogSetupStep {
  title: CopyRef;
  body?: CopyRef;
  command?: string;
  href?: LocaleHref;
  visible_when?: DriverCatalogFieldWhen;
}

/** Optional file import the Engine card can offer without a per-channel API. */
export interface DriverImportFiles {
  accept: string;
  max_bytes?: number;
  title?: CopyRef;
  description?: CopyRef;
}

export interface ConnectorImportInput {
  content: string;
  file_name?: string;
  org_id: string;
  local_principal_id: string;
  received_at: string;
  existing_external_ids?: readonly string[];
}

export interface ConnectorImportParseResult {
  file_hash: string;
  batches: IngestBatch[];
  errors: Array<{ line?: number; code?: string; message: string }>;
}

export interface DriverInstallCatalog {
  title: CopyRef;
  description: CopyRef;
  credential_hint: CopyRef;
  /**
   * Human label for `driver.source`. Inbox and Engine read this.
   * Omit it to use CHANNELS, then title, then SOURCE.
   */
  channel_label?: CopyRef;
  singleton?: boolean;
  fields?: DriverCatalogField[];
  prerequisites?: DriverCatalogPrerequisite[];
  /**
   * Numbered setup the Engine dialog renders above the form.
   * The desktop does not hard-code steps per connector type.
   */
  setup_steps?: DriverCatalogSetupStep[];
  /**
   * Optional second confirmation before install/save when `when` matches form values.
   */
  install_confirm?: DriverInstallConfirm;
  /**
   * File picker on the Engine card. The desktop does not hard-code importers.
   */
  import_files?: DriverImportFiles;
  instance_label?: CopyRef;
  instance_detail_key?: string;
}
export interface DriverInstallPresentation {
  label: CopyRef;
  detail: CopyRef | null;
}

export interface ConnectorStreamPace {
  idle_ms?: number;
  catch_up_pages?: number;
}

export interface ConnectorStream {
  stream_key: string;
  connector: Pick<ChannelConnector, "source"> & {
    poll: NonNullable<ChannelConnector["poll"]>;
    source_mode?: ChannelConnector["source_mode"];
    quota?: ChannelConnector["quota"];
  };
  pace?: ConnectorStreamPace;
  thread_id?: string;
  label?: string;
}

export class ChannelDriverError extends Error {
  constructor(
    readonly code:
      | "invalid_config"
      | "missing_credentials"
      | "sync_failed"
      | "send_failed"
      | "unsupported_channel"
      | "no_sender"
      | "throttled",
    message: string,
    readonly reason?: string,
  ) {
    super(message);
    this.name = "ChannelDriverError";
  }
}

/** Identity, install, match, and declared capabilities. Every driver implements this. */
export interface ChannelDriverCore {
  readonly connector_type: string;
  readonly source: string;
  /**
   * Declared pull/push mode for this driver. Omit for poll-only.
   * Tick skips webhook-only installs instead of calling poll.
   */
  readonly source_mode?: ConnectorSourceMode;
  /** Contract version. Omit for 1.0. Newer values are skipped at load. */
  readonly connector_protocol?: string;
  install(input: {
    id: string;
    org_id: string;
    config: Record<string, unknown>;
    now: string;
    secrets?: ConnectorSecrets;
  }): NewConnectorInstallation;
  matchesThread(
    installation: ConnectorInstallation,
    thread: ConversationThread,
  ): boolean;
  ownsThread(
    installation: ConnectorInstallation,
    thread: ConversationThread,
  ): boolean;
  capabilities(installation: ConnectorInstallation): ChannelCapabilities;
}

/** Mount and poll streams. Required while poll/hybrid is the live source mode. */
export interface ChannelSourcePort {
  resolveStreams(
    installation: ConnectorInstallation,
    host: ConnectorHost,
    env: NodeJS.ProcessEnv,
    options?: ResolveStreamsOptions,
  ): Promise<ConnectorStream[]>;
  resolveThreadStream(
    installation: ConnectorInstallation,
    thread: ConversationThread,
    host: ConnectorHost,
    env: NodeJS.ProcessEnv,
  ): Promise<ConnectorStream>;
  /**
   * Optional directory source for the kernel SyncEngine.
   * Live ticks must not census; the engine pages this separately.
   */
  bindSyncSource?(
    installation: ConnectorInstallation,
    host: ConnectorHost,
    env: NodeJS.ProcessEnv,
  ): Promise<SyncSource>;
}

/** Optional send / create. Absent means the kernel returns 501. */
export interface EgressQueueItem {
  id: string;
  thread_id: string;
  chat_id: string;
  text: string;
  send_now: boolean;
  delay_ms: number;
  created_at: string;
  expires_at: string;
}

export interface ChannelSinkPort {
  createThread(
    installation: ConnectorInstallation,
    host: ConnectorHost,
    env: NodeJS.ProcessEnv,
    options?: { cwd?: string; text?: string },
  ): Promise<ConversationThread>;
  bindEgress(
    installation: ConnectorInstallation,
    thread: ConversationThread,
    host: ConnectorHost,
    env: NodeJS.ProcessEnv,
  ): Promise<RegisteredEgress>;
  outboundId(thread: ConversationThread, receipt: DeliveryReceipt): string;
  /**
   * Optional drain for adapters that cannot write the channel in-process
   * (a local browser extension). The kernel exposes this as a generic
   * connector egress queue, not a per-channel API.
   */
  listEgressQueue?(installation: ConnectorInstallation): EgressQueueItem[];
  ackEgressQueue?(
    installation: ConnectorInstallation,
    id: string,
  ): { acknowledged: boolean };
}

export type WebhookConnector = Pick<
  ChannelConnector,
  "source" | "source_mode" | "quota" | "verifyWebhook" | "handleWebhook"
>;

export interface ChannelDriver
  extends ChannelDriverCore, ChannelSourcePort, Partial<ChannelSinkPort> {
  /**
   * Bind the install-level webhook translator. Required when
   * `source_mode` is webhook or hybrid. The kernel ingest path calls
   * this; drivers must not write Events themselves.
   */
  bindWebhook?(
    installation: ConnectorInstallation,
    host: ConnectorHost,
    env: NodeJS.ProcessEnv,
  ): Promise<WebhookConnector>;
  /**
   * Plugin-owned locale tables. English is the source. Host chrome
   * stays in the desktop catalog.
   */
  locales?(): readonly PluginLocaleTable[];
  /**
   * Install card. Absent means this driver does not appear in Engine.
   */
  installCatalog?(input?: { env?: NodeJS.ProcessEnv }): DriverInstallCatalog;
  /**
   * Translate a user-picked file into ingest batches. Optional.
   * Declared together with `installCatalog().import_files`. The kernel
   * writes Events; the driver does not.
   */
  parseImport?(input: ConnectorImportInput): ConnectorImportParseResult | Promise<ConnectorImportParseResult>;
  /**
   * Subscribe to absentee notify for one sysout thread. The driver must not
   * write Events; the kernel follow/polls that stream, then reaps. Omit when
   * the channel has no wait fd (history poll stays the catch-up).
   */
  waitThread?(
    installation: ConnectorInstallation,
    thread: ConversationThread,
    host: ConnectorHost,
    env: NodeJS.ProcessEnv,
    onNotify: () => void,
  ): (() => void) | undefined;
  /** Optional aliases for write-back. Kernel matches these exactly. */
  writeBackLabels?(label: string): string[];
  /**
   * Optional work-unit vocabulary. Recipes equality-match `unit_kind`.
   * Chat channels omit this. The kernel does not interpret the ids.
   */
  subjectCatalog?(): SubjectCatalog;
  presentInstall?(
    installation: ConnectorInstallation,
    input?: { env?: NodeJS.ProcessEnv },
  ): DriverInstallPresentation;
  /**
   * Local service / env readiness for Engine prerequisites.
   * Must not enumerate source resources (chat lists, agents).
   * Those belong on `listCatalogFieldOptions`.
   */
  probeCatalog?(input: {
    env: NodeJS.ProcessEnv;
  }): Promise<ConnectorCatalogProbe>;
  /**
   * Form dropdowns. The kernel calls this when the user opens install/edit,
   * never on `GET /v1/me/engine`.
   */
  listCatalogFieldOptions?(input: {
    env: NodeJS.ProcessEnv;
  }): Promise<NonNullable<ConnectorCatalogProbe["field_options"]>>;
  resolveConversationLabels?(
    installation: ConnectorInstallation,
    threads: ConversationThread[],
    env: NodeJS.ProcessEnv,
  ): Promise<Map<string, string>>;
  listPrompts?(
    installation: ConnectorInstallation,
    thread: ConversationThread,
    host: ConnectorHost,
    env: NodeJS.ProcessEnv,
  ): Promise<ThreadPrompt[]>;
  answerPrompt?(
    installation: ConnectorInstallation,
    thread: ConversationThread,
    answer: PromptAnswer,
    host: ConnectorHost,
    env: NodeJS.ProcessEnv,
  ): Promise<{ accepted: boolean }>;
  readAttention?(
    installation: ConnectorInstallation,
    threads: ThreadAttentionQuery[],
    host: ConnectorHost,
    env: NodeJS.ProcessEnv,
  ): Promise<Map<string, ThreadAttention>>;
  ackAttention?(
    installation: ConnectorInstallation,
    thread: ConversationThread,
    ack: AttentionAck,
    host: ConnectorHost,
    env: NodeJS.ProcessEnv,
  ): Promise<void>;
  readReceipts?(
    installation: ConnectorInstallation,
    threads: ThreadReceiptQuery[],
    host: ConnectorHost,
    env: NodeJS.ProcessEnv,
  ): Promise<Map<string, MessageReceipt>>;
  surfaceGeneration?(
    installation: ConnectorInstallation,
    host: ConnectorHost,
  ): string;
  /**
   * Optional pairing / install secret for Engine reveal.
   * Declared with `capabilities.pairing_code`.
   */
  readPairingCode?(
    installation: ConnectorInstallation,
    secrets?: ConnectorSecrets,
  ): Promise<string | undefined>;
  /**
   * Authorize a browser / extension live request for this install.
   * Declared with `capabilities.browser_live`. Throws `ChannelDriverError`
   * when the presented key / origin is not allowed.
   */
  authorizeLiveAccess?(
    installation: ConnectorInstallation,
    input: {
      apiKey?: string;
      origin?: string;
      env: NodeJS.ProcessEnv;
      secrets?: ConnectorSecrets;
    },
  ): Promise<void>;
  /**
   * Clear connector-owned operational caches after Core data is cleared.
   * The hook cannot access Authority, Ingest, or Blob services.
   */
  onStoreClear?(
    installations: readonly ConnectorInstallation[],
    host: ConnectorHost,
  ): void | Promise<void>;
}

export function requireConnectorStream(
  registry: ConnectorRegistry,
  installationId: string,
  streamKey?: string,
): ConnectorStream {
  const stream = registry.getStream(installationId, streamKey);
  if (!stream) {
    throw new ChannelDriverError("sync_failed", "Connector failed to mount");
  }
  return stream;
}

export function parseConversationThread(threadId: string): ConversationThread {
  const colon = threadId.indexOf(":");
  if (colon <= 0 || colon === threadId.length - 1) {
    throw new ChannelDriverError(
      "invalid_config",
      "thread_id must look like source:target",
    );
  }
  return {
    source: threadId.slice(0, colon),
    target: threadId.slice(colon + 1),
  };
}
