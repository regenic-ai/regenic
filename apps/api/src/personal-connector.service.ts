import { randomUUID } from "node:crypto";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  ChannelDriverError,
  ChannelDriverRegistry,
  DEFAULT_COPY_LOCALE,
  type CopyLocale,
  ConnectorRunner,
  readEnvCredential,
  DeadlineExceededError,
  INGEST_SCHEMA_VERSION,
  InstallationQuotaBook,
  asConnectorHost,
  persistInstallSecrets,
  channelRecord,
  connectorPollTimeoutMs,
  connectorSyncTimeoutMs,
  driverCanReply,
  driverPolls,
  normalizeListTitle,
  parseConversationThread,
  requireCreateThread,
  requireWebhookPorts,
  runInSyncLane,
  settleIsolated,
  SyncEngine,
  loadSyncProgress,
  withDeadline,
  type ChannelDriver,
  type ConnectorInstallation,
  type ConnectorPollRunResult,
  type ConnectorRuntimeStore,
  type ConnectorStream,
  type ConnectorWebhookRunResult,
  type ConversationThread,
  type SyncCatalogMember,
  type WebhookRequest,
} from "@regenic/domain";
import type { Host } from "@regenic/plugin-host";
import {
  WHATSAPP_WEB_LIVE_CONNECTOR_TYPE,
  readWhatsAppLivePairingCode,
  resolveWhatsAppLiveKeys,
  whatsAppLiveKeyMatches,
} from "@regenic/whatsapp-personal";
import {
  connectorAllowsMultiple,
  catalogFromDrivers,
  nextPickedChatNames,
  toInstallationView,
  type EngineInstallationView,
} from "./personal-connector-view";
import { PersonalConnectorError, storeBusyError } from "./personal-errors";
import { PersonalInboxService } from "./personal-inbox.service";
import {
  applyPullOutcome,
  beginPull,
  finishPull,
  preferThread,
  preferredThreadId,
  publishPullStreams,
  pullStatus,
  resetPullStatus,
  type PullStreamStatus,
} from "./personal-pull-status";
import { isHumanIdle, noteHumanActivity } from "./personal-human-pace";
import {
  catalogRefreshPages,
  shouldKeepCatchingUp,
  syncExecutionBudget,
} from "./personal-stream-pace";
import { loadEligibleInstallationThreads } from "./personal-eligible-threads";
import { PersonalRuntimeService } from "./personal-runtime.service";
import {
  shouldHydrateOpenedInbox,
  shouldPullOlderInbox,
} from "./personal-inbox-query";

export { PersonalConnectorError } from "./personal-errors";

const DEFAULT_MAX_PAGES = 1;
const MAX_PAGES_CAP = 5;
const HYDRATE_COOLDOWN_MS = 15_000;
const HYDRATE_WAIT_MS = 12_000;
const FOLLOW_TRIES = 6;
const FOLLOW_WAIT_MS = 750;
const DEFAULT_PULL_MS = 3_000;
const START_PULL_DELAY_MS = 1_000;
const LEASE_MS = 60_000;

export interface ConnectorInstallInput {
  connector_type: string;
  config?: Record<string, unknown>;
}

export interface CreatedConversationView {
  thread_id: string;
  channel: string;
  channel_label: string;
  can_send: boolean;
  await_reply: boolean;
  list_title: "conversation" | "face" | "prompt";
}

export interface ConnectorSyncOptions {
  skipIdle?: boolean;
  capCatchUp?: boolean;
  allowHistory?: boolean;
  discover?: boolean;
}

export interface ConnectorSyncView {
  installation_id: string;
  pages_attempted: number;
  streams_attempted: number;
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
  last_run_status: ConnectorPollRunResult["status"] | "idle";
  installation: EngineInstallationView;
}

export interface ConnectorWebhookView {
  installation_id: string;
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
  last_run_status: ConnectorWebhookRunResult["status"];
}

