import {
  ChannelDriverError,
  parseConversationThread,
  type ChannelCapabilities,
  type ChannelDriver,
  type ChannelSinkPort,
  type ChannelSourcePort,
  type ConnectorCatalogProbe,
  type ConnectorCatalogServiceState,
  type ConnectorStream,
  type ConversationThread,
  type DriverInstallCatalog,
  type DriverInstallPresentation,
  type EgressQueueItem,
  type ListTitleMode,
  type ResolveStreamsOptions,
  type ThreadAttentionQuery,
  type ThreadReceiptQuery,
  type WebhookConnector,
} from "@regenic/connector-contract";
export {
  ChannelDriverError,
  parseConversationThread,
};
export type {
  ChannelCapabilities,
  ChannelDriver,
  ChannelDriverCore,
  ChannelSinkPort,
  ChannelSourcePort,
  ConnectorCatalogFieldOption,
  ConnectorCatalogProbe,
  ConnectorCatalogServiceState,
  ConnectorImportInput,
  ConnectorImportParseResult,
  ConnectorStream,
  ConnectorStreamPace,
  ConversationThread,
  DriverCatalogField,
  DriverCatalogFieldWhen,
  DriverCatalogPrerequisite,
  DriverCatalogSetupStep,
  DriverImportFiles,
  DriverInstallCatalog,
  DriverInstallConfirm,
  DriverInstallPresentation,
  EgressQueueItem,
  ListTitleMode,
  ResolveStreamsOptions,
  ThreadAttentionQuery,
  ThreadReceiptQuery,
  WebhookConnector,
} from "@regenic/connector-contract";

import type { Host } from "@regenic/plugin-host";
import { asConnectorHost, type ConnectorHost } from "./connector-host";
import {
  DEFAULT_COPY_LOCALE,
  resolveCopyText,
  type CopyLocale,
  type CopyRef,
  type LocaleHref,
  type PluginLocaleTable,
} from "./copy";
import type { DeliveryReceipt, RegisteredEgress } from "./egress";
import { CHANNELS, channelLabel } from "./message-contract";
import type {
  ChannelConnector,
  ConnectorInstallation,
  ConnectorSourceMode,
  IngestBatch,
  NewConnectorInstallation,
} from "./ingestion";
import type { SyncCatalogMember, SyncSource } from "./sync-contracts";
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
import {
  DEFAULT_CATALOG_OPTIONS_TIMEOUT_MS,
  DEFAULT_CATALOG_PROBE_TIMEOUT_MS,
  withDeadline,
} from "./deadline";


export function normalizeListTitle(value: unknown): ListTitleMode {
  if (value === "conversation" || value === "prompt") {
    return value;
  }
  return "face";
}


export function sourceLabelFromCatalog(
  source: string | undefined,
  catalog?: Pick<DriverInstallCatalog, "channel_label" | "title"> | null,
  tables: readonly PluginLocaleTable[] = [],
  locale: CopyLocale = DEFAULT_COPY_LOCALE,
): string {
  const declared = resolveCopyText(tables, locale, catalog?.channel_label)
    .replace(/\s+/g, " ")
    .trim();
  if (declared) {
    return declared;
  }
  if (source && CHANNELS[source]) {
    return CHANNELS[source].label;
  }
  const title = resolveCopyText(tables, locale, catalog?.title)
    .replace(/\s+/g, " ")
    .trim();
  if (title) {
    return title;
  }
  return channelLabel(source);
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
    locale: CopyLocale = DEFAULT_COPY_LOCALE,
  ): string {
    if (!source) {
      return channelLabel(source);
    }
    const driver = this.list().find((item) => item.source === source);
    return sourceLabelFromCatalog(
      source,
      driver?.installCatalog?.({ env }),
      driver?.locales?.() ?? [],
      locale,
    );
  }

  unitKindLabel(
    source: string | undefined,
    unitKind: string | undefined,
    locale: CopyLocale = DEFAULT_COPY_LOCALE,
  ): string | undefined {
    return labelForUnitKind(
      this.list().map((driver) => ({
        source: driver.source,
        kinds: readSubjectCatalog(driver.subjectCatalog?.()).kinds.map((kind) => ({
          id: kind.id,
          label: resolveCopyText(driver.locales?.() ?? [], locale, kind.label) || kind.id,
        })),
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
      Record<string, { value: string; label: CopyRef }[]>
    >;
  }> {
    const services: Record<string, ConnectorCatalogServiceState> = {};
    const field_options: Record<
      string,
      Record<string, { value: string; label: CopyRef }[]>
    > = {};
    await Promise.all(
      this.list().map(async (driver) => {
        if (!driver.probeCatalog) {
          return;
        }
        try {
          const probe = await withDeadline(
            driver.probeCatalog({ env }),
            DEFAULT_CATALOG_PROBE_TIMEOUT_MS,
            `probeCatalog ${driver.connector_type}`,
          );
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

  async listCatalogFieldOptions(
    connectorType: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<NonNullable<ConnectorCatalogProbe["field_options"]>> {
    const driver = this.get(connectorType);
    if (!driver?.listCatalogFieldOptions) {
      return {};
    }
    try {
      return await withDeadline(
        driver.listCatalogFieldOptions({ env }),
        DEFAULT_CATALOG_OPTIONS_TIMEOUT_MS,
        `catalog options ${connectorType}`,
      );
    } catch {
      return {};
    }
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

  async clearOperationalState(
    installations: ConnectorInstallation[],
    host: Host | ConnectorHost,
  ): Promise<void> {
    const drivers = asConnectorHost(host);
    await Promise.all(
      this.list().map(async (driver) => {
        if (!driver.onStoreClear) {
          return;
        }
        const owned = installations.filter(
          (installation) =>
            installation.connector_type === driver.connector_type,
        );
        try {
          await driver.onStoreClear(owned, drivers);
        } catch {
          // Connector cleanup is best-effort after the authority was cleared.
        }
      }),
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

const STREAM_KEY_KINDS = ["chat:", "session:", "channel:", "agent:"] as const;

/** Recover a thread from a catalog stream_key without listing every stream. */
export function conversationThreadFromStreamKey(
  source: string,
  streamKey: string,
  threadId?: string | null,
): ConversationThread | null {
  if (threadId?.trim()) {
    try {
      return parseConversationThread(threadId);
    } catch {
      // Fall through to the stream_key shape used by catalog members.
    }
  }
  const key = streamKey.trim();
  if (!key || !source.trim()) {
    return null;
  }
  const prefix = `${source}:`;
  for (const kind of STREAM_KEY_KINDS) {
    if (key.startsWith(kind)) {
      const target = key.slice(kind.length);
      return target ? { source, target } : null;
    }
  }
  if (key.startsWith(prefix)) {
    const target = key.slice(prefix.length);
    return target ? { source, target } : null;
  }
  return null;
}

/** Candidate stream_keys for a thread_id without loading the catalog. */
export function streamKeysForThreadId(threadId: string): string[] {
  const trimmed = threadId.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const thread = parseConversationThread(trimmed);
    return [
      `chat:${thread.target}`,
      `session:${thread.target}`,
      `channel:${thread.target}`,
      `agent:${thread.target}`,
      `${thread.source}:${thread.target}`,
      trimmed,
    ];
  } catch {
    return [trimmed];
  }
}

export function streamKeysForThreadIds(threadIds: readonly string[]): string[] {
  const keys = new Set<string>();
  for (const id of threadIds) {
    for (const key of streamKeysForThreadId(id)) {
      keys.add(key);
    }
  }
  return [...keys];
}
