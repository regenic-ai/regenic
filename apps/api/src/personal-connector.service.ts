import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  ChannelDriverRegistry,
  type CopyLocale,
  isSyncSoftMiss,
  asConnectorHost,
  type ChannelDriver,
  type ConnectorInstallation,
  type ConnectorPollRunResult,
  type ConnectorRuntimeStore,
  type ConnectorStream,
  type ConversationThread,
  type IngestQuarantine,
  type SyncRun,
  type WebhookRequest,
  historySyncClaimLanes,
  shouldRunHistoryTick,
  steadySyncClaimLanes,
} from "@regenic/domain";
import {
  nextPickedChatNames,
  type EngineInstallationView,
} from "./personal-connector-view";
import { PersonalConnectorError, storeBusyError } from "./personal-errors";
import { PersonalInboxService } from "./personal-inbox.service";
import { KernelRuntimeService } from "./kernel-runtime.service";
import {
  applyPullOutcome,
  preferredThreadId,
  publishPullStreams,
  pullStatus,
  resetPullStatus,
  type PullStreamStatus,
} from "./personal-pull-status";
import { shouldKeepCatchingUp } from "./personal-stream-pace";
import {
  backgroundSyncReleased,
  markBackgroundListen,
} from "./personal-interactive-gate";
import { PersonalRuntimeService } from "./personal-runtime.service";
import { createConnectorState, type ConnectorState } from "./personal-connector-state";
import type {
  ConnectorInstallInput,
  ConnectorWebhookView,
  CreatedConversationView,
  StartSyncRunInput,
} from "./personal-connector-types";
import { summarizeRuns } from "./personal-connector-poll";
import {
  bootstrapPullIntervalMs,
  catalogPullIntervalMs,
  pullIntervalMs,
  streamPaceKey,
} from "./personal-connector-rhythm";
import * as connectorSyncRun from "./personal-connector-sync-run";
import * as connectorWebhook from "./personal-connector-webhook";
import * as connectorEgress from "./personal-connector-egress";
import * as connectorLive from "./personal-connector-live";
import { delay } from "./personal-connector-live";
import * as connectorConversation from "./personal-connector-conversation";
import * as connectorInstall from "./personal-connector-install";
import {
  catchUp,
  runCatalogTick,
  runDueWorkPlane,
} from "./personal-connector-due-work";

export { PersonalConnectorError } from "./personal-errors";
export { wrapDriverError } from "./personal-connector-poll";
export type {
  ConnectorInstallInput,
  ConnectorWebhookView,
  CreatedConversationView,
  StartSyncRunInput,
} from "./personal-connector-types";

const START_PULL_DELAY_MS = 1_000;