@Injectable()
export class PersonalConnectorService implements OnModuleDestroy {
  private readonly inflight = new Map<string, Promise<ConnectorSyncView>>();
  private readonly streamLocks = new Map<string, Promise<void>>();
  private readonly streamIdleUntil = new Map<string, number>();
  private readonly streamCatchingUp = new Set<string>();
  private readonly streamSeeded = new Set<string>();
  private readonly streamMeta = new Map<
    string,
    { thread_id: string | null; label: string | null }
  >();
  private readonly streamErrors = new Map<string, string>();
  private readonly streamPulling = new Set<string>();
  private readonly streamPullingHistory = new Set<string>();
  private focusSlot: {
    threadId: string;
    generation: number;
    kind: "hydrate" | "older" | "receipt";
    abort: AbortController;
    promise: Promise<void>;
  } | null = null;
  private focusGeneration = 0;
  private readonly hydrateCooldown = new Map<string, number>();
  private lastCatchUpCursor: string | undefined;
  private lastSeedCursor: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private ticking = false;
  private backgroundStarted = false;
  private maintenanceHold = false;
  private readonly quota = new InstallationQuotaBook();
  private readonly creatingByClient = new Map<string, Promise<CreatedConversationView>>();

  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
    @Inject(PersonalInboxService)
    private readonly inbox: PersonalInboxService,
    @Inject(ChannelDriverRegistry)
    private readonly drivers: ChannelDriverRegistry,
  ) {}

  startAfterListen(): void {
    if (this.backgroundStarted) {
      return;
    }
    this.backgroundStarted = true;
    const pullMs = pullIntervalMs();
    resetPullStatus();
    pullStatus.interval_ms = pullMs;
    if (pullMs > 0) {
      this.startTimer = setTimeout(() => {
        this.startTimer = undefined;
        void this.tick();
      }, START_PULL_DELAY_MS);
      this.timer = setInterval(() => {
        void this.tick();
      }, pullMs);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = undefined;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async pauseForMaintenance(): Promise<void> {
    this.maintenanceHold = true;
    try {
      await this.waitForQuiet();
      this.resetLivePullState();
    } catch (error) {
      this.maintenanceHold = false;
      throw error;
    }
  }

  resumeAfterMaintenance(): void {
    this.maintenanceHold = false;
  }

  async sync(
    installationId: string,
    maxPages = DEFAULT_MAX_PAGES,
    options?: ConnectorSyncOptions,
  ): Promise<ConnectorSyncView> {
    if (this.maintenanceHold) {
      throw new PersonalConnectorError(
        "disabled",
        "Store maintenance in progress",
        409,
      );
    }
    const existing = this.inflight.get(installationId);
    if (existing) {
      return existing;
    }
    const job = this.runSync(
      installationId,
      clampPages(maxPages),
      options,
    )
      .catch(async (error) => {
        await applyPullOutcome([error]);
        throw error;
      })
      .finally(() => {
        this.inflight.delete(installationId);
      });
    this.inflight.set(installationId, job);
    return job;
  }

  async ingestWebhook(
    installationId: string,
    request: WebhookRequest,
  ): Promise<ConnectorWebhookView> {
    if (this.maintenanceHold) {
      throw new PersonalConnectorError(
        "disabled",
        "Store maintenance in progress",
        409,
      );
    }
    const host = this.runtime.requireHost();
    const store = host.get("authority");
    const installation = await this.requireInstallation(store, installationId);
    if (installation.status !== "enabled") {
      throw new PersonalConnectorError(
        "disabled",
        "Connector installation is disabled",
        409,
      );
    }
    const driver = this.drivers.get(installation.connector_type);
    if (!driver) {
      throw new PersonalConnectorError(
        "unsupported_connector",
        `Connector type cannot ingest webhooks: ${installation.connector_type}`,
        400,
      );
    }
    try {
      const { bindWebhook } = requireWebhookPorts(driver);
      const connector = await bindWebhook(
        installation,
        asConnectorHost(host),
        process.env,
      );
      const runner = new ConnectorRunner(
        connector,
        host.get("ingest"),
        store,
        () => new Date().toISOString(),
        this.quota,
      );
      const run = await withDeadline(
        runner.webhook({
          installation_id: installation.id,
          request,
          timeout_ms: connectorPollTimeoutMs(),
        }),
        connectorSyncTimeoutMs(),
        `webhook ${installation.id}`,
      );
      if (run.status === "unsupported_mode") {
        throw new PersonalConnectorError(
          "unsupported_channel",
          "Webhook ingest is not available",
          501,
        );
      }
      if (run.status === "throttled") {
        throw new PersonalConnectorError(
          "throttled",
          "Connector installation is rate limited",
          429,
        );
      }
      const accepted = run as Extract<
        ConnectorWebhookRunResult,
        { status: "completed" | "retryable_failure" }
      >;
      const summary = summarizeWebhook(accepted);
      return {
        installation_id: installation.id,
        ...summary,
        last_run_status: run.status,
      };
    } catch (error) {
      throw wrapDriverError(error, "sync_failed");
    }
  }

  async listEgressQueue(
    installationId: string,
    input: { apiKey?: string; origin?: string } = {},
  ): Promise<{ commands: ReturnType<NonNullable<ChannelDriver["listEgressQueue"]>> }> {
    const host = this.runtime.requireHost();
    const installation = await this.requireInstallation(
      host.get("authority"),
      installationId,
    );
    const driver = this.drivers.get(installation.connector_type);
    if (!driver?.listEgressQueue) {
      throw new PersonalConnectorError(
        "unsupported_channel",
        "Egress queue is not available",
        501,
      );
    }
    await this.assertInstallSecret(installation, input);
    return { commands: driver.listEgressQueue(installation) };
  }

  async ackEgressQueue(
    installationId: string,
    commandId: string,
    input: { apiKey?: string; origin?: string } = {},
  ): Promise<{ acknowledged: boolean }> {
    const host = this.runtime.requireHost();
    const installation = await this.requireInstallation(
      host.get("authority"),
      installationId,
    );
    const driver = this.drivers.get(installation.connector_type);
    if (!driver?.ackEgressQueue) {
      throw new PersonalConnectorError(
        "unsupported_channel",
        "Egress queue is not available",
        501,
      );
    }
    await this.assertInstallSecret(installation, input);
    return driver.ackEgressQueue(installation, commandId);
  }

  async followThread(
    installationId: string,
    thread: ConversationThread,
  ): Promise<void> {
    if (this.maintenanceHold) {
      return;
    }
    const host = this.runtime.requireHost();
    const store = host.get("authority");
    const installation = await this.requireInstallation(store, installationId);
    const driver = this.drivers.get(installation.connector_type);
    if (!driver || installation.status !== "enabled") {
      return;
    }
    let stream: ConnectorStream;
    try {
      stream = await driver.resolveThreadStream(
        installation,
        thread,
        asConnectorHost(host),
        process.env,
      );
    } catch (error) {
      throw wrapDriverError(error, "sync_failed");
    }
    await this.exclusiveStream(installation.id, stream.stream_key, async () => {
      if (this.maintenanceHold) {
        return;
      }
      try {
        await this.followStream(host, store, installation, stream, thread);
      } catch (error) {
        throw wrapDriverError(error, "sync_failed");
      }
    });
  }

  async hydrateOpenedThread(threadId: string): Promise<void> {
    if (this.maintenanceHold) {
      return;
    }
    const id = threadId.trim();
    if (!id || !shouldHydrateOpenedInbox({ thread_id: id })) {
      return;
    }
    if (
      this.focusSlot?.threadId === id &&
      this.focusSlot.kind === "hydrate" &&
      !this.focusSlot.abort.signal.aborted
    ) {
      try {
        await Promise.race([this.focusSlot.promise, delay(HYDRATE_WAIT_MS)]);
      } catch {
        return;
      }
      return;
    }
    if ((this.hydrateCooldown.get(id) ?? 0) > Date.now()) {
      return;
    }
    const job = this.takeFocus(id, "hydrate", (signal, generation) =>
      this.runHydrateOpenedThread(id, signal, generation),
    );
    try {
      await Promise.race([job, delay(HYDRATE_WAIT_MS)]);
    } catch {
      return;
    }
  }

  /**
   * Mark the interactive thread without starting work.
   * Cancels hydrate/older jobs for any other thread so live receipts can proceed.
   */
  noteInteractiveFocus(threadId: string): void {
    const id = threadId.trim();
    if (!id) {
      return;
    }
    preferThread(id);
    if (this.focusSlot && this.focusSlot.threadId !== id) {
      this.focusSlot.abort.abort();
      this.focusSlot = null;
    }
  }

  async pullOlderForThread(threadId: string): Promise<void> {
    if (this.maintenanceHold) {
      return;
    }
    const id = threadId.trim();
    if (!id || !shouldPullOlderInbox({ thread_id: id, before: "1" })) {
      return;
    }
    noteHumanActivity();
    preferThread(id);
    if (
      this.focusSlot?.threadId === id &&
      this.focusSlot.kind === "hydrate" &&
      !this.focusSlot.abort.signal.aborted
    ) {
      try {
        await Promise.race([this.focusSlot.promise, delay(HYDRATE_WAIT_MS)]);
      } catch {
        return;
      }
    }
    try {
      await this.takeFocus(id, "older", (signal, generation) =>
        this.runPullOlderThread(id, signal, generation),
      );
    } catch {
      return;
    }
  }

  private takeFocus(
    threadId: string,
    kind: "hydrate" | "older" | "receipt",
    work: (signal: AbortSignal, generation: number) => Promise<void>,
  ): Promise<void> {
    if (
      this.focusSlot &&
      this.focusSlot.threadId === threadId &&
      this.focusSlot.kind === kind &&
      !this.focusSlot.abort.signal.aborted
    ) {
      return this.focusSlot.promise;
    }
    if (this.focusSlot) {
      this.focusSlot.abort.abort();
      this.focusSlot = null;
    }
    preferThread(threadId);
    const generation = ++this.focusGeneration;
    const abort = new AbortController();
    const promise = work(abort.signal, generation).finally(() => {
      if (this.focusSlot?.generation === generation) {
        this.focusSlot = null;
      }
    });
    this.focusSlot = {
      threadId,
      generation,
      kind,
      abort,
      promise,
    };
    return promise;
  }

  private focusAlive(generation: number, signal: AbortSignal): boolean {
    return !signal.aborted && this.focusSlot?.generation === generation;
  }

  private async runPullOlderThread(
    threadId: string,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    if (this.maintenanceHold || !this.focusAlive(generation, signal)) {
      return;
    }
    let thread: ConversationThread;
    try {
      thread = parseConversationThread(threadId);
    } catch {
      return;
    }
    const host = this.runtime.requireHost();
    const store = host.get("authority");
    const installations = await store.listInstallations(this.runtime.orgId());
    if (!this.focusAlive(generation, signal)) {
      return;
    }
    for (const installation of installations) {
      if (installation.status !== "enabled") {
        continue;
      }
      const driver = this.drivers.get(installation.connector_type);
      if (!driver?.matchesThread(installation, thread)) {
        continue;
      }
      let stream: ConnectorStream;
      try {
        stream = await driver.resolveThreadStream(
          installation,
          thread,
          asConnectorHost(host),
          process.env,
        );
      } catch {
        continue;
      }
      if (!this.focusAlive(generation, signal)) {
        return;
      }
      const key = streamPaceKey(installation.id, stream.stream_key);
      this.rememberStreamMeta(key, stream);
      this.streamPulling.add(key);
      this.streamPullingHistory.add(key);
      this.publishStreams();
      try {
        const pages = await this.exclusiveStream(
          installation.id,
          stream.stream_key,
          () => {
            if (!this.focusAlive(generation, signal)) {
              return Promise.resolve([]);
            }
            return runInSyncLane("interactive", () =>
              pollStream(
                host,
                store,
                installation,
                stream,
                1,
                { older: true, media: false },
                this.quota,
              ),
            );
          },
        );
        if (pages === undefined || !this.focusAlive(generation, signal)) {
          return;
        }
        this.rememberStreamPace({
          key,
          pages,
          pagesBudget: 1,
          idleMs: streamIdleMs(stream),
        });
      } catch (error) {
        this.rememberStreamPace({
          key,
          pages: [],
          pagesBudget: 1,
          idleMs: streamIdleMs(stream),
          error,
        });
        throw error;
      } finally {
        this.streamPulling.delete(key);
        this.streamPullingHistory.delete(key);
        this.publishStreams();
      }
      return;
    }
  }

  private async runHydrateOpenedThread(
    threadId: string,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    if (this.maintenanceHold || !this.focusAlive(generation, signal)) {
      return;
    }
    let thread: ConversationThread;
    try {
      thread = parseConversationThread(threadId);
    } catch {
      return;
    }
    const host = this.runtime.requireHost();
    const store = host.get("authority");
    const installations = await store.listInstallations(this.runtime.orgId());
    if (!this.focusAlive(generation, signal)) {
      return;
    }
    if (!this.drivers.hydrateOnOpen(installations, thread)) {
      return;
    }
    for (const installation of installations) {
      if (installation.status !== "enabled") {
        continue;
      }
      const driver = this.drivers.get(installation.connector_type);
      if (!driver?.matchesThread(installation, thread)) {
        continue;
      }
      if (!driver.capabilities(installation).hydrate_on_open) {
        continue;
      }
      let stream: ConnectorStream;
      try {
        stream = await driver.resolveThreadStream(
          installation,
          thread,
          asConnectorHost(host),
          process.env,
        );
      } catch {
        continue;
      }
      if (!this.focusAlive(generation, signal)) {
        return;
      }
      const key = streamPaceKey(installation.id, stream.stream_key);
      this.rememberStreamMeta(key, stream);
      this.streamPulling.add(key);
      this.publishStreams();
      try {
        const pages = await this.exclusiveStream(
          installation.id,
          stream.stream_key,
          () => {
            if (!this.focusAlive(generation, signal)) {
              return Promise.resolve([]);
            }
            return runInSyncLane("interactive", () =>
              pollStream(
                host,
                store,
                installation,
                stream,
                1,
                {
                  older: false,
                  media: false,
                },
                this.quota,
              ),
            );
          },
          { skipIfBusy: false },
        );
        if (pages === undefined || !this.focusAlive(generation, signal)) {
          return;
        }
        this.rememberStreamPace({
          key,
          pages,
          pagesBudget: 1,
          idleMs: streamIdleMs(stream),
        });
        this.hydrateCooldown.set(threadId, Date.now() + HYDRATE_COOLDOWN_MS);
        this.inbox.publishThreadUpdated(threadId);
        void this.inbox.publishInboxDigest();
      } catch (error) {
        this.rememberStreamPace({
          key,
          pages: [],
          pagesBudget: 1,
          idleMs: streamIdleMs(stream),
          error,
        });
        throw error;
      } finally {
        this.streamPulling.delete(key);
        this.publishStreams();
      }
      return;
    }
  }

  private async followStream(
    host: Host,
    store: ConnectorRuntimeStore,
    installation: ConnectorInstallation,
    stream: ConnectorStream,
    thread: ConversationThread,
  ): Promise<void> {
    const threadId = `${thread.source}:${thread.target}`;
    const before = await this.threadFollowState(threadId);
    for (let attempt = 0; attempt < FOLLOW_TRIES; attempt += 1) {
      await pollStream(
        host,
        store,
        installation,
        stream,
        2,
        { older: false },
        this.quota,
      );
      const after = await this.threadFollowState(threadId);
      if (after.latestId && after.latestId !== before.latestId && after.inbound) {
        await pollStream(
          host,
          store,
          installation,
          stream,
          2,
          { older: false },
          this.quota,
        );
        return;
      }
      if (attempt < FOLLOW_TRIES - 1) {
        await delay(FOLLOW_WAIT_MS);
      }
    }
  }

  private async threadFollowState(threadId: string): Promise<{
    latestId?: string;
    inbound: boolean;
  }> {
    const items = await this.inbox.listInbox({
      thread_id: threadId,
      heads: true,
    });
    const latest = items[items.length - 1];
    if (!latest) {
      return { inbound: false };
    }
    return {
      latestId: latest.event.id,
      inbound: latest.direction === "inbound",
    };
  }

  async createConversation(
    input: {
      installation_id?: string;
      source?: string;
      text?: string;
      cwd?: string;
      client_request_id?: string;
      locale?: CopyLocale;
    } = {},
  ): Promise<CreatedConversationView> {
    const clientKey = this.createClientKey(input.client_request_id);
    if (clientKey) {
      const pending = this.creatingByClient.get(clientKey);
      if (pending) {
        return pending;
      }
    }
    const run = this.createConversationOnce(input).catch((error) => {
      if (clientKey) {
        this.creatingByClient.delete(clientKey);
      }
      throw error;
    });
    if (clientKey) {
      this.creatingByClient.set(clientKey, run);
    }
    return run;
  }

  private createClientKey(value?: string): string | undefined {
    const id = value?.trim();
    return id ? `${this.runtime.orgId()}:${id}` : undefined;
  }

  async openCreatedThread(input: {
    installation_id?: string;
    source?: string;
    text?: string;
    cwd?: string;
  }): Promise<{
    thread: ConversationThread;
    installation: ConnectorInstallation;
    driver: ChannelDriver;
    create_with_task: boolean;
  }> {
    const host = this.runtime.requireHost();
    const found = await this.resolveCreatable(input);
    const withTask = found.driver.capabilities(found.installation).create_with_task === true;
    const firstTask = withTask ? input.text?.trim() : undefined;
    try {
      const thread = await requireCreateThread(found.driver)(
        found.installation,
        asConnectorHost(host),
        process.env,
        {
          ...(input.cwd?.trim() ? { cwd: input.cwd.trim() } : {}),
          ...(firstTask ? { text: firstTask } : {}),
        },
      );
      if (withTask) {
        void this.seedCreatedThread(found.installation, found.driver, thread, host).catch(
          () => {
            void this.catchUp(found.installation.id);
          },
        );
      } else {
        await this.seedCreatedThread(found.installation, found.driver, thread, host);
      }
      return {
        thread,
        installation: found.installation,
        driver: found.driver,
        create_with_task: withTask,
      };
    } catch (error) {
      throw wrapDriverError(error, "send_failed");
    }
  }

  private async resolveCreatable(input: {
    installation_id?: string;
    source?: string;
  }): Promise<{ installation: ConnectorInstallation; driver: ChannelDriver }> {
    const host = this.runtime.requireHost();
    const installations = await host
      .get("authority")
      .listInstallations(this.runtime.orgId());
    const requested = input.installation_id?.trim();
    if (requested) {
      const installation = installations.find((item) => item.id === requested);
      if (!installation) {
        throw new PersonalConnectorError(
          "not_found",
          "Connector installation not found",
          404,
        );
      }
      const driver = this.drivers.get(installation.connector_type);
      if (!driver || !driver.capabilities(installation).create) {
        throw new PersonalConnectorError(
          "unsupported_channel",
          "This connector cannot create a conversation",
          501,
        );
      }
      return { installation, driver };
    }
    const found = this.drivers.findCreatable(installations, input.source);
    if (!found) {
      throw new PersonalConnectorError(
        "unsupported_channel",
        "No enabled connector can create a conversation",
        501,
      );
    }
    return found;
  }

  private async createConversationOnce(
    input: {
      installation_id?: string;
      source?: string;
      text?: string;
      cwd?: string;
      locale?: CopyLocale;
    },
  ): Promise<CreatedConversationView> {
    const host = this.runtime.requireHost();
    const opened = await this.openCreatedThread(input);
    const firstTask = opened.create_with_task ? input.text?.trim() : undefined;
    if (firstTask) {
      try {
        await this.seedCreatedOutbound(
          opened.installation,
          opened.driver,
          opened.thread,
          firstTask,
          host,
        );
      } catch {
        // Poll below can still land the first task from the connector.
      }
    }
    return {
      thread_id: `${opened.thread.source}:${opened.thread.target}`,
      channel: opened.thread.source,
      channel_label: this.drivers.sourceLabel(
        opened.thread.source,
        process.env,
        input.locale ?? DEFAULT_COPY_LOCALE,
      ),
      can_send: driverCanReply(opened.driver, opened.installation),
      await_reply: opened.driver.capabilities(opened.installation).await_reply === true,
      list_title: normalizeListTitle(
        opened.driver.capabilities(opened.installation).list_title,
      ),
    };
  }

  private async seedCreatedOutbound(
    installation: ConnectorInstallation,
    driver: ChannelDriver,
    thread: ConversationThread,
    text: string,
    host: Host,
  ): Promise<void> {
    const now = new Date().toISOString();
    const receipt = { accepted: true as const, rpc_id: randomUUID() };
    const externalId = driver.outboundId
      ? driver.outboundId(thread, receipt)
      : `${thread.target}:out:${receipt.rpc_id}`;
    const record = channelRecord({
      channel: driver.source,
      kind: "user",
      direction: "outbound",
      external_id: externalId,
      occurred_at: now,
      actor_id: "local-owner",
      scope_id: thread.target,
      text,
    });
    record.weight_hints = { importance: 1 };
    await host.get("ingest").ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: installation.id,
      org_id: this.runtime.orgId(),
      delivery_id: `create:${externalId}`,
      received_at: now,
      records: [record],
    });
  }

  private async seedCreatedThread(
    installation: ConnectorInstallation,
    driver: ChannelDriver,
    thread: ConversationThread,
    host: Host,
  ): Promise<void> {
    const stream = await driver.resolveThreadStream(
      installation,
      thread,
      asConnectorHost(host),
      process.env,
    );
    await pollStream(
      host,
      host.get("authority"),
      installation,
      stream,
      1,
      undefined,
      this.quota,
    );
  }

  async install(input: ConnectorInstallInput): Promise<EngineInstallationView> {
    const store = this.runtime.requireHost().get("authority");
    if (
      !connectorAllowsMultiple(
        input.connector_type,
        catalogFromDrivers(this.drivers, process.env),
      )
    ) {
      const existing = (await store.listInstallations(this.runtime.orgId())).some(
        (item) => item.connector_type === input.connector_type,
      );
      if (existing) {
        throw new PersonalConnectorError(
          "already_installed",
          `${input.connector_type} is already installed`,
          409,
        );
      }
    }
    const now = new Date().toISOString();
    const drafted = this.buildInstallation(input, now);
    const created = await store.createInstallation({
      ...drafted,
      config: persistInstallSecrets({
        connector_type: drafted.connector_type,
        installation_id: drafted.id,
        catalog: this.drivers.get(drafted.connector_type)?.installCatalog?.({
          env: process.env,
        }),
        incoming: input.config ?? {},
        stored: drafted.config ?? {},
      }),
    });
    void this.catchUp(created.id);
    return this.viewWithPairingCode(store, created);
  }

  async updateConfig(
    installationId: string,
    config: Record<string, unknown>,
  ): Promise<EngineInstallationView> {
    const store = this.runtime.requireHost().get("authority");
    const current = await this.requireInstallation(store, installationId);
    const driver = this.drivers.get(current.connector_type);
    if (!driver) {
      throw new PersonalConnectorError(
        "unsupported_connector",
        `Connector type cannot be updated: ${current.connector_type}`,
        400,
      );
    }
    let nextConfig: ConnectorInstallation["config"];
    try {
      nextConfig = persistInstallSecrets({
        connector_type: current.connector_type,
        installation_id: current.id,
        catalog: driver.installCatalog?.({ env: process.env }),
        incoming: config,
        stored: driver.install({
          id: current.id,
          org_id: current.org_id,
          config,
          now: new Date().toISOString(),
        }).config,
      });
    } catch (error) {
      throw wrapDriverError(error, "invalid_config");
    }
    const updated = await store.updateInstallationConfig({
      id: current.id,
      org_id: this.runtime.orgId(),
      config: nextConfig,
      updated_at: new Date().toISOString(),
    });
    if (!updated) {
      throw new PersonalConnectorError(
        "not_found",
        "Connector installation not found",
        404,
      );
    }
    if (updated.status === "enabled") {
      void this.catchUp(updated.id);
    }
    return this.viewOf(store, updated);
  }

  async uninstall(installationId: string): Promise<{ id: string; removed: true }> {
    const store = this.runtime.requireHost().get("authority");
    const current = await store.findInstallation(installationId);
    if (!current || current.org_id !== this.runtime.orgId()) {
      return { id: installationId, removed: true };
    }
    await store.deleteInstallation(current.id, this.runtime.orgId());
    return { id: current.id, removed: true };
  }

  async setStatus(
    installationId: string,
    status: "enabled" | "disabled",
  ): Promise<EngineInstallationView> {
    const store = this.runtime.requireHost().get("authority");
    const current = await this.requireInstallation(store, installationId);
    const updated = await store.setInstallationStatus({
      id: current.id,
      org_id: this.runtime.orgId(),
      status,
      updated_at: new Date().toISOString(),
    });
    if (!updated) {
      throw new PersonalConnectorError(
        "not_found",
        "Connector installation not found",
        404,
      );
    }
    if (status === "enabled") {
      void this.catchUp(updated.id);
    }
    return this.viewOf(store, updated);
  }

  private async waitForQuiet(timeoutMs = 10_000): Promise<void> {
    const started = Date.now();
    while (
      this.ticking ||
      this.inflight.size > 0 ||
      this.streamLocks.size > 0 ||
      this.focusSlot != null
    ) {
      if (Date.now() - started > timeoutMs) {
        throw storeBusyError();
      }
      await delay(50);
    }
  }

  private resetLivePullState(): void {
    const interval = pullStatus.interval_ms;
    if (this.focusSlot) {
      this.focusSlot.abort.abort();
      this.focusSlot = null;
    }
    this.streamIdleUntil.clear();
    this.streamCatchingUp.clear();
    this.streamSeeded.clear();
    this.streamMeta.clear();
    this.streamErrors.clear();
    this.streamPulling.clear();
    this.streamPullingHistory.clear();
    this.hydrateCooldown.clear();
    this.lastCatchUpCursor = undefined;
    this.lastSeedCursor = undefined;
    resetPullStatus();
    pullStatus.interval_ms = interval;
  }

  private async tick(): Promise<void> {
    if (this.maintenanceHold || this.ticking || !this.runtime.isReady()) {
      return;
    }
    this.ticking = true;
    if (this.maintenanceHold) {
      this.ticking = false;
      return;
    }
    try {
      const store = this.runtime.requireHost().get("authority");
      const installations = await store.listInstallations(this.runtime.orgId());
      const eligible = installations.filter((installation) => {
        const driver = this.drivers.get(installation.connector_type);
        return (
          installation.status === "enabled" &&
          driver &&
          driverPolls(driver) &&
          !this.inflight.has(installation.id)
        );
      });
      const errors = await settleIsolated(
        eligible.map(
          (installation) => () =>
            this.sync(installation.id, DEFAULT_MAX_PAGES, {
              skipIdle: true,
              capCatchUp: true,
              allowHistory: isHumanIdle(),
            }),
        ),
        {
          timeoutMs: connectorSyncTimeoutMs(),
          label: (index) =>
            `sync ${eligible[index]?.connector_type ?? "install"}`,
        },
      );
      pullStatus.last_tick_at = new Date().toISOString();
      await applyPullOutcome(errors);
    } catch (error) {
      await applyPullOutcome([error]);
    } finally {
      this.ticking = false;
    }
  }

  private async catchUp(installationId: string): Promise<void> {
    try {
      await withDeadline(
        this.sync(installationId, DEFAULT_MAX_PAGES, {
          skipIdle: true,
          capCatchUp: true,
          allowHistory: false,
          discover: true,
        }),
        connectorSyncTimeoutMs(),
        `catchUp ${installationId}`,
      );
    } catch (error) {
      await applyPullOutcome([error]);
    }
  }

  private async runSync(
    installationId: string,
    maxPages: number,
    options?: ConnectorSyncOptions,
  ): Promise<ConnectorSyncView> {
    if (this.maintenanceHold) {
      throw new PersonalConnectorError(
        "disabled",
        "Store maintenance in progress",
        409,
      );
    }
    const host = this.runtime.requireHost();
    const store = host.get("authority");
    const installation = await this.requireInstallation(store, installationId);
    if (installation.status !== "enabled") {
      throw new PersonalConnectorError(
        "disabled",
        "Connector installation is disabled",
        409,
      );
    }
    const driver = this.drivers.get(installation.connector_type);
    if (!driver) {
      throw new PersonalConnectorError(
        "unsupported_connector",
        `Connector type cannot be synced: ${installation.connector_type}`,
        400,
      );
    }
    if (!driverPolls(driver)) {
      return {
        installation_id: installation.id,
        pages_attempted: 0,
        streams_attempted: 0,
        accepted_count: 0,
        duplicate_count: 0,
        quarantined_count: 0,
        last_run_status: "idle",
        installation: await this.viewOf(store, installation),
      };
    }
    beginPull();
    this.publishStreams();
    try {
      const engine = new SyncEngine(store);
      const allowHistory = options?.allowHistory !== false;
      const humanIdle = allowHistory && isHumanIdle();
      if (driver.bindSyncSource) {
        const source = await driver.bindSyncSource(
          installation,
          asConnectorHost(host),
          process.env,
        );
        await engine.refreshCatalog({
          installation_id: installation.id,
          source,
          pages: catalogRefreshPages({
            discover: options?.discover,
            humanIdle,
          }),
          force: options?.discover === true,
        });
      }
      const catalog = await engine.catalog(installation.id);
      const threads = mergeConversationThreads(
        await loadEligibleInstallationThreads(
          store,
          installation.org_id,
          installation,
          driver,
          preferredThreadId(),
        ),
        threadsFromCatalog(catalog.members, driver.source),
      );
      const streams = await driver.resolveStreams(
        installation,
        asConnectorHost(host),
        process.env,
        {
          threads,
          catalog: catalog.members,
          discover: !driver.bindSyncSource && options?.discover === true,
        },
      );
      await this.persistPickedChatNames(store, installation, streams);
      this.pruneStreamPace(installation.id, streams);
      const cursorStates = new Map<string, string | undefined>();
      await Promise.all(
        streams.map(async (stream) => {
          const cursor = await store.getCursor(
            installation.id,
            stream.stream_key,
          );
          cursorStates.set(stream.stream_key, cursor?.cursor);
        }),
      );
      const work = await engine.plan({
        installation_id: installation.id,
        preferredThreadId: preferredThreadId(),
        humanIdle,
        rotateFrom: this.lastCatchUpCursor,
        rotateSeedFrom: this.lastSeedCursor,
        pages: options?.capCatchUp ? DEFAULT_MAX_PAGES : maxPages,
        fallbackMembers: catalogMembersFromStreams(installation.id, streams),
        cursorStates,
      });
      const streamByKey = new Map(
        streams.map((stream) => [stream.stream_key, stream] as const),
      );
      const selected = work.flatMap((item) => {
        if (item.lane === "catalog") {
          return [];
        }
        const stream = streamByKey.get(item.stream_key);
        if (!stream) {
          return [];
        }
        const key = streamPaceKey(installation.id, stream.stream_key);
        this.rememberStreamMeta(key, stream);
        if (item.older || item.lane === "history") {
          this.streamCatchingUp.add(key);
        }
        const budget = syncExecutionBudget({
          humanIdle,
          capCatchUp: options?.capCatchUp,
          lane: item.lane,
          pages: item.pages,
          catchUpPages: streamCatchUpPages(stream, item.pages),
        });
        return [
          {
            stream,
            key,
            idleMs: streamIdleMs(stream),
            older: item.older,
            pages: budget.pages,
            lane: item.lane,
            media: item.media,
          },
        ];
      });
      const olderKey = engine.lastHistoryKey(work);
      if (olderKey) {
        this.lastCatchUpCursor = olderKey;
      }
      const seedKey = engine.lastSeedKey(work);
      if (seedKey) {
        this.lastSeedCursor = seedKey;
      }
      for (const item of selected) {
        this.streamPulling.add(item.key);
        if (item.older) {
          this.streamPullingHistory.add(item.key);
        }
      }
      this.publishStreams();
      const textItems = selected.filter((item) => !item.media);
      const mediaItems = selected.filter((item) => item.media);
      const textConcurrency = syncExecutionBudget({
        humanIdle,
        capCatchUp: options?.capCatchUp,
        lane: "live",
        pages: 1,
      }).concurrency;
      const mediaConcurrency = syncExecutionBudget({
        humanIdle,
        capCatchUp: options?.capCatchUp,
        lane: "media",
        pages: 1,
      }).concurrency;
      const runSelected = async (item: (typeof selected)[number]) => {
        try {
          const pages = await this.exclusiveStream(
            installation.id,
            item.stream.stream_key,
            () =>
              runInSyncLane(item.lane, () =>
                pollStream(
                  host,
                  store,
                  installation,
                  item.stream,
                  item.pages,
                  { older: item.older, media: item.media },
                  this.quota,
                ),
              ),
            { skipIfBusy: item.lane !== "interactive" },
          );
          const result = {
            key: item.key,
            pages: pages ?? [],
            pagesBudget: item.pages,
            idleMs: item.idleMs,
            error: null as unknown,
          };
          this.streamPulling.delete(item.key);
          if (item.older) {
            this.streamPullingHistory.delete(item.key);
          }
          this.rememberStreamPace(result);
          await rememberEngineResult(engine, installation.id, item, result);
          this.publishStreams();
          return result;
        } catch (error) {
          const result = {
            key: item.key,
            pages: [] as ConnectorPollRunResult[],
            pagesBudget: item.pages,
            idleMs: item.idleMs,
            error,
          };
          this.streamPulling.delete(item.key);
          if (item.older) {
            this.streamPullingHistory.delete(item.key);
          }
          this.rememberStreamPace(result);
          await rememberEngineResult(engine, installation.id, item, result);
          this.publishStreams();
          return result;
        }
      };
      // Text first so the open thread's lease is free before its media drain.
      const textBatches = await mapLimit(textItems, textConcurrency, runSelected);
      const mediaBatches = await mapLimit(mediaItems, mediaConcurrency, runSelected);
      const batches = [...textBatches, ...mediaBatches];
      const runs = batches.flatMap((batch) => batch.pages);
      const firstError = batches.find((batch) => batch.error)?.error;
      if (runs.length === 0 && firstError) {
        throw firstError;
      }
      await this.reconcileCatchingUp(store, installation.id, streams);
      const last = runs.at(-1);
      const summary = summarizeRuns(runs);
      finishPull({
        accepted: summary.accepted_count,
        pages: runs.length,
        catchingUp: this.streamCatchingUp.size,
      });
      if (summary.accepted_count > 0) {
        void this.inbox.publishInboxDigest();
      }
      this.publishStreams();
      return {
        installation_id: installation.id,
        pages_attempted: runs.length,
        streams_attempted: options?.skipIdle ? selected.length : streams.length,
        ...summary,
        last_run_status: last?.status ?? "idle",
        installation: await this.viewOf(store, installation),
      };
    } catch (error) {
      finishPull({
        accepted: 0,
        pages: 0,
        catchingUp: this.streamCatchingUp.size,
      });
      this.publishStreams();
      throw wrapDriverError(error, "sync_failed");
    }
  }

  private async reconcileCatchingUp(
    store: ConnectorRuntimeStore,
    installationId: string,
    streams: readonly ConnectorStream[],
  ): Promise<void> {
    const states = await store.listSyncStates(installationId);
    const byKey = new Map(
      states.map((state) => [state.stream_key, state] as const),
    );
    const mounted = new Set(streams.map((stream) => stream.stream_key));
    const prefix = `${installationId}:`;
    for (const key of [...this.streamCatchingUp]) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      if (this.streamPulling.has(key) || this.streamPullingHistory.has(key)) {
        continue;
      }
      const streamKey = key.slice(prefix.length);
      if (!mounted.has(streamKey)) {
        this.streamCatchingUp.delete(key);
        continue;
      }
      const state = byKey.get(streamKey);
      if (!state || state.phase === "unseeded" || state.phase === "history") {
        continue;
      }
      // Coverage already moved this stream to live/steady; drop the sticky
      // "还剩 N" chip instead of waiting for another empty tip poll.
      this.streamCatchingUp.delete(key);
    }
  }

  private buildInstallation(
    input: ConnectorInstallInput,
    now: string,
  ) {
    const driver = this.drivers.get(input.connector_type);
    if (!driver) {
      throw new PersonalConnectorError(
        "unsupported_connector",
        `Connector type cannot be installed: ${input.connector_type}`,
        400,
      );
    }
    try {
      return driver.install({
        id: randomUUID(),
        org_id: this.runtime.orgId(),
        config: input.config ?? {},
        now,
      });
    } catch (error) {
      throw wrapDriverError(error, "invalid_config");
    }
  }

  async revealPairingCode(
    installationId: string,
  ): Promise<{ pairing_code: string }> {
    const host = this.runtime.requireHost();
    const installation = await this.requireInstallation(
      host.get("authority"),
      installationId,
    );
    if (installation.connector_type !== WHATSAPP_WEB_LIVE_CONNECTOR_TYPE) {
      throw new PersonalConnectorError(
        "not_found",
        "Pairing code is not available",
        404,
      );
    }
    const pairing_code = await this.pairingCodeOf(installation);
    if (!pairing_code) {
      throw new PersonalConnectorError(
        "not_found",
        "Pairing code is not available",
        404,
      );
    }
    return { pairing_code };
  }

  async allowsBrowserLiveRequest(path: string, apiKey: string): Promise<boolean> {
    try {
      const host = this.runtime.requireHost();
      const store = host.get("authority");
      if (path === "/v1/me/engine") {
        const installations = await store.listInstallations(this.runtime.orgId());
        for (const installation of installations) {
          if (
            installation.status === "enabled" &&
            installation.connector_type === WHATSAPP_WEB_LIVE_CONNECTOR_TYPE &&
            whatsAppLiveKeyMatches(
              apiKey,
              await resolveWhatsAppLiveKeys(installation, process.env),
            )
          ) {
            return true;
          }
        }
        return false;
      }
      const match = /^\/v1\/me\/connectors\/([^/]+)\/(webhook|egress(?:\/[^/]+\/ack)?)$/.exec(path);
      if (!match) {
        return false;
      }
      const installation = await store.findInstallation(decodeURIComponent(match[1]));
      return Boolean(
        installation &&
        installation.org_id === this.runtime.orgId() &&
        installation.status === "enabled" &&
        installation.connector_type === WHATSAPP_WEB_LIVE_CONNECTOR_TYPE &&
        whatsAppLiveKeyMatches(
          apiKey,
          await resolveWhatsAppLiveKeys(installation, process.env),
        ),
      );
    } catch {
      return false;
    }
  }

  private async viewWithPairingCode(
    store: ConnectorRuntimeStore,
    installation: ConnectorInstallation,
  ): Promise<EngineInstallationView> {
    const view = await this.viewOf(store, installation);
    const pairing_code = await this.pairingCodeOf(installation);
    return pairing_code ? { ...view, pairing_code } : view;
  }

  private pairingCodeOf(
    installation: ConnectorInstallation,
  ): Promise<string | undefined> {
    if (installation.connector_type !== WHATSAPP_WEB_LIVE_CONNECTOR_TYPE) {
      return Promise.resolve(undefined);
    }
    return readWhatsAppLivePairingCode(installation.id);
  }

  private async assertInstallSecret(
    installation: ConnectorInstallation,
    input: { apiKey?: string; origin?: string },
  ): Promise<void> {
    if (installation.connector_type === WHATSAPP_WEB_LIVE_CONNECTOR_TYPE) {
      const allowed = await resolveWhatsAppLiveKeys(installation, process.env);
      const origin = input.origin?.trim();
      if (origin) {
        if (!whatsAppLiveKeyMatches(input.apiKey, allowed)) {
          throw new PersonalConnectorError(
            "unauthorized",
            allowed.pairingCode || allowed.envKey
              ? "Invalid live connector API key"
              : "Live connector API key is required for browser access",
            401,
          );
        }
        return;
      }
      if (allowed.envKey && input.apiKey !== allowed.envKey) {
        throw new PersonalConnectorError(
          "unauthorized",
          "Invalid live connector API key",
          401,
        );
      }
      return;
    }
    const expected = readEnvCredential(installation.credentials_ref, process.env);
    if (input.origin?.trim() && !expected) {
      throw new PersonalConnectorError(
        "unauthorized",
        "Live connector API key is required for browser access",
        401,
      );
    }
    if (expected && input.apiKey !== expected) {
      throw new PersonalConnectorError(
        "unauthorized",
        "Invalid live connector API key",
        401,
      );
    }
  }

  private async requireInstallation(
    store: ConnectorRuntimeStore,
    installationId: string,
  ): Promise<ConnectorInstallation> {
    const installation = await store.findInstallation(installationId);
    if (!installation || installation.org_id !== this.runtime.orgId()) {
      throw new PersonalConnectorError(
        "not_found",
        "Connector installation not found",
        404,
      );
    }
    return installation;
  }

  private pruneStreamPace(
    installationId: string,
    streams: ConnectorStream[],
  ): void {
    const live = new Set(
      streams.map((stream) => streamPaceKey(installationId, stream.stream_key)),
    );
    const prefix = `${installationId}:`;
    for (const key of [
      ...this.streamIdleUntil.keys(),
      ...this.streamCatchingUp,
      ...this.streamSeeded,
      ...this.streamMeta.keys(),
      ...this.streamErrors.keys(),
      ...this.streamPulling,
      ...this.streamPullingHistory,
    ]) {
      if (key.startsWith(prefix) && !live.has(key)) {
        this.streamIdleUntil.delete(key);
        this.streamCatchingUp.delete(key);
        this.streamSeeded.delete(key);
        this.streamMeta.delete(key);
        this.streamErrors.delete(key);
        this.streamPulling.delete(key);
        this.streamPullingHistory.delete(key);
      }
    }
  }

  private rememberStreamMeta(key: string, stream: ConnectorStream): void {
    this.streamMeta.set(key, {
      thread_id: stream.thread_id ?? null,
      label: stream.label ?? null,
    });
  }

  private publishStreams(): void {
    const preferred = preferredThreadId();
    const keys = new Set([
      ...this.streamCatchingUp,
      ...this.streamPulling,
      ...this.streamErrors.keys(),
    ]);
    if (preferred) {
      for (const [key, meta] of this.streamMeta) {
        if (meta.thread_id === preferred) {
          keys.add(key);
        }
      }
    }
    const streams: PullStreamStatus[] = [...keys].map((key) => {
      const meta = this.streamMeta.get(key);
      const error = this.streamErrors.get(key) ?? null;
      const phase = this.streamPulling.has(key)
        ? "pulling"
        : error
          ? "error"
          : this.streamCatchingUp.has(key)
            ? "catching_up"
            : "idle";
      return {
        stream_key: key,
        thread_id: meta?.thread_id ?? null,
        label: meta?.label ?? null,
        phase,
        work: this.streamPulling.has(key)
          ? this.streamPullingHistory.has(key)
            ? "history"
            : "live"
          : null,
        last_error: error,
      };
    });
    publishPullStreams(streams);
  }

  private rememberStreamPace(input: {
    key: string;
    pages: ConnectorPollRunResult[];
    pagesBudget: number;
    idleMs?: number;
    error?: unknown;
  }): void {
    if (input.error) {
      this.streamErrors.set(input.key, errorMessage(input.error));
    } else {
      this.streamErrors.delete(input.key);
    }
    if (input.pages.length === 0 && !input.error) {
      return;
    }
    this.streamSeeded.add(input.key);
    const summary = summarizeRuns(input.pages);
    if (
      shouldKeepCatchingUp({
        pages: input.pages,
        pagesBudget: input.pagesBudget,
        acceptedCount: summary.accepted_count,
        quarantinedCount: summary.quarantined_count,
        error: input.error,
      })
    ) {
      this.streamCatchingUp.add(input.key);
      this.streamIdleUntil.delete(input.key);
      return;
    }
    this.streamCatchingUp.delete(input.key);
    if (input.idleMs !== undefined) {
      this.streamIdleUntil.set(input.key, Date.now() + input.idleMs);
      return;
    }
    this.streamIdleUntil.delete(input.key);
  }

  private isThreadStreamBusy(threadId: string): boolean {
    for (const [key, meta] of this.streamMeta) {
      if (meta.thread_id !== threadId) {
        continue;
      }
      if (this.streamPulling.has(key) || this.streamLocks.has(key)) {
        return true;
      }
    }
    return false;
  }

  private exclusiveStream<T>(
    installationId: string,
    streamKey: string,
    work: () => Promise<T>,
    options?: { skipIfBusy?: boolean },
  ): Promise<T | undefined> {
    const lock = `${installationId}:${streamKey}`;
    if (options?.skipIfBusy && this.streamLocks.has(lock)) {
      return Promise.resolve(undefined);
    }
    const previous = this.streamLocks.get(lock) ?? Promise.resolve();
    const current = previous.then(work, work);
    const released = current.then(
      () => undefined,
      () => undefined,
    );
    this.streamLocks.set(lock, released);
    void released.then(() => {
      if (this.streamLocks.get(lock) === released) {
        this.streamLocks.delete(lock);
      }
    });
    return current;
  }

  private async persistPickedChatNames(
    store: ConnectorRuntimeStore,
    installation: ConnectorInstallation,
    streams: ConnectorStream[],
  ): Promise<void> {
    const names = nextPickedChatNames(installation.config, streams);
    if (!names) {
      return;
    }
    await store.updateInstallationConfig({
      id: installation.id,
      org_id: installation.org_id,
      config: {
        ...installation.config,
        chat_names: names,
      },
      updated_at: new Date().toISOString(),
    });
  }

  private async viewOf(
    store: ConnectorRuntimeStore,
    installation: ConnectorInstallation,
  ): Promise<EngineInstallationView> {
    const [attempt, sync] = await Promise.all([
      store.latestAttempt(installation.id),
      loadSyncProgress(store, installation.id),
    ]);
    return toInstallationView(installation, attempt, this.drivers, DEFAULT_COPY_LOCALE, {
      sync,
    });
  }
}

