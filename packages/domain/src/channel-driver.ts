import type { Host } from "@regenic/plugin-host";
import { asConnectorHost, type ConnectorHost } from "./connector-host";
import type { DeliveryReceipt, RegisteredEgress } from "./egress";
import { CHANNELS, channelLabel } from "./message-contract";
import type {
  ChannelConnector,
  ConnectorInstallation,
  ConnectorSourceMode,
  IngestBatch,
  NewConnectorInstallation,
} from "./ingestion";
import type {
  AttentionAck,
  MessageReceipt,
  PromptAnswer,
  ThreadAttention,
  ThreadInboundCursor,
  ThreadPrompt,
} from "./thread-surface";
import {
  formatSurfaceGeneration,
  normalizePromptAnswers,
  threadIdOf,
} from "./thread-surface";
import {
  labelForUnitKind,
  readSubjectCatalog,
  type SubjectCatalog,
} from "./unit-kind";

export interface ConversationThread {
  source: string;
  target: string;
}

/** Kernel-owned threads this install should keep live. Drivers may add a cheap peek. */
export interface ResolveStreamsOptions {
  threads?: ConversationThread[];
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

export function normalizeListTitle(value: unknown): ListTitleMode {
  if (value === "conversation" || value === "prompt") {
    return value;
  }
  return "face";
}

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
}

export interface ConnectorCatalogServiceState {
  ready: boolean;
  hint?: string;
}

export interface ConnectorCatalogProbe {
  services?: Record<string, ConnectorCatalogServiceState>;
  field_options?: Record<string, { value: string; label: string }[]>;
}

/** Drivers declare their own install card. The host does not keep a parallel catalog. */
export interface DriverCatalogFieldWhen {
  field: string;
  value: string;
}

export interface DriverCatalogField {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  default?: string;
  multiple?: boolean;
  secret?: boolean;
  options?: { value: string; label: string }[];
  visible_when?: DriverCatalogFieldWhen;
}

export interface DriverCatalogPrerequisite {
  kind: "env" | "local_service";
  key: string;
  label: string;
  required?: boolean;
  hint?: string;
  visible_when?: DriverCatalogFieldWhen;
}

export interface DriverCatalogSetupStep {
  title: string;
  title_zh?: string;
  body?: string;
  body_zh?: string;
  command?: string;
  href?: string;
  href_zh?: string;
  visible_when?: DriverCatalogFieldWhen;
}

/** Optional file import the Engine card can offer without a per-channel API. */
export interface DriverImportFiles {
  accept: string;
  max_bytes?: number;
  title?: string;
  description?: string;
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
  title: string;
  description: string;
  credential_hint: string;
  /**
   * Human label for `driver.source`. Inbox and Engine read this.
   * Omit it to use CHANNELS, then title, then SOURCE.
   */
  channel_label?: string;
  singleton?: boolean;
  fields?: DriverCatalogField[];
  prerequisites?: DriverCatalogPrerequisite[];
  /**
   * Numbered setup the Engine dialog renders above the form.
   * The desktop does not hard-code steps per connector type.
   */
  setup_steps?: DriverCatalogSetupStep[];
  /**
   * File picker on the Engine card. The desktop does not hard-code importers.
   */
  import_files?: DriverImportFiles;
  instance_label?: string;
  instance_detail_key?: string;
}

export function sourceLabelFromCatalog(
  source: string | undefined,
  catalog?: Pick<DriverInstallCatalog, "channel_label" | "title"> | null,
): string {
  const declared = catalog?.channel_label?.replace(/\s+/g, " ").trim();
  if (declared) {
    return declared;
  }
  if (source && CHANNELS[source]) {
    return CHANNELS[source].label;
  }
  const title = catalog?.title?.replace(/\s+/g, " ").trim();
  if (title) {
    return title;
  }
  return channelLabel(source);
}

