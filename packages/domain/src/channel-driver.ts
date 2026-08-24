import type { Host } from "@regenic/plugin-host";
import type { DeliveryReceipt, RegisteredEgress } from "./egress";
import type {
  ChannelConnector,
  ConnectorInstallation,
  NewConnectorInstallation,
} from "./ingestion";
import type {
  AttentionAck,
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

export interface ConversationThread {
  source: string;
  target: string;
}

/** Store-derived inbound cursor. Connectors may use it as an opaque hint. */
export interface ThreadAttentionQuery extends ConversationThread {
  latest_inbound?: ThreadInboundCursor;
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
   * This install can report and ack source read state.
   * Chat channels may set this. Absence falls back to the local cursor.
   */
  attention?: boolean;
}

export interface ConnectorCatalogServiceState {
  ready: boolean;
  hint?: string;
}

export interface ConnectorCatalogProbe {
  services?: Record<string, ConnectorCatalogServiceState>;
  field_options?: Record<string, { value: string; label: string }[]>;
}

export interface ConnectorStreamPace {
  idle_ms?: number;
  catch_up_pages?: number;
}

export interface ConnectorStream {
  stream_key: string;
  connector: Pick<ChannelConnector, "poll" | "source">;
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
      | "no_sender",
    message: string,
  ) {
    super(message);
    this.name = "ChannelDriverError";
  }
}

export interface ChannelDriver {
  readonly connector_type: string;
  readonly source: string;
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
  canReply(installation: ConnectorInstallation): boolean;
  createThread(
    installation: ConnectorInstallation,
    host: Host,
    env: NodeJS.ProcessEnv,
  ): Promise<ConversationThread>;
  resolveStreams(
    installation: ConnectorInstallation,
    host: Host,
    env: NodeJS.ProcessEnv,
  ): Promise<ConnectorStream[]>;
  resolveThreadStream(
    installation: ConnectorInstallation,
    thread: ConversationThread,
    host: Host,
    env: NodeJS.ProcessEnv,
  ): Promise<ConnectorStream>;
  bindEgress(
    installation: ConnectorInstallation,
    thread: ConversationThread,
    host: Host,
    env: NodeJS.ProcessEnv,
  ): Promise<RegisteredEgress>;
  outboundId(thread: ConversationThread, receipt: DeliveryReceipt): string;
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
    host: Host,
    env: NodeJS.ProcessEnv,
  ): Promise<ThreadPrompt[]>;
  answerPrompt?(
    installation: ConnectorInstallation,
    thread: ConversationThread,
    answer: PromptAnswer,
    host: Host,
    env: NodeJS.ProcessEnv,
  ): Promise<{ accepted: boolean }>;
  readAttention?(
    installation: ConnectorInstallation,
    threads: ThreadAttentionQuery[],
    host: Host,
    env: NodeJS.ProcessEnv,
  ): Promise<Map<string, ThreadAttention>>;
  ackAttention?(
    installation: ConnectorInstallation,
    thread: ConversationThread,
    ack: AttentionAck,
    host: Host,
    env: NodeJS.ProcessEnv,
  ): Promise<void>;
  surfaceGeneration?(
    installation: ConnectorInstallation,
    host: Host,
  ): string;
}

export class ChannelDriverRegistry {
  private readonly drivers = new Map<string, ChannelDriver>();

  register(driver: ChannelDriver): this {
    this.drivers.set(driver.connector_type, driver);
    return this;
  }

  get(connectorType: string): ChannelDriver | undefined {
    return this.drivers.get(connectorType);
  }

  list(): ChannelDriver[] {
    return [...this.drivers.values()];
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
    return Boolean(found && found.driver.canReply(found.installation));
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
  ): { installation: ConnectorInstallation; driver: ChannelDriver } | undefined {
    for (const installation of installations) {
      if (installation.status !== "enabled") {
        continue;
      }
      const driver = this.get(installation.connector_type);
      if (driver?.capabilities(installation).create) {
        return { installation, driver };
      }
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

  async listPrompts(
    installations: ConnectorInstallation[],
    thread: ConversationThread,
    host: Host,
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
        host,
        env,
      );
    } catch {
      return [];
    }
  }

  async listPromptsForThreads(
    installations: ConnectorInstallation[],
    threads: ConversationThread[],
    host: Host,
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
    host: Host,
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
    const listed = found.driver.listPrompts
      ? await found.driver
          .listPrompts(found.installation, thread, host, env)
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
      host,
      env,
    );
  }

  async readAttention(
    installations: ConnectorInstallation[],
    threads: ThreadAttentionQuery[],
    host: Host,
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
            host,
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
    host: Host,
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
        host,
        env,
      );
    } catch {
      // Local cursor still stands. Source ack is best-effort.
    }
  }

  surfaceGeneration(
    installations: ConnectorInstallation[],
    host: Host,
  ): string {
    return formatSurfaceGeneration(
      this.list().flatMap((driver) =>
        installations
          .filter(
            (installation) =>
              installation.connector_type === driver.connector_type &&
              installation.status === "enabled",
          )
          .map((installation) => driver.surfaceGeneration?.(installation, host)),
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