export function wrapDriverError(
  error: unknown,
  fallback: "sync_failed" | "send_failed" | "invalid_config",
): PersonalConnectorError {
  if (error instanceof PersonalConnectorError) {
    return error;
  }
  if (error instanceof DeadlineExceededError) {
    return new PersonalConnectorError(
      error.code,
      error.message,
      httpStatusFor(error.code),
    );
  }
  if (error instanceof ChannelDriverError) {
    return new PersonalConnectorError(
      error.code,
      error.message,
      httpStatusFor(error.code),
    );
  }
  const message =
    error instanceof Error ? error.message : "Connector operation failed";
  return new PersonalConnectorError(fallback, message, httpStatusFor(fallback));
}

function httpStatusFor(code: string): number {
  switch (code) {
    case "invalid_config":
    case "missing_credentials":
      return 400;
    case "unsupported_channel":
      return 501;
    case "no_sender":
      return 404;
    case "disabled":
    case "lease_unavailable":
      return 409;
    case "deadline_exceeded":
      return 504;
    case "throttled":
      return 429;
    default:
      return 502;
  }
}

async function pollStream(
  host: Host,
  store: ConnectorRuntimeStore,
  installation: ConnectorInstallation,
  stream: ConnectorStream,
  maxPages: number,
  options?: { older?: boolean; media?: boolean },
  quota?: InstallationQuotaBook,
): Promise<ConnectorPollRunResult[]> {
  const runner = new ConnectorRunner(
    stream.connector,
    host.get("ingest"),
    store,
    () => new Date().toISOString(),
    quota,
  );
  const runs: ConnectorPollRunResult[] = [];
  const seenCursors = new Set<string>();
  for (let page = 0; page < maxPages; page += 1) {
    const run = await runner.poll({
      installation_id: installation.id,
      stream_key: stream.stream_key,
      lease_owner: `personal-api:${randomUUID()}`,
      lease_duration_ms: LEASE_MS,
      older: options?.older === true,
      media: options?.media,
      timeout_ms: connectorPollTimeoutMs(),
    });
    runs.push(run);
    if (run.status === "lease_unavailable") {
      throw new PersonalConnectorError(
        "lease_unavailable",
        "Connector stream is already leased",
        409,
      );
    }
    if (run.status === "throttled" || run.status === "unsupported_mode") {
      break;
    }
    if (run.status !== "completed") {
      break;
    }
    if (run.has_more === false || !run.next_cursor) {
      break;
    }
    if (seenCursors.has(run.next_cursor)) {
      break;
    }
    seenCursors.add(run.next_cursor);
  }
  return runs;
}