export interface DriverInstallPresentation {
  label: string;
  detail: string | null;
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
   * Install card. Absent means this driver does not appear in Engine.
   */
  installCatalog?(input?: { env?: NodeJS.ProcessEnv }): DriverInstallCatalog;
  /**
   * Translate a user-picked file into ingest batches. Optional.
   * Declared together with `installCatalog().import_files`. The kernel
   * writes Events; the driver does not.
   */
  parseImport?(input: ConnectorImportInput): ConnectorImportParseResult | Promise<ConnectorImportParseResult>;
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
  probeCatalog?(input: {
    env: NodeJS.ProcessEnv;
  }): Promise<ConnectorCatalogProbe>;
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
}

export function driverCanReply(
  driver: ChannelDriver,
  installation: ConnectorInstallation,
): boolean {
  return Boolean(
    driver.capabilities(installation).reply &&
      driver.bindEgress &&
      driver.outboundId,
  );
}

export function requireReplyPorts(driver: ChannelDriver): {
  bindEgress: NonNullable<ChannelDriver["bindEgress"]>;
  outboundId: NonNullable<ChannelDriver["outboundId"]>;
} {
  return {
    bindEgress: requireBindEgress(driver),
    outboundId: requireOutboundId(driver),
  };
}

export function requireCreateThread(
  driver: ChannelDriver,
): NonNullable<ChannelDriver["createThread"]> {
  if (!driver.createThread) {
    throw new ChannelDriverError(
      "unsupported_channel",
      "Creating a conversation is not available",
    );
  }
  return driver.createThread.bind(driver);
}

export function requireBindEgress(
  driver: ChannelDriver,
): NonNullable<ChannelDriver["bindEgress"]> {
  if (!driver.bindEgress) {
    throw new ChannelDriverError(
      "unsupported_channel",
      "Sending back to this conversation is not available",
    );
  }
  return driver.bindEgress.bind(driver);
}

export function requireOutboundId(
  driver: ChannelDriver,
): NonNullable<ChannelDriver["outboundId"]> {
  if (!driver.outboundId) {
    throw new ChannelDriverError(
      "unsupported_channel",
      "Sending back to this conversation is not available",
    );
  }
  return driver.outboundId.bind(driver);
}

export function requireWebhookPorts(driver: ChannelDriver): {
  bindWebhook: NonNullable<ChannelDriver["bindWebhook"]>;
} {
  if (!driver.bindWebhook) {
    throw new ChannelDriverError(
      "unsupported_channel",
      "Webhook ingest is not available",
    );
  }
  return { bindWebhook: driver.bindWebhook.bind(driver) };
}

export class ChannelDriverRegistry {
  private readonly drivers = new Map<string, ChannelDriver>();

  register(driver: ChannelDriver): this {
    if (this.drivers.has(driver.connector_type)) {
      return this;
    }
    this.drivers.set(driver.connector_type, driver);
    return this;
  }

  get(connectorType: string): ChannelDriver | undefined {
    return this.drivers.get(connectorType);
  }

  list(): ChannelDriver[] {
    return [...this.drivers.values()];
  }

  sourceLabel(
    source: string | undefined,
    env: NodeJS.ProcessEnv = process.env,
  ): string {
    if (!source) {
      return channelLabel(source);
    }
    const driver = this.list().find((item) => item.source === source);
    return sourceLabelFromCatalog(source, driver?.installCatalog?.({ env }));
  }

  unitKindLabel(
    source: string | undefined,
    unitKind: string | undefined,
  ): string | undefined {
    return labelForUnitKind(
      this.list().map((driver) => ({
        source: driver.source,
        kinds: readSubjectCatalog(driver.subjectCatalog?.()).kinds,
      })),
      source,
      unitKind,
    );
  }

  installCatalogs(
    env: NodeJS.ProcessEnv = process.env,
  ): Array<DriverInstallCatalog & { connector_type: string }> {
    return this.list().flatMap((driver) => {
      const catalog = driver.installCatalog?.({ env });
      return catalog
        ? [{ connector_type: driver.connector_type, ...catalog }]
        : [];
    });
  }