@Injectable()
export class PersonalConnectorService implements OnModuleDestroy {
  private readonly state: ConnectorState;
  private readonly streamLocks = new Map<string, Promise<void>>();
  private readonly streamIdleUntil = new Map<string, number>();
  private readonly streamSeeded = new Set<string>();
  private readonly streamErrors = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private bootstrapTimer: ReturnType<typeof setInterval> | undefined;
  private catalogTimer: ReturnType<typeof setInterval> | undefined;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private bootstrapStartTimer: ReturnType<typeof setTimeout> | undefined;
  private catalogStartTimer: ReturnType<typeof setTimeout> | undefined;
  private steadyTicking = false;
  private bootstrapTicking = false;
  private catalogTicking = false;
  private backgroundStarted = false;
  private maintenanceHold = false;

  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
    @Inject(PersonalInboxService)
    private readonly inbox: PersonalInboxService,
    @Inject(ChannelDriverRegistry)
    private readonly drivers: ChannelDriverRegistry,
    @Inject(KernelRuntimeService)
    private readonly kernelRuntime: KernelRuntimeService,
  ) {
    this.state = createConnectorState({
      runtime, inbox, drivers, kernelRuntime,
      maintenanceHeld: () => this.maintenanceHold,
      exclusiveStream: (installationId, streamKey, work, options) =>
        this.exclusiveStream(installationId, streamKey, work, options),
      publishStreams: () => this.publishStreams(),
      rememberStreamMeta: (key, stream) => this.rememberStreamMeta(key, stream),
      rememberStreamPace: (input) => this.rememberStreamPace(input),
      requireInstallation: (store, installationId) => this.requireInstallation(store, installationId),
      installSecrets: () => this.installSecrets(),
      catchUp: (installationId) => catchUp(this.state, installationId),
    });
  }

  private connectorState(): ConnectorState {
    return this.state;
  }

  startAfterListen(): void {
    if (this.backgroundStarted) {
      return;
    }
    this.backgroundStarted = true;
    markBackgroundListen();
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
    const bootstrapMs = bootstrapPullIntervalMs();
    if (bootstrapMs > 0) {
      this.bootstrapStartTimer = setTimeout(() => {
        this.bootstrapStartTimer = undefined;
        void this.bootstrapTick();
      }, START_PULL_DELAY_MS);
      this.bootstrapTimer = setInterval(() => {
        void this.bootstrapTick();
      }, bootstrapMs);
    }
    const catalogMs = catalogPullIntervalMs();
    if (catalogMs > 0) {
      this.catalogStartTimer = setTimeout(() => {
        this.catalogStartTimer = undefined;
        void this.catalogTick();
      }, START_PULL_DELAY_MS + catalogMs);
      this.catalogTimer = setInterval(() => {
        void this.catalogTick();
      }, catalogMs);
    }
  }

  /** Drop poll timers so this process can become a follower, then a leader again. */
  stopBackground(): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = undefined;
    }
    if (this.bootstrapStartTimer) {
      clearTimeout(this.bootstrapStartTimer);
      this.bootstrapStartTimer = undefined;
    }
    if (this.catalogStartTimer) {
      clearTimeout(this.catalogStartTimer);
      this.catalogStartTimer = undefined;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.bootstrapTimer) {
      clearInterval(this.bootstrapTimer);
      this.bootstrapTimer = undefined;
    }
    if (this.catalogTimer) {
      clearInterval(this.catalogTimer);
      this.catalogTimer = undefined;
    }
    this.backgroundStarted = false;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopBackground();
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

  async startSyncRun(
    installationId: string,
    input: StartSyncRunInput = {},
  ): Promise<SyncRun> {
    return connectorSyncRun.startSyncRun(this.connectorState(), installationId, input);
  }

  async listSyncRuns(
    installationId?: string,
    limit?: number,
  ): Promise<SyncRun[]> {
    return connectorSyncRun.listSyncRuns(this.connectorState(), installationId, limit);
  }

  async getSyncRun(runId: string): Promise<SyncRun> {
    return connectorSyncRun.getSyncRun(this.connectorState(), runId);
  }

  async commandSyncRun(
    runId: string,
    command: "pause" | "resume" | "cancel",
  ): Promise<SyncRun> {
    return connectorSyncRun.commandSyncRun(this.connectorState(), runId, command);
  }

  async listQuarantines(
    installationId: string,
  ): Promise<IngestQuarantine[]> {
    return connectorSyncRun.listQuarantines(this.connectorState(), installationId);
  }

  async retryQuarantines(
    installationId: string,
    quarantineId?: string,
  ): Promise<SyncRun> {
    return connectorSyncRun.retryQuarantines(this.connectorState(), installationId, quarantineId);
  }

  async ingestWebhook(
    installationId: string,
    request: WebhookRequest,
  ): Promise<ConnectorWebhookView> {
    return connectorWebhook.ingestWebhook(this.connectorState(), installationId, request);
  }

  async listEgressQueue(
    installationId: string,
    input: { apiKey?: string; origin?: string } = {},
  ): Promise<{ commands: ReturnType<NonNullable<ChannelDriver["listEgressQueue"]>> }> {
    return connectorEgress.listEgressQueue(this.connectorState(), installationId, input);
  }

  async ackEgressQueue(
    installationId: string,
    commandId: string,
    input: { apiKey?: string; origin?: string } = {},
  ): Promise<{ acknowledged: boolean }> {
    return connectorEgress.ackEgressQueue(this.connectorState(), installationId, commandId, input);
  }

  async followThread(
    installationId: string,
    thread: ConversationThread,
  ): Promise<void> {
    return connectorLive.followThread(this.connectorState(), installationId, thread);
  }

  async hydrateOpenedThread(threadId: string): Promise<void> {
    return connectorLive.hydrateOpenedThread(this.connectorState(), threadId);
  }

  async kickInteractiveLive(threadId: string): Promise<void> {
    return connectorLive.kickInteractiveLive(this.connectorState(), threadId);
  }

  noteInteractiveFocus(threadId: string): void {
    return connectorLive.noteInteractiveFocus(this.connectorState(), threadId);
  }

  async drainMediaForThread(threadId: string): Promise<void> {
    return connectorLive.drainMediaForThread(this.connectorState(), threadId);
  }

  async pullOlderForThread(
    threadId: string,
    anchor?: { before?: string; before_external_id?: string },
  ): Promise<{ history_pending: boolean }> {
    return connectorLive.pullOlderForThread(this.connectorState(), threadId, anchor);
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
    return connectorConversation.createConversation(this.connectorState(), input);
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
    return connectorConversation.openCreatedThread(this.connectorState(), input);
  }

  async install(input: ConnectorInstallInput): Promise<EngineInstallationView> {
    return connectorInstall.install(this.connectorState(), input);
  }

  async updateConfig(
    installationId: string,
    config: Record<string, unknown>,
  ): Promise<EngineInstallationView> {
    return connectorInstall.updateConfig(this.connectorState(), installationId, config);
  }

  async uninstall(installationId: string): Promise<{ id: string; removed: true }> {
    return connectorInstall.uninstall(this.connectorState(), installationId);
  }

  async setStatus(
    installationId: string,
    status: "enabled" | "disabled",
  ): Promise<EngineInstallationView> {
    return connectorInstall.setStatus(this.connectorState(), installationId, status);
  }

  async revealPairingCode(
    installationId: string,
  ): Promise<{ pairing_code: string }> {
    return connectorInstall.revealPairingCode(this.connectorState(), installationId);
  }

  private async waitForQuiet(timeoutMs = 10_000): Promise<void> {
    const started = Date.now();
    while (
      this.steadyTicking ||
      this.bootstrapTicking ||
      this.catalogTicking ||
      this.streamLocks.size > 0 ||
      this.state.focusSlot != null
    ) {
      if (Date.now() - started > timeoutMs) {
        throw storeBusyError();
      }
      await delay(50);
    }
  }

  private resetLivePullState(): void {
    const interval = pullStatus.interval_ms;
    if (this.state.focusSlot) {
      this.state.focusSlot.abort.abort();
      this.state.focusSlot = null;
    }
    this.streamIdleUntil.clear();
    this.state.streamCatchingUp.clear();
    this.streamSeeded.clear();
    this.state.streamMeta.clear();
    this.streamErrors.clear();
    this.state.streamPulling.clear();
    this.state.streamPullingHistory.clear();
    this.state.hydrateCooldown.clear();
    this.state.liveKickCooldown.clear();
    resetPullStatus();
    pullStatus.interval_ms = interval;
  }

  private async tick(): Promise<void> {
    if (
      this.maintenanceHold ||
      this.steadyTicking ||
      this.bootstrapTicking ||
      this.catalogTicking ||
      !this.runtime.isReady()
    ) {
      return;
    }
    if (
      !backgroundSyncReleased() ||
      this.kernelRuntime.shouldDeferBackgroundSync()
    ) {
      return;
    }
    this.steadyTicking = true;
    if (this.maintenanceHold) {
      this.steadyTicking = false;
      return;
    }
    try {
      const store = this.runtime.requireHost().get("authority");
      await runDueWorkPlane(this.connectorState(), store, {
        plane: "steady",
        lanes: [...steadySyncClaimLanes()],
        allowHistory: false,
      });
      pullStatus.last_tick_at = new Date().toISOString();
    } catch (error) {
      await applyPullOutcome([error]);
    } finally {
      this.steadyTicking = false;
    }
  }

  private async bootstrapTick(): Promise<void> {
    if (
      this.maintenanceHold ||
      this.bootstrapTicking ||
      this.steadyTicking ||
      this.catalogTicking ||
      !this.runtime.isReady()
    ) {
      return;
    }
    if (
      !shouldRunHistoryTick({
        backgroundReleased: backgroundSyncReleased(),
        deferHistory: this.kernelRuntime.shouldDeferHistorySync(),
        throttleHistory: this.kernelRuntime.pressureView().throttle_history,
      })
    ) {
      return;
    }
    this.bootstrapTicking = true;
    try {
      const store = this.runtime.requireHost().get("authority");
      await runDueWorkPlane(this.connectorState(), store, {
        plane: "bootstrap",
        lanes: [...historySyncClaimLanes()],
        allowHistory: true,
      });
    } catch (error) {
      await applyPullOutcome([error]);
    } finally {
      this.bootstrapTicking = false;
    }
  }

  /** Directory census only — never shares a tick with live/history/media. */
  private async catalogTick(): Promise<void> {
    if (
      this.maintenanceHold ||
      this.catalogTicking ||
      this.steadyTicking ||
      this.bootstrapTicking ||
      !this.runtime.isReady()
    ) {
      return;
    }
    if (
      !backgroundSyncReleased() ||
      this.kernelRuntime.shouldDeferHistorySync()
    ) {
      return;
    }
    this.catalogTicking = true;
    try {
      await runCatalogTick(this.connectorState());
    } catch (error) {
      await applyPullOutcome([error]);
    } finally {
      this.catalogTicking = false;
    }
  }

  async allowsBrowserLiveRequest(path: string, apiKey: string): Promise<boolean> {
    try {
      const host = this.runtime.requireHost();
      const store = host.get("authority");
      if (path === "/v1/me/engine") {
        const installations = await store.listInstallations(this.runtime.orgId());
        for (const installation of installations) {
          if (installation.status !== "enabled") {
            continue;
          }
          const driver = this.drivers.get(installation.connector_type);
          if (
            !driver?.authorizeLiveAccess ||
            !driver.capabilities(installation).browser_live
          ) {
            continue;
          }
          try {
            await driver.authorizeLiveAccess(installation, {
              apiKey,
              origin: "extension",
              env: process.env,
              secrets: asConnectorHost(host).secrets,
            });
            return true;
          } catch {
            continue;
          }
        }
        return false;
      }
      const match = /^\/v1\/me\/connectors\/([^/]+)\/(webhook|egress(?:\/[^/]+\/ack)?)$/.exec(path);
      if (!match) {
        return false;
      }
      const installation = await store.findInstallation(decodeURIComponent(match[1]));
      if (
        !installation ||
        installation.org_id !== this.runtime.orgId() ||
        installation.status !== "enabled"
      ) {
        return false;
      }
      const driver = this.drivers.get(installation.connector_type);
      if (
        !driver?.authorizeLiveAccess ||
        !driver.capabilities(installation).browser_live
      ) {
        return false;
      }
      await driver.authorizeLiveAccess(installation, {
        apiKey,
        origin: "extension",
        env: process.env,
        secrets: asConnectorHost(host).secrets,
      });
      return true;
    } catch {
      return false;
    }
  }

  private installSecrets() {
    return asConnectorHost(this.runtime.requireHost()).secrets;
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
      ...this.state.streamCatchingUp,
      ...this.streamSeeded,
      ...this.state.streamMeta.keys(),
      ...this.streamErrors.keys(),
      ...this.state.streamPulling,
      ...this.state.streamPullingHistory,
    ]) {
      if (key.startsWith(prefix) && !live.has(key)) {
        this.streamIdleUntil.delete(key);
        this.state.streamCatchingUp.delete(key);
        this.streamSeeded.delete(key);
        this.state.streamMeta.delete(key);
        this.streamErrors.delete(key);
        this.state.streamPulling.delete(key);
        this.state.streamPullingHistory.delete(key);
      }
    }
  }

  private rememberStreamMeta(key: string, stream: ConnectorStream): void {
    this.state.streamMeta.set(key, {
      thread_id: stream.thread_id ?? null,
      label: stream.label ?? null,
    });
  }

  private publishStreams(): void {
    const preferred = preferredThreadId();
    const keys = new Set([
      ...this.state.streamCatchingUp,
      ...this.state.streamPulling,
      ...this.streamErrors.keys(),
    ]);
    if (preferred) {
      for (const [key, meta] of this.state.streamMeta) {
        if (meta.thread_id === preferred) {
          keys.add(key);
        }
      }
    }
    const streams: PullStreamStatus[] = [...keys].map((key) => {
      const meta = this.state.streamMeta.get(key);
      const error = this.streamErrors.get(key) ?? null;
      const phase = this.state.streamPulling.has(key)
        ? "pulling"
        : error
          ? "error"
          : this.state.streamCatchingUp.has(key)
            ? "catching_up"
            : "idle";
      return {
        stream_key: key,
        thread_id: meta?.thread_id ?? null,
        label: this.streamDisplayLabel(meta?.thread_id ?? null, meta?.label ?? null),
        phase,
        work: this.state.streamPulling.has(key)
          ? this.state.streamPullingHistory.has(key)
            ? "history"
            : "live"
          : null,
        last_error: error,
      };
    });
    publishPullStreams(streams);
  }

  private streamDisplayLabel(
    threadId: string | null,
    label: string | null,
  ): string | null {
    if (label && !opaqueChatLabel(label, threadId)) {
      return label;
    }
    return null;
  }

  private rememberStreamPace(input: {
    key: string;
    pages: ConnectorPollRunResult[];
    pagesBudget: number;
    idleMs?: number;
    error?: unknown;
  }): void {
    const softMiss = input.error != null && isSyncSoftMiss(input.error);
    if (input.error && !softMiss) {
      this.streamErrors.set(input.key, errorMessage(input.error));
    } else {
      // Success or poll deadline: never sticky-alert a soft miss.
      this.streamErrors.delete(input.key);
    }
    if (input.pages.length === 0 && !input.error) {
      return;
    }
    this.streamSeeded.add(input.key);
    if (softMiss && input.pages.length === 0) {
      // Empty deadline: back off instead of sticky catch-up + error banner.
      this.state.streamCatchingUp.delete(input.key);
      if (input.idleMs !== undefined) {
        this.streamIdleUntil.set(input.key, Date.now() + input.idleMs);
      } else {
        this.streamIdleUntil.delete(input.key);
      }
      return;
    }
    const summary = summarizeRuns(input.pages);
    if (
      shouldKeepCatchingUp({
        pages: input.pages,
        pagesBudget: input.pagesBudget,
        acceptedCount: summary.accepted_count,
        quarantinedCount: summary.quarantined_count,
        error: softMiss ? undefined : input.error,
      })
    ) {
      this.state.streamCatchingUp.add(input.key);
      this.streamIdleUntil.delete(input.key);
      return;
    }
    this.state.streamCatchingUp.delete(input.key);
    if (input.idleMs !== undefined) {
      this.streamIdleUntil.set(input.key, Date.now() + input.idleMs);
      return;
    }
    this.streamIdleUntil.delete(input.key);
  }

  private isThreadStreamBusy(threadId: string): boolean {
    for (const [key, meta] of this.state.streamMeta) {
      if (meta.thread_id !== threadId) {
        continue;
      }
      if (this.state.streamPulling.has(key) || this.streamLocks.has(key)) {
        return true;
      }
    }
    return false;
  }

  private exclusiveStream<T>(
    installationId: string,
    streamKey: string,
    work: () => Promise<T>,
    options?: { skipIfBusy?: boolean; ahead?: boolean },
  ): Promise<T | undefined> {
    const lock = `${installationId}:${streamKey}`;
    if (options?.skipIfBusy && this.streamLocks.has(lock)) {
      return Promise.resolve(undefined);
    }
    const previous = options?.ahead
      ? Promise.resolve()
      : (this.streamLocks.get(lock) ?? Promise.resolve());
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

  private async reconcileCatchingUp(
    store: ConnectorRuntimeStore,
    installationId: string,
    streams: readonly ConnectorStream[],
  ): Promise<void> {
    const states = await store.listSyncPhaseHeads(installationId);
    const byKey = new Map(
      states.map((state) => [state.stream_key, state] as const),
    );
    const mounted = new Set(streams.map((stream) => stream.stream_key));
    const prefix = `${installationId}:`;
    for (const key of [...this.state.streamCatchingUp]) {
      if (!key.startsWith(prefix)) {
        continue;
      }
      if (this.state.streamPulling.has(key) || this.state.streamPullingHistory.has(key)) {
        continue;
      }
      const streamKey = key.slice(prefix.length);
      if (!mounted.has(streamKey)) {
        this.state.streamCatchingUp.delete(key);
        continue;
      }
      const state = byKey.get(streamKey);
      if (!state || state.phase === "unseeded" || state.phase === "history") {
        continue;
      }
      // Coverage already moved this stream to live/steady; drop the sticky
      // "还剩 N" chip instead of waiting for another empty tip poll.
      this.state.streamCatchingUp.delete(key);
    }
  }

  private async persistPickedChatNames(
    store: ConnectorRuntimeStore,
    installation: ConnectorInstallation,
    streams: ConnectorStream[],
  ): Promise<void> {
    const field = this.drivers
      .get(installation.connector_type)
      ?.installCatalog?.({ env: process.env })
      ?.fields?.find((item) => item.option_labels_key);
    const names = nextPickedChatNames(installation.config, streams, field);
    if (!names || !field?.option_labels_key) {
      return;
    }
    await store.updateInstallationConfig({
      id: installation.id,
      org_id: installation.org_id,
      config: {
        ...installation.config,
        [field.option_labels_key]: names,
      },
      updated_at: new Date().toISOString(),
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Connector pull failed";
}

function opaqueChatLabel(label: string, threadId: string | null): boolean {
  const trimmed = label.trim();
  if (/^oc_[0-9a-f]+$/i.test(trimmed)) {
    return true;
  }
  const key = threadId?.includes(":")
    ? threadId.slice(threadId.lastIndexOf(":") + 1)
    : threadId;
  return Boolean(key && trimmed === key);
}