function pullIntervalMs(): number {
  const raw = Number(process.env.REGENIC_CONNECTOR_PULL_MS ?? DEFAULT_PULL_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.max(1_000, Math.min(raw, 60_000));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function streamPaceKey(installationId: string, streamKey: string): string {
  return `${installationId}:${streamKey}`;
}

function streamIdleMs(stream: ConnectorStream): number | undefined {
  const value = stream.pace?.idle_ms;
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return undefined;
  }
  return value;
}

function streamCatchUpPages(
  stream: ConnectorStream,
  fallback: number,
): number {
  const value = stream.pace?.catch_up_pages;
  if (!Number.isInteger(value) || value === undefined || value < 1) {
    return fallback;
  }
  return Math.min(value, MAX_PAGES_CAP);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

function clampPages(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_MAX_PAGES;
  }
  return Math.min(value, MAX_PAGES_CAP);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Connector pull failed";
}

function mergeConversationThreads(
  ...lists: ConversationThread[][]
): ConversationThread[] {
  const byId = new Map<string, ConversationThread>();
  for (const thread of lists.flat()) {
    byId.set(`${thread.source}:${thread.target}`, thread);
  }
  return [...byId.values()];
}

function threadsFromCatalog(
  members: readonly SyncCatalogMember[],
  source: string,
): ConversationThread[] {
  return members.flatMap((member) => {
    if (member.thread_id) {
      try {
        return [parseConversationThread(member.thread_id)];
      } catch {
        return [];
      }
    }
    const prefix = `${source}:`;
    for (const kind of ["chat:", "session:", "channel:", "agent:"]) {
      if (member.stream_key.startsWith(kind)) {
        return [{ source, target: member.stream_key.slice(kind.length) }];
      }
    }
    if (member.stream_key.startsWith(prefix)) {
      return [{ source, target: member.stream_key.slice(prefix.length) }];
    }
    return [];
  });
}

function catalogMembersFromStreams(
  installationId: string,
  streams: readonly ConnectorStream[],
): SyncCatalogMember[] {
  const now = new Date().toISOString();
  return streams.map((stream) => ({
    installation_id: installationId,
    stream_key: stream.stream_key,
    thread_id: stream.thread_id,
    label: stream.label,
    generation: 1,
    discovered_at: now,
    last_seen_at: now,
  }));
}

async function rememberEngineResult(
  engine: SyncEngine,
  installationId: string,
  item: { stream: ConnectorStream; older: boolean; media: boolean; idleMs?: number },
  result: { pages: ConnectorPollRunResult[]; error?: unknown },
): Promise<void> {
  const summary = summarizeRuns(result.pages);
  const last = [...result.pages].reverse().find((page) => "next_cursor" in page);
  const nextCursor =
    last && "next_cursor" in last ? last.next_cursor : undefined;
  const mediaPage = [...result.pages]
    .reverse()
    .find((page) => "media_pending" in page);
  await engine.rememberResult({
    installation_id: installationId,
    stream_key: item.stream.stream_key,
    thread_id: item.stream.thread_id,
    older: item.older,
    media: item.media,
    accepted_count: summary.accepted_count,
    quarantined_count: summary.quarantined_count,
    has_more: result.pages.some(
      (page) => "has_more" in page && page.has_more === true,
    ),
    next_live_cursor: nextCursor,
    next_history_cursor: nextCursor,
    media_pending:
      mediaPage && "media_pending" in mediaPage
        ? mediaPage.media_pending
        : undefined,
    idle_ms: item.idleMs,
    error: result.error,
    now: new Date().toISOString(),
  });
}

function summarizeWebhook(run: Extract<
  ConnectorWebhookRunResult,
  { status: "completed" | "retryable_failure" }
>): {
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
} {
  return run.result.records.reduce(
    (acc, record) => {
      if (record.status === "accepted") {
        acc.accepted_count += 1;
      }
      if (record.status === "duplicate") {
        acc.duplicate_count += 1;
      }
      if (record.status === "quarantined") {
        acc.quarantined_count += 1;
      }
      return acc;
    },
    { accepted_count: 0, duplicate_count: 0, quarantined_count: 0 },
  );
}

function summarizeRuns(runs: ConnectorPollRunResult[]): {
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
} {
  return runs.reduce(
    (acc, run) => {
      if (!("result" in run)) {
        return acc;
      }
      for (const record of run.result.records) {
        if (record.status === "accepted") {
          acc.accepted_count += 1;
        }
        if (record.status === "duplicate") {
          acc.duplicate_count += 1;
        }
        if (record.status === "quarantined") {
          acc.quarantined_count += 1;
        }
      }
      return acc;
    },
    { accepted_count: 0, duplicate_count: 0, quarantined_count: 0 },
  );
}