  async probeCatalog(
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{
    services: Record<string, ConnectorCatalogServiceState>;
    field_options: Record<
      string,
      Record<string, { value: string; label: string }[]>
    >;
  }> {
    const services: Record<string, ConnectorCatalogServiceState> = {};
    const field_options: Record<
      string,
      Record<string, { value: string; label: string }[]>
    > = {};
    await Promise.all(
      this.list().map(async (driver) => {
        if (!driver.probeCatalog) {
          return;
        }
        try {
          const probe = await driver.probeCatalog({ env });
          Object.assign(services, probe.services ?? {});
          if (probe.field_options) {
            field_options[driver.connector_type] = probe.field_options;
          }
        } catch {
          // A probe failure leaves that source unready. It must not block others.
        }
      }),
    );
    return { services, field_options };
  }

  has(connectorType: string): boolean {
    return this.drivers.has(connectorType);
  }

  findForThread(
    installations: ConnectorInstallation[],
    thread: ConversationThread,
  ): { installation: ConnectorInstallation; driver: ChannelDriver } | undefined {
    const matches = installations.flatMap((installation) => {
      const driver = this.get(installation.connector_type);
      if (
        !driver ||
        installation.status !== "enabled" ||
        !driver.matchesThread(installation, thread)
      ) {
        return [];
      }
      return [{ installation, driver }];
    });
    return (
      matches.find((item) =>
        item.driver.ownsThread(item.installation, thread),
      ) ?? matches[0]
    );
  }

  canSend(
    installations: ConnectorInstallation[],
    thread: ConversationThread,
  ): boolean {
    const found = this.findForThread(installations, thread);
    return Boolean(found && driverCanReply(found.driver, found.installation));
  }

  awaitReply(
    installations: ConnectorInstallation[],
    thread: ConversationThread,
  ): boolean {
    const found = this.findForThread(installations, thread);
    return Boolean(
      found && found.driver.capabilities(found.installation).await_reply,
    );
  }

  holdWhileWorking(
    installations: ConnectorInstallation[],
    thread: ConversationThread,
  ): boolean {
    const found = this.findForThread(installations, thread);
    return Boolean(
      found && found.driver.capabilities(found.installation).hold_while_working,
    );
  }

  listTitle(
    installations: ConnectorInstallation[],
    thread: ConversationThread,
  ): ListTitleMode {
    const found = this.findForThread(installations, thread);
    return normalizeListTitle(
      found?.driver.capabilities(found.installation).list_title,
    );
  }

  async resolveConversationLabels(
    installations: ConnectorInstallation[],
    threads: ConversationThread[],
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<Map<string, string>> {
    const labels = new Map<string, string>();
    const groups = new Map<
      string,
      {
        installation: ConnectorInstallation;
        driver: ChannelDriver;
        threads: ConversationThread[];
      }
    >();
    for (const thread of threads) {
      const found = this.findForThread(installations, thread);
      if (!found?.driver.resolveConversationLabels) {
        continue;
      }
      const group = groups.get(found.installation.id);
      if (group) {
        group.threads.push(thread);
      } else {
        groups.set(found.installation.id, {
          installation: found.installation,
          driver: found.driver,
          threads: [thread],
        });
      }
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        try {
          const part = await group.driver.resolveConversationLabels?.(
            group.installation,
            group.threads,
            env,
          );
          if (!part) {
            return;
          }
          for (const [id, name] of part) {
            const trimmed = name.replace(/\s+/g, " ").trim();
            if (trimmed) {
              labels.set(id, trimmed);
            }
          }
        } catch {
          // A lookup failure leaves that source unlabeled. It must not block inbox.
        }
      }),
    );
    return labels;
  }

  findCreatable(
    installations: ConnectorInstallation[],
    source?: string,
  ): { installation: ConnectorInstallation; driver: ChannelDriver } | undefined {
    const wanted = source?.trim();
    for (const installation of installations) {
      if (installation.status !== "enabled") {
        continue;
      }
      const driver = this.get(installation.connector_type);
      if (!driver?.capabilities(installation).create) {
        continue;
      }
      if (wanted && driver.source !== wanted) {
        continue;
      }
      return { installation, driver };
    }
    return undefined;
  }

  canCreate(installations: ConnectorInstallation[]): boolean {
    return Boolean(this.findCreatable(installations));
  }

  hydrateOnOpen(
    installations: ConnectorInstallation[],
    thread: ConversationThread,
  ): boolean {
    const found = this.findForThread(installations, thread);
    return Boolean(
      found && found.driver.capabilities(found.installation).hydrate_on_open,
    );
  }

  canPrompt(
    installations: ConnectorInstallation[],
    thread: ConversationThread,
  ): boolean {
    const found = this.findForThread(installations, thread);
    return Boolean(
      found && found.driver.capabilities(found.installation).prompts,
    );
  }

  canAttention(
    installations: ConnectorInstallation[],
    thread: ConversationThread,
  ): boolean {
    const found = this.findForThread(installations, thread);
    return Boolean(
      found && found.driver.capabilities(found.installation).attention,
    );
  }

  canReceipt(
    installations: ConnectorInstallation[],
    thread: ConversationThread,
  ): boolean {
    const found = this.findForThread(installations, thread);
    return Boolean(
      found && found.driver.capabilities(found.installation).receipts,
    );
  }

  async listPrompts(
    installations: ConnectorInstallation[],
    thread: ConversationThread,
    host: Host | ConnectorHost,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ThreadPrompt[]> {
    const found = this.findForThread(installations, thread);
    if (
      !found?.driver.listPrompts ||
      !found.driver.capabilities(found.installation).prompts
    ) {
      return [];
    }
    try {
      return await found.driver.listPrompts(
        found.installation,
        thread,
        asConnectorHost(host),
        env,
      );
    } catch {
      return [];
    }
  }

  async listPromptsForThreads(
    installations: ConnectorInstallation[],
    threads: ConversationThread[],
    host: Host | ConnectorHost,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<Map<string, ThreadPrompt[]>> {
    const prompts = new Map<string, ThreadPrompt[]>();
    await Promise.all(
      uniqueThreads(threads).map(async (thread) => {
        const listed = await this.listPrompts(installations, thread, host, env);
        if (listed.length > 0) {
          prompts.set(threadIdOf(thread), listed);
        }
      }),
    );
    return prompts;
  }

  async answerPrompt(
    installations: ConnectorInstallation[],
    thread: ConversationThread,
    answer: PromptAnswer,
    host: Host | ConnectorHost,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<{ accepted: boolean }> {
    const found = this.findForThread(installations, thread);
    if (
      !found?.driver.answerPrompt ||
      !found.driver.capabilities(found.installation).prompts
    ) {
      throw new ChannelDriverError(
        "unsupported_channel",
        "This conversation cannot answer a live prompt",
      );
    }
    const drivers = asConnectorHost(host);
    const listed = found.driver.listPrompts
      ? await found.driver
          .listPrompts(found.installation, thread, drivers, env)
          .catch(() => [] as ThreadPrompt[])
      : [];
    const prompt = listed.find((item) => item.prompt_id === answer.prompt_id);
    return found.driver.answerPrompt(
      found.installation,
      thread,
      {
        ...answer,
        answers: normalizePromptAnswers(prompt?.questions ?? [], answer.answers),
      },
      drivers,
      env,
    );
  }

  async readAttention(
    installations: ConnectorInstallation[],
    threads: ThreadAttentionQuery[],
    host: Host | ConnectorHost,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<Map<string, ThreadAttention>> {
    const attention = new Map<string, ThreadAttention>();
    const groups = new Map<
      string,
      {
        installation: ConnectorInstallation;
        driver: ChannelDriver;
        threads: ThreadAttentionQuery[];
      }
    >();
    for (const thread of uniqueThreads(threads)) {
      const found = this.findForThread(installations, thread);
      if (
        !found?.driver.readAttention ||
        !found.driver.capabilities(found.installation).attention
      ) {
        continue;
      }
      const group = groups.get(found.installation.id);
      if (group) {
        group.threads.push(thread);
      } else {
        groups.set(found.installation.id, {
          installation: found.installation,
          driver: found.driver,
          threads: [thread],
        });
      }
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        try {
          const part = await group.driver.readAttention?.(
            group.installation,
            group.threads,
            asConnectorHost(host),
            env,
          );
          if (!part) {
            return;
          }
          for (const [id, value] of part) {
            attention.set(id, value);
          }
        } catch {
          // A source overlay failure must not block inbox.
        }
      }),
    );
    return attention;
  }

  async ackAttention(
    installations: ConnectorInstallation[],
    thread: ConversationThread,
    ack: AttentionAck,
    host: Host | ConnectorHost,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<void> {
    const found = this.findForThread(installations, thread);
    if (
      !found?.driver.ackAttention ||
      !found.driver.capabilities(found.installation).attention
    ) {
      return;
    }
    try {
      await found.driver.ackAttention(
        found.installation,
        thread,
        ack,
        asConnectorHost(host),
        env,
      );
    } catch {
      // Local cursor still stands. Source ack is best-effort.
    }
  }

  async readReceipts(
    installations: ConnectorInstallation[],
    threads: ThreadReceiptQuery[],
    host: Host | ConnectorHost,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<Map<string, MessageReceipt>> {
    const receipts = new Map<string, MessageReceipt>();
    const groups = new Map<
      string,
      {
        installation: ConnectorInstallation;
        driver: ChannelDriver;
        threads: ThreadReceiptQuery[];
      }
    >();
    for (const thread of threads) {
      if (thread.outbound.length === 0) {
        continue;
      }
      const found = this.findForThread(installations, thread);
      if (
        !found?.driver.readReceipts ||
        !found.driver.capabilities(found.installation).receipts
      ) {
        continue;
      }
      const group = groups.get(found.installation.id);
      if (group) {
        group.threads.push(thread);
      } else {
        groups.set(found.installation.id, {
          installation: found.installation,
          driver: found.driver,
          threads: [thread],
        });
      }
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        try {
          const part = await group.driver.readReceipts?.(
            group.installation,
            group.threads,
            asConnectorHost(host),
            env,
          );
          if (!part) {
            return;
          }
          for (const [id, value] of part) {
            receipts.set(id, value);
          }
        } catch {
          // Receipt lookup must not block inbox.
        }
      }),
    );
    return receipts;
  }

  surfaceGeneration(
    installations: ConnectorInstallation[],
    host: Host | ConnectorHost,
  ): string {
    const drivers = asConnectorHost(host);
    return formatSurfaceGeneration(
      this.list().flatMap((driver) =>
        installations
          .filter(
            (installation) =>
              installation.connector_type === driver.connector_type &&
              installation.status === "enabled",
          )
          .map((installation) =>
            driver.surfaceGeneration?.(installation, drivers),
          ),
      ),
    );
  }
}

function uniqueThreads<T extends ConversationThread>(threads: T[]): T[] {
  const seen = new Map<string, T>();
  for (const thread of threads) {
    const id = threadIdOf(thread);
    const current = seen.get(id);
    if (!current || hasInboundHint(thread)) {
      seen.set(id, thread);
    }
  }
  return [...seen.values()];
}

function hasInboundHint(thread: ConversationThread): boolean {
  return Boolean(
    (thread as ThreadAttentionQuery).latest_inbound?.external_id?.trim(),
  );
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
