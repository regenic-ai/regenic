import { randomUUID } from "node:crypto";
import { Inject, Injectable, OnModuleDestroy } from "@nestjs/common";
import {
  ChannelDriverError,
  ChannelDriverRegistry,
  DEFAULT_COPY_LOCALE,
  type CopyLocale,
  ConnectorRunner,
  InProcessConnectorInvoker,
  readEnvCredential,
  DeadlineExceededError,
  isDeadlineExceeded,
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
  currentSyncLane,
  runInSyncLane,
  SyncEngine,
  applyKernelPressureToSyncBudget,
  buildSyncProgressSnapshot,
  loadSyncProgress,
  scopeSyncCatalogMembers,
  SyncLiveRing,
  steadyCapacityFromEnv,
  steadyLaneLimitsForCount,
  pacedStreamIdleMs,
  streamIdleTiersFromEnv,
  syncModeFromConfig,
  syncModePreset,
  syncPageOutcomeFromPollRuns,
  withDeadline,
  yieldToEventLoop,
  type ChannelDriver,
  type ConnectorInstallation,
  type ConnectorPollRunResult,
  type ConnectorRuntimeStore,
  type ConnectorStream,
  type ConnectorWebhookRunResult,
  type ConversationThread,
  type IngestQuarantine,
  CATALOG_RESCAN_MS,
  catalogDueWork,
  classifyDueWorkHeat,
  coldIdleMsForCatalogSize,
  conversationThreadFromStreamKey,
  DEFAULT_BOOTSTRAP_DUE_WORK_CLAIM_LIMIT,
  DEFAULT_DUE_WORK_CLAIM_LIMIT,
  DueWorkClaimLimiter,
  dueWorkCoverageLanes,
  dueWorkHasWritePressure,
  dueWorkIdleMs,
  firstSeedHeadFromEnv,
  looksLikeSyncPressure,
  MAX_DUE_WORK_CLAIM_LIMIT,
  MIN_DUE_WORK_CLAIM_LIMIT,
  needsCatalogDueWork,
  planDueSyncWork,
  processSyncMetrics,
  recordPollFreshness,
  recordWorkQueueLag,
  selectSyncRunWakeKeys,
  streamKeysForThreadIds,
  syncRunWorkLanes,
  syncRunWorkPlane,
  type DueWorkHeat,
  uncoveredCatalogMembers,
  type SyncCatalogMember,
  type SyncLane,
  type SyncRun,
  type SyncStreamState,
  type SyncWorkRecord,
  type SyncRunMode,
  type WebhookRequest,
} from "@regenic/domain";
import type { Host } from "@regenic/plugin-host";
import {
  connectorAllowsMultiple,
  catalogFromDrivers,
  nextPickedChatNames,
  toInstallationView,
  type EngineInstallationView,
} from "./personal-connector-view";
import { PersonalConnectorError, storeBusyError } from "./personal-errors";
import { PersonalInboxService } from "./personal-inbox.service";
import { KernelRuntimeService } from "./kernel-runtime.service";
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
  capSelectedStreams,
  catalogRefreshPages,
  IDLE_STREAM_CONCURRENCY,
  LIVE_STREAM_CONCURRENCY,
  shouldKeepCatchingUp,
  syncExecutionBudget,
} from "./personal-stream-pace";
import {
  backgroundSyncReleased,
  markBackgroundListen,
} from "./personal-interactive-gate";
import { loadEligibleInstallationThreads } from "./personal-eligible-threads";
import { PersonalRuntimeService } from "./personal-runtime.service";
import {
  shouldHydrateOpenedInbox,
} from "./personal-inbox-query";
import {
  shouldPullOlderFocus,
} from "./personal-conversation-focus";
import { catalogMembersFromStreams } from "./connector-sync-members";

export { PersonalConnectorError } from "./personal-errors";

const DEFAULT_MAX_PAGES = 1;
const MAX_PAGES_CAP = 5;
const HYDRATE_COOLDOWN_MS = 15_000;
const HYDRATE_WAIT_MS = 12_000;
const LIVE_KICK_COOLDOWN_MS = 3_000;
const LIVE_KICK_WAIT_MS = 12_000;
const FOLLOW_TRIES = 6;
const FOLLOW_WAIT_MS = 750;
const DEFAULT_PULL_MS = 10_000;
const DEFAULT_CATALOG_PULL_MS = 45_000;
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
  /** When set with capCatchUp, schedules only one sync plane. */
  syncPlane?: "bootstrap" | "steady";
  /** User-visible durable run; checked before each stream poll. */
  syncRunId?: string;
  streamKeys?: string[];
}

export interface StartSyncRunInput {
  mode?: SyncRunMode;
  max_pages?: number;
  stream_keys?: string[];
  archive_from?: string;
  archive_to?: string;
  run_window?: { start_hour: number; end_hour: number; timezone?: string };
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
  /** Per-installation plane key: `${id}:steady` / `${id}:bootstrap` / `${id}:all`. */
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
    kind: "hydrate" | "live" | "older" | "media" | "receipt";
    abort: AbortController;
    promise: Promise<void>;
  } | null = null;
  private focusGeneration = 0;
  private readonly hydrateCooldown = new Map<string, number>();
  private readonly liveKickCooldown = new Map<string, number>();
  private lastCatchUpCursor: string | undefined;
  private lastSeedCursor: string | undefined;
  private readonly liveRing = new SyncLiveRing();
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
  private readonly quota = new InstallationQuotaBook();
  private readonly creatingByClient = new Map<string, Promise<CreatedConversationView>>();
  private readonly dueWorkOwner = `personal-due:${randomUUID()}`;
  private readonly dueWorkLimiters = {
    steady: new DueWorkClaimLimiter(
      MIN_DUE_WORK_CLAIM_LIMIT,
      MAX_DUE_WORK_CLAIM_LIMIT,
      DEFAULT_DUE_WORK_CLAIM_LIMIT,
    ),
    bootstrap: new DueWorkClaimLimiter(
      MIN_DUE_WORK_CLAIM_LIMIT,
      MAX_DUE_WORK_CLAIM_LIMIT,
      DEFAULT_BOOTSTRAP_DUE_WORK_CLAIM_LIMIT,
    ),
  };
  private readonly catalogSizeByInstall = new Map<string, number>();

  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
    @Inject(PersonalInboxService)
    private readonly inbox: PersonalInboxService,
    @Inject(ChannelDriverRegistry)
    private readonly drivers: ChannelDriverRegistry,
    @Inject(KernelRuntimeService)
    private readonly kernelRuntime: KernelRuntimeService,
  ) {}

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
    const planeKey = syncInflightKey(installationId, options?.syncPlane);
    const existing = this.inflight.get(planeKey);
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
        this.inflight.delete(planeKey);
      });
    this.inflight.set(planeKey, job);
    return job;
  }

  async startSyncRun(
    installationId: string,
    input: StartSyncRunInput = {},
  ): Promise<SyncRun> {
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
    const mode = input.mode ?? "quick_start";
    const now = new Date().toISOString();
    const runId = randomUUID();
    const run = await store.createSyncRun({
      id: runId,
      org_id: installation.org_id,
      installation_id: installation.id,
      mode,
      options: {
        ...(input.max_pages === undefined
          ? {}
          : { max_pages: clampPages(input.max_pages) }),
        ...(input.stream_keys?.length
          ? { stream_keys: [...new Set(input.stream_keys)] }
          : {}),
        ...(input.archive_from ? { archive_from: input.archive_from } : {}),
        ...(input.archive_to ? { archive_to: input.archive_to } : {}),
        ...(input.run_window ? { run_window: input.run_window } : {}),
      },
      now,
    });
    await store.enqueueSyncWork({
      id: syncRunWorkId(run.id),
      run_id: run.id,
      installation_id: installation.id,
      stream_key: syncRunWorkStream(run.id),
      lane: mode === "archive" ? "history" : "live",
      next_due_at: now,
      generation: 1,
      now,
    });
    void this.executeDurableSyncRun(run.id).catch((error) => {
      console.error("durable connector sync failed", safeErrorCode(error));
    });
    return (await store.getSyncRun(run.id, installation.org_id)) ?? run;
  }

  async listSyncRuns(
    installationId?: string,
    limit?: number,
  ): Promise<SyncRun[]> {
    const store = this.runtime.requireHost().get("authority");
    return store.listSyncRuns({
      org_id: this.runtime.orgId(),
      ...(installationId ? { installation_id: installationId } : {}),
      ...(limit ? { limit } : {}),
    });
  }

  async getSyncRun(runId: string): Promise<SyncRun> {
    const run = await this.runtime
      .requireHost()
      .get("authority")
      .getSyncRun(runId, this.runtime.orgId());
    if (!run) {
      throw new PersonalConnectorError(
        "sync_failed",
        "Sync run was not found",
        404,
      );
    }
    return run;
  }

  async commandSyncRun(
    runId: string,
    command: "pause" | "resume" | "cancel",
  ): Promise<SyncRun> {
    const store = this.runtime.requireHost().get("authority");
    const run = await store.commandSyncRun({
      id: runId,
      org_id: this.runtime.orgId(),
      command,
      now: new Date().toISOString(),
    });
    if (!run) {
      throw new PersonalConnectorError(
        "sync_failed",
        "Sync run was not found",
        404,
      );
    }
    if (command === "resume") {
      void this.executeDurableSyncRun(run.id).catch((error) => {
        console.error("resumed connector sync failed", safeErrorCode(error));
      });
    }
    return run;
  }

  async listQuarantines(
    installationId: string,
  ): Promise<IngestQuarantine[]> {
    const store = this.runtime.requireHost().get("authority");
    await this.requireInstallation(store, installationId);
    return store.listQuarantines(installationId);
  }

  async retryQuarantines(
    installationId: string,
    quarantineId?: string,
  ): Promise<SyncRun> {
    const quarantines = await this.listQuarantines(installationId);
    const selected = quarantineId
      ? quarantines.filter((item) => item.id === quarantineId)
      : quarantines;
    if (selected.length === 0) {
      throw new PersonalConnectorError(
        "sync_failed",
        "No quarantined records were found",
        404,
      );
    }
    return this.startSyncRun(installationId, {
      mode: "quick_start",
      stream_keys: [...new Set(selected.map((item) => item.stream_key))],
    });
  }

  private async executeDurableSyncRun(runId: string): Promise<void> {
    const store = this.runtime.requireHost().get("authority");
    const run = await store.getSyncRun(runId, this.runtime.orgId());
    if (!run || (run.status !== "queued" && run.status !== "running")) {
      return;
    }
    const owner = `personal-sync-worker:${randomUUID()}`;
    const [work] = await store.claimSyncWork({
      owner,
      now: new Date().toISOString(),
      lease_ms: Math.max(LEASE_MS, connectorSyncTimeoutMs() * 2),
      limit: 1,
      work_id: syncRunWorkId(run.id),
    });
    if (!work) {
      return;
    }
    try {
      const result = dueWorkEnabled()
        ? await this.executeSyncRunDueWork(store, run)
        : await this.sync(
            run.installation_id,
            run.options.max_pages ?? DEFAULT_MAX_PAGES,
            {
              discover: true,
              capCatchUp: true,
              allowHistory: run.mode !== "continuous",
              syncPlane: run.mode === "continuous" ? "steady" : "bootstrap",
              syncRunId: run.id,
              streamKeys: run.options.stream_keys,
            },
          );
      const latest = await store.getSyncRun(run.id, run.org_id);
      if (latest?.status === "paused") {
        await store.settleSyncWork({
          id: work.id,
          owner,
          now: new Date().toISOString(),
          outcome: "retry",
          next_due_at: new Date().toISOString(),
        });
        return;
      }
      if (latest?.status === "cancelled") {
        return;
      }
      await store.settleSyncWork({
        id: work.id,
        owner,
        now: new Date().toISOString(),
        outcome: "succeeded",
        accepted_count: result.accepted_count,
      });
    } catch (error) {
      const now = new Date().toISOString();
      const latest = await store.getSyncRun(run.id, run.org_id);
      if (latest?.status === "paused") {
        await store.settleSyncWork({
          id: work.id,
          owner,
          now,
          outcome: "retry",
          next_due_at: now,
          error_code: "paused",
        });
        return;
      }
      if (latest?.status === "cancelled") {
        return;
      }
      await store.settleSyncWork({
        id: work.id,
        owner,
        now,
        outcome: "failed",
        error_code: safeErrorCode(error),
      });
      throw error;
    }
  }

  /**
   * User SyncRun claims indexed due-work. Stream rows stay unassigned so
   * background ticks keep the rest of the catalog; the blob kick row is the
   * run's one terminal item.
   */
  private async executeSyncRunDueWork(
    store: ConnectorRuntimeStore,
    run: SyncRun,
  ): Promise<{ accepted_count: number }> {
    const plane = syncRunWorkPlane(run.mode);
    const lanes = syncRunWorkLanes(run.mode);
    const allowHistory = run.mode === "archive";
    let catalog = await store.getSyncCatalog(run.installation_id);
    if (needsCatalogDueWork(catalog) || catalog.members.length === 0) {
      await this.discoverCatalogDueWork(store, run.installation_id, plane);
      catalog = await store.getSyncCatalog(run.installation_id);
    } else {
      await this.enqueueDueWorkFromCatalog(
        store,
        run.installation_id,
        plane,
        catalog.members,
      );
      if (plane === "bootstrap") {
        await this.enqueueDueWorkFromCatalog(
          store,
          run.installation_id,
          "steady",
          catalog.members,
        );
      }
    }
    const wakeKeys = selectSyncRunWakeKeys({
      mode: run.mode,
      members: catalog.members,
      preferredThreadId: preferredThreadId(),
      streamKeys: run.options.stream_keys,
      limit: firstSeedHeadFromEnv(),
    });
    if (wakeKeys.length > 0) {
      await store.wakeUnassignedSyncWork({
        installation_id: run.installation_id,
        stream_keys: wakeKeys,
        now: new Date().toISOString(),
      });
    }
    const latest = await store.getSyncRun(run.id, run.org_id);
    if (!latest || (latest.status !== "queued" && latest.status !== "running")) {
      return { accepted_count: 0 };
    }
    const leaseMs = Math.max(LEASE_MS, connectorSyncTimeoutMs() * 2);
    const limit = Math.min(
      MAX_DUE_WORK_CLAIM_LIMIT,
      Math.max(
        this.dueWorkClaimLimitFor(plane),
        wakeKeys.length + 1,
        firstSeedHeadFromEnv() + 2,
      ),
    );
    const claim = async (): Promise<SyncWorkRecord[]> =>
      store.claimSyncWork({
        owner: this.dueWorkOwner,
        now: new Date().toISOString(),
        lease_ms: leaseMs,
        limit,
        installation_id: run.installation_id,
        lanes,
        unassigned: true,
      });
    let claimed = await claim();
    let accepted = 0;
    if (claimed.length > 0) {
      recordClaimedWorkLag(claimed);
      const executed = await this.executeClaimedDueWork(store, claimed, {
        plane,
        allowHistory,
        syncRunId: run.id,
      });
      accepted += executed.accepted_count;
      if (claimed.some((item) => item.lane === "catalog")) {
        const followUp = await claim();
        if (followUp.length > 0) {
          recordClaimedWorkLag(followUp);
          accepted += (
            await this.executeClaimedDueWork(store, followUp, {
              plane,
              allowHistory,
              syncRunId: run.id,
            })
          ).accepted_count;
        }
      }
    } else if (wakeKeys.length > 0) {
      for (const streamKey of wakeKeys) {
        await this.exclusiveStream(
          run.installation_id,
          streamKey,
          async () => undefined,
          { skipIfBusy: false },
        );
      }
    }
    return { accepted_count: accepted };
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
        new InProcessConnectorInvoker(connector),
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
      if (summary.accepted_count > 0) {
        this.inbox.touchInboxDigest();
      }
      if (accepted.wake_thread_ids?.length) {
        await this.wakeStreamsForThreads(
          installation.id,
          accepted.wake_thread_ids,
        );
      }
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
    if (this.awaitExistingRecentFocus(id)) {
      try {
        await Promise.race([
          this.focusSlot!.promise,
          delay(HYDRATE_WAIT_MS),
        ]);
      } catch {
        return;
      }
      return;
    }
    if ((this.hydrateCooldown.get(id) ?? 0) > Date.now()) {
      return;
    }
    const job = this.takeFocus(id, "hydrate", (signal, generation) =>
      this.runRecentLiveForThread(id, signal, generation, {
        requireHydrateCapability: true,
        cooldownMs: HYDRATE_COOLDOWN_MS,
      }),
    );
    try {
      await Promise.race([job, delay(HYDRATE_WAIT_MS)]);
    } catch {
      return;
    }
  }

  /**
   * Open / live focus: immediately poll one recent page for the thread.
   * Works for any polling driver (not only hydrate_on_open).
   */
  async kickInteractiveLive(threadId: string): Promise<void> {
    if (this.maintenanceHold) {
      return;
    }
    const id = threadId.trim();
    if (!id) {
      return;
    }
    preferThread(id);
    if (this.awaitExistingRecentFocus(id)) {
      try {
        await Promise.race([
          this.focusSlot!.promise,
          delay(LIVE_KICK_WAIT_MS),
        ]);
      } catch {
        return;
      }
      return;
    }
    if ((this.liveKickCooldown.get(id) ?? 0) > Date.now()) {
      return;
    }
    const job = this.takeFocus(id, "live", (signal, generation) =>
      this.runRecentLiveForThread(id, signal, generation, {
        requireHydrateCapability: false,
        cooldownMs: LIVE_KICK_COOLDOWN_MS,
      }),
    );
    try {
      await Promise.race([job, delay(LIVE_KICK_WAIT_MS)]);
    } catch {
      return;
    }
  }

  private awaitExistingRecentFocus(threadId: string): boolean {
    return Boolean(
      this.focusSlot &&
        this.focusSlot.threadId === threadId &&
        (this.focusSlot.kind === "hydrate" || this.focusSlot.kind === "live") &&
        !this.focusSlot.abort.signal.aborted,
    );
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

  async drainMediaForThread(threadId: string): Promise<void> {
    if (this.maintenanceHold) {
      return;
    }
    const id = threadId.trim();
    if (!id) {
      return;
    }
    noteHumanActivity();
    preferThread(id);
    try {
      await this.takeFocus(id, "media", (signal, generation) =>
        this.runDrainMediaThread(id, signal, generation),
      );
    } catch {
      return;
    }
  }

  async pullOlderForThread(threadId: string): Promise<void> {
    if (this.maintenanceHold) {
      return;
    }
    const id = threadId.trim();
    if (!id || !shouldPullOlderFocus({ thread_id: id, pull_older: true, before: "1" })) {
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
    kind: "hydrate" | "live" | "older" | "media" | "receipt",
    work: (signal: AbortSignal, generation: number) => Promise<void>,
  ): Promise<void> {
    if (
      this.focusSlot &&
      this.focusSlot.threadId === threadId &&
      !this.focusSlot.abort.signal.aborted &&
      (this.focusSlot.kind === kind ||
        (isRecentFocusKind(kind) && isRecentFocusKind(this.focusSlot.kind)))
    ) {
      return this.focusSlot.promise;
    }
    // A receipt or media drain must not cancel the live page the click just started.
    if (
      this.focusSlot &&
      this.focusSlot.threadId === threadId &&
      !this.focusSlot.abort.signal.aborted &&
      isRecentFocusKind(this.focusSlot.kind) &&
      !isRecentFocusKind(kind)
    ) {
      preferThread(threadId);
      return work(this.focusSlot.abort.signal, this.focusSlot.generation);
    }
    if (this.focusSlot) {
      this.releaseLivePull(this.focusSlot.threadId);
      this.focusSlot.abort.abort();
      this.focusSlot = null;
    }
    preferThread(threadId);
    const generation = ++this.focusGeneration;
    const abort = new AbortController();
    this.focusSlot = {
      threadId,
      generation,
      kind,
      abort,
      promise: Promise.resolve(),
    };
    const promise = work(abort.signal, generation).finally(() => {
      if (this.focusSlot?.generation === generation) {
        this.focusSlot = null;
        this.publishStreams();
      }
    });
    this.focusSlot.promise = promise;
    if (isRecentFocusKind(kind)) {
      this.publishStreams();
    }
    return promise;
  }

  private focusAlive(generation: number, signal: AbortSignal): boolean {
    return !signal.aborted && this.focusSlot?.generation === generation;
  }

  private releaseLivePull(threadId: string): void {
    let released = false;
    for (const [key, meta] of this.streamMeta) {
      if (meta.thread_id === threadId && this.streamPulling.has(key) && !this.streamPullingHistory.has(key)) {
        this.streamPulling.delete(key);
        released = true;
      }
    }
    if (released) {
      this.publishStreams();
    }
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
                { older: true },
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
          idleMs: streamIdleMs(stream, installation.config),
        });
      } catch (error) {
        this.rememberStreamPace({
          key,
          pages: [],
          pagesBudget: 1,
          idleMs: streamIdleMs(stream, installation.config),
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

  private async runRecentLiveForThread(
    threadId: string,
    signal: AbortSignal,
    generation: number,
    options: {
      requireHydrateCapability: boolean;
      cooldownMs: number;
    },
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
    if (
      options.requireHydrateCapability &&
      !this.drivers.hydrateOnOpen(installations, thread)
    ) {
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
      if (!driverPolls(driver)) {
        continue;
      }
      if (
        options.requireHydrateCapability &&
        !driver.capabilities(installation).hydrate_on_open
      ) {
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
                { latest: true },
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
          idleMs: streamIdleMs(stream, installation.config),
        });
        if (pages.some((page) => page.status === "completed")) {
          this.hydrateCooldown.set(threadId, Date.now() + options.cooldownMs);
          this.liveKickCooldown.set(threadId, Date.now() + options.cooldownMs);
          this.inbox.publishThreadUpdated(threadId);
          this.inbox.touchInboxDigest();
        }
      } catch (error) {
        this.rememberStreamPace({
          key,
          pages: [],
          pagesBudget: 1,
          idleMs: streamIdleMs(stream, installation.config),
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

  private async runDrainMediaThread(
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
              pollStream(host, store, installation, stream, 3, { media: true }, this.quota),
            );
          },
          { skipIfBusy: false },
        );
        if (pages === undefined || !this.focusAlive(generation, signal)) {
          return;
        }
        const accepted = summarizeRuns(pages).accepted_count;
        this.rememberStreamPace({
          key,
          pages,
          pagesBudget: 3,
          idleMs: streamIdleMs(stream, installation.config),
        });
        if (accepted > 0) {
          this.inbox.publishThreadUpdated(threadId);
          this.inbox.touchInboxDigest();
        }
      } catch (error) {
        this.rememberStreamPace({
          key,
          pages: [],
          pagesBudget: 3,
          idleMs: streamIdleMs(stream, installation.config),
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
    this.kernelRuntime.clearInstallationSnapshots(current.id);
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
      this.steadyTicking ||
      this.bootstrapTicking ||
      this.catalogTicking ||
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
    this.liveKickCooldown.clear();
    this.lastCatchUpCursor = undefined;
    this.lastSeedCursor = undefined;
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
      if (dueWorkEnabled()) {
        await this.runDueWorkPlane(store, {
          plane: "steady",
          lanes: ["interactive", "live", "catalog", "media"],
          allowHistory: false,
        });
        pullStatus.last_tick_at = new Date().toISOString();
        return;
      }
      const installations = await store.listInstallations(this.runtime.orgId());
      const eligible = installations.filter((installation) => {
        const driver = this.drivers.get(installation.connector_type);
        return (
          installation.status === "enabled" &&
          driver &&
          driverPolls(driver) &&
          !this.inflight.has(syncInflightKey(installation.id, "steady"))
        );
      });
      const errors: unknown[] = [];
      await mapLimit(eligible, installationConcurrency(), async (installation) => {
        if (this.kernelRuntime.shouldDeferBackgroundSync()) {
          return;
        }
        try {
          await withDeadline(
            this.sync(installation.id, DEFAULT_MAX_PAGES, {
              skipIdle: true,
              capCatchUp: true,
              syncPlane: "steady",
              allowHistory: false,
            }),
            connectorSyncTimeoutMs(),
            `sync ${installation.connector_type}`,
          );
        } catch (error) {
          errors.push(error);
        }
        await yieldToEventLoop();
      });
      pullStatus.last_tick_at = new Date().toISOString();
      await applyPullOutcome(errors);
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
      !backgroundSyncReleased() ||
      !isHumanIdle() ||
      this.kernelRuntime.shouldDeferHistorySync() ||
      this.kernelRuntime.pressureView().throttle_history
    ) {
      return;
    }
    this.bootstrapTicking = true;
    try {
      const store = this.runtime.requireHost().get("authority");
      if (dueWorkEnabled()) {
        await this.runDueWorkPlane(store, {
          plane: "bootstrap",
          lanes: ["interactive", "live", "catalog", "history"],
          allowHistory: true,
        });
        return;
      }
      const installations = await store.listInstallations(this.runtime.orgId());
      const eligible = installations.filter((installation) => {
        const driver = this.drivers.get(installation.connector_type);
        return (
          installation.status === "enabled" &&
          driver &&
          driverPolls(driver) &&
          !this.inflight.has(syncInflightKey(installation.id, "bootstrap"))
        );
      });
      const errors: unknown[] = [];
      await mapLimit(eligible, installationConcurrency(), async (installation) => {
        if (this.kernelRuntime.shouldDeferHistorySync()) {
          return;
        }
        try {
          await withDeadline(
            this.sync(installation.id, DEFAULT_MAX_PAGES, {
              skipIdle: true,
              capCatchUp: true,
              syncPlane: "bootstrap",
              allowHistory: true,
            }),
            connectorSyncTimeoutMs(),
            `bootstrap ${installation.connector_type}`,
          );
        } catch (error) {
          errors.push(error);
        }
        await yieldToEventLoop();
      });
      await applyPullOutcome(errors);
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
      const host = this.runtime.requireHost();
      const store = host.get("authority");
      const installations = await store.listInstallations(this.runtime.orgId());
      const errors: unknown[] = [];
      await mapLimit(installations, installationConcurrency(), async (installation) => {
        if (this.kernelRuntime.shouldDeferHistorySync()) {
          return;
        }
        const driver = this.drivers.get(installation.connector_type);
        if (
          installation.status !== "enabled" ||
          !driver?.bindSyncSource ||
          !driverPolls(driver)
        ) {
          return;
        }
        try {
          const source = await driver.bindSyncSource(
            installation,
            asConnectorHost(host),
            process.env,
          );
          const engine = new SyncEngine(store);
          const view = await engine.refreshCatalog({
            installation_id: installation.id,
            source,
            pages: catalogRefreshPages({ catalogTick: true }),
            force: false,
          });
          if (dueWorkEnabled()) {
            await this.enqueueDueWorkFromCatalog(
              store,
              installation.id,
              "steady",
              view.members,
            );
            await this.enqueueDueWorkFromCatalog(
              store,
              installation.id,
              "bootstrap",
              view.members,
            );
          }
          void this.refreshSyncSnapshot(installation.id);
        } catch (error) {
          errors.push(error);
        }
        await yieldToEventLoop();
      });
      if (errors.length > 0) {
        await applyPullOutcome(errors);
      }
    } catch (error) {
      await applyPullOutcome([error]);
    } finally {
      this.catalogTicking = false;
    }
  }

  private async runDueWorkPlane(
    store: ConnectorRuntimeStore,
    input: {
      plane: "steady" | "bootstrap";
      lanes: SyncLane[];
      allowHistory: boolean;
      installationId?: string;
    },
  ): Promise<boolean> {
    const now = new Date().toISOString();
    const limit = this.dueWorkClaimLimitFor(input.plane);
    const claim = (at: string) =>
      store.claimSyncWork({
        owner: this.dueWorkOwner,
        now: at,
        lease_ms: Math.max(LEASE_MS, connectorSyncTimeoutMs() * 2),
        limit,
        lanes: input.lanes,
        unassigned: true,
        ...(input.installationId
          ? { installation_id: input.installationId }
          : {}),
      });
    let claimed = await claim(now);
    if (claimed.length === 0) {
      const planned = await this.planDueWorkForInstallations(
        store,
        input.plane,
        input.installationId,
      );
      if (planned === 0) {
        return false;
      }
      claimed = await claim(new Date().toISOString());
      if (claimed.length === 0) {
        return true;
      }
    }
    recordClaimedWorkLag(claimed);
    let pressure = (await this.executeClaimedDueWork(store, claimed, input))
      .pressure;
    if (claimed.some((item) => item.lane === "catalog")) {
      const followUp = await claim(new Date().toISOString());
      if (followUp.length > 0) {
        recordClaimedWorkLag(followUp);
        pressure =
          (await this.executeClaimedDueWork(store, followUp, input)).pressure ||
          pressure;
      }
    }
    this.observeDueWorkPressure(input.plane, pressure);
    return true;
  }

  private async planDueWorkForInstallations(
    store: ConnectorRuntimeStore,
    plane: "steady" | "bootstrap",
    installationId?: string,
  ): Promise<number> {
    const installations = (await store.listInstallations(this.runtime.orgId()))
      .filter((installation) =>
        installationId ? installation.id === installationId : true,
      );
    let planned = 0;
    const coverageLanes = dueWorkCoverageLanes(plane);
    for (const installation of installations) {
      const driver = this.drivers.get(installation.connector_type);
      if (
        installation.status !== "enabled" ||
        !driver ||
        !driverPolls(driver)
      ) {
        continue;
      }
      if (
        await store.hasUnassignedSyncWork({
          installation_id: installation.id,
          lanes: coverageLanes,
        })
      ) {
        continue;
      }
      const catalog = await store.getSyncCatalog(installation.id);
      if (needsCatalogDueWork(catalog)) {
        if (
          !(await store.hasUnassignedSyncWork({
            installation_id: installation.id,
            lanes: ["catalog"],
          }))
        ) {
          await store.enqueueSyncWork(
            catalogDueWork({
              installation_id: installation.id,
              now: new Date().toISOString(),
              generation: catalog.catalog?.generation ?? 1,
            }),
          );
          planned += 1;
        }
      }
      if (catalog.members.length === 0) {
        continue;
      }
      planned += await this.enqueueDueWorkFromCatalog(
        store,
        installation.id,
        plane,
        catalog.members,
      );
    }
    return planned;
  }

  private async enqueueDueWorkFromCatalog(
    store: ConnectorRuntimeStore,
    installationId: string,
    plane: "steady" | "bootstrap",
    members: readonly SyncCatalogMember[],
  ): Promise<number> {
    this.catalogSizeByInstall.set(installationId, members.length);
    const existing = await store.listUnassignedSyncWorkIdentities({
      installation_id: installationId,
    });
    const uncovered = uncoveredCatalogMembers(members, existing);
    if (uncovered.length === 0) {
      return 0;
    }
    const states = await this.loadStatesForMembers(
      store,
      installationId,
      uncovered,
      members.length,
    );
    const items = planDueSyncWork({
      installation_id: installationId,
      members: uncovered,
      states,
      now: new Date().toISOString(),
      plane,
      preferredThreadId: preferredThreadId(),
      catalogSize: members.length,
      coldIdleMs: streamIdleTiersFromEnv().coldIdleMs,
      firstSeedLimit: firstSeedHeadFromEnv(),
    });
    if (items.length === 0) {
      return 0;
    }
    return store.enqueueSyncWorkMany(items);
  }

  private async loadStatesForMembers(
    store: ConnectorRuntimeStore,
    installationId: string,
    uncovered: readonly SyncCatalogMember[],
    memberCount: number,
  ): Promise<Map<string, SyncStreamState>> {
    if (uncovered.length === 0) {
      return new Map();
    }
    if (uncovered.length < memberCount && uncovered.length <= 64) {
      const states = new Map<string, SyncStreamState>();
      for (const member of uncovered) {
        const state = await store.getSyncState(
          installationId,
          member.stream_key,
        );
        if (state) {
          states.set(member.stream_key, state);
        }
      }
      return states;
    }
    const listed = await store.listSyncStates(installationId);
    const wanted = new Set(uncovered.map((member) => member.stream_key));
    return new Map(
      listed
        .filter((state) => wanted.has(state.stream_key))
        .map((state) => [state.stream_key, state] as const),
    );
  }

  private async executeClaimedDueWork(
    store: ConnectorRuntimeStore,
    claimed: SyncWorkRecord[],
    input: {
      plane: "steady" | "bootstrap";
      allowHistory: boolean;
      syncRunId?: string;
    },
  ): Promise<{ pressure: boolean; accepted_count: number }> {
    const groups = new Map<string, SyncWorkRecord[]>();
    for (const work of claimed) {
      const group = groups.get(work.installation_id) ?? [];
      group.push(work);
      groups.set(work.installation_id, group);
    }
    const errors: unknown[] = [];
    let pressure = false;
    let acceptedCount = 0;
    await mapLimit([...groups.entries()], installationConcurrency(), async ([installationId, work]) => {
      const now = new Date().toISOString();
      const catalogWork = work.filter((item) => item.lane === "catalog");
      const streamWork = work.filter((item) => item.lane !== "catalog");
      try {
        if (catalogWork.length > 0) {
          await withDeadline(
            this.discoverCatalogDueWork(store, installationId, input.plane),
            connectorSyncTimeoutMs(),
            `due-work catalog ${installationId}`,
          );
          const settledAt = new Date().toISOString();
          const nextDue = new Date(Date.parse(settledAt) + CATALOG_RESCAN_MS).toISOString();
          for (const item of catalogWork) {
            await store.settleSyncWork({
              id: item.id,
              owner: this.dueWorkOwner,
              now: settledAt,
              outcome: "retry",
              next_due_at: nextDue,
            });
          }
        }
        if (streamWork.length === 0) {
          return;
        }
        const polled = await withDeadline(
          this.pollClaimedDueWorkStreams(
            store,
            installationId,
            streamWork,
            input,
          ),
          connectorSyncTimeoutMs(),
          `due-work ${input.plane} ${installationId}`,
        );
        if (polled.pressure) {
          pressure = true;
        }
        acceptedCount += polled.accepted;
      } catch (error) {
        errors.push(error);
        if (looksLikeSyncPressure(error)) {
          pressure = true;
        }
        for (const item of work) {
          await store.settleSyncWork({
            id: item.id,
            owner: this.dueWorkOwner,
            now,
            outcome: "retry",
            next_due_at: nextDueAfterFailure(item.attempts, now),
            error_code: safeErrorCode(error),
          });
        }
      }
      await yieldToEventLoop();
    });
    if (errors.length > 0) {
      await applyPullOutcome(errors);
    }
    return { pressure, accepted_count: acceptedCount };
  }

  /** Claimed stream work polls that stream only — never re-plans the installation. */
  private async pollClaimedDueWorkStreams(
    store: ConnectorRuntimeStore,
    installationId: string,
    streamWork: SyncWorkRecord[],
    input: {
      plane: "steady" | "bootstrap";
      allowHistory: boolean;
      syncRunId?: string;
    },
  ): Promise<{ pressure: boolean; accepted: number }> {
    const host = this.runtime.requireHost();
    const installation = await this.requireInstallation(store, installationId);
    const driver = this.drivers.get(installation.connector_type);
    if (!driver || !driverPolls(driver) || installation.status !== "enabled") {
      const now = new Date().toISOString();
      for (const item of streamWork) {
        await this.settleDueWork(store, item, {
          now,
          nextDueAt: nextDueAfterFailure(item.attempts, now),
          errorCode: "unsupported_connector",
        });
      }
      return { pressure: false, accepted: 0 };
    }
    const engine = new SyncEngine(store);
    const humanIdle = isHumanIdle();
    const kernelPressure = this.kernelRuntime.pressureView();
    const catalogSize = await this.catalogSizeFor(store, installation.id);
    const liveConcurrency = applyKernelPressureToSyncBudget(
      {
        pages: DEFAULT_MAX_PAGES,
        concurrency: syncExecutionBudget({
          humanIdle,
          capCatchUp: true,
          lane: "live",
          pages: DEFAULT_MAX_PAGES,
        }).concurrency,
        lane: "live",
      },
      kernelPressure.level,
    ).concurrency;
    const historyConcurrency = applyKernelPressureToSyncBudget(
      {
        pages: DEFAULT_MAX_PAGES,
        concurrency: syncExecutionBudget({
          humanIdle,
          capCatchUp: true,
          lane: "history",
          pages: DEFAULT_MAX_PAGES,
        }).concurrency,
        lane: "history",
      },
      kernelPressure.level,
    ).concurrency;
    const mediaConcurrency = applyKernelPressureToSyncBudget(
      {
        pages: DEFAULT_MAX_PAGES,
        concurrency: syncExecutionBudget({
          humanIdle,
          capCatchUp: true,
          lane: "media",
          pages: DEFAULT_MAX_PAGES,
        }).concurrency,
        lane: "media",
      },
      kernelPressure.level,
    ).concurrency;
    const liveItems = streamWork.filter(
      (item) => item.lane === "interactive" || item.lane === "live",
    );
    const historyItems = streamWork.filter((item) => item.lane === "history");
    const mediaItems = streamWork.filter((item) => item.lane === "media");
    let accepted = 0;
    let pages = 0;
    let claimPressure = false;
    beginPull();
    this.publishStreams();
    try {
      const pollItem = async (item: SyncWorkRecord): Promise<void> => {
        if (input.syncRunId) {
          const latest = await store.getSyncRun(
            input.syncRunId,
            installation.org_id,
          );
          if (
            !latest ||
            (latest.status !== "queued" && latest.status !== "running")
          ) {
            await this.settleDueWork(store, item, {
              now: new Date().toISOString(),
              nextDueAt: new Date().toISOString(),
            });
            return;
          }
        }
        if (this.maintenanceHold) {
          await this.settleDueWork(store, item, {
            now: new Date().toISOString(),
            nextDueAt: new Date().toISOString(),
          });
          return;
        }
        if (!input.allowHistory && item.lane === "history") {
          await this.settleDueWork(store, item, {
            now: new Date().toISOString(),
            nextDueAt: deferWrongPlaneDueAt(),
          });
          return;
        }
        if (item.lane === "media" && input.plane === "bootstrap") {
          await this.settleDueWork(store, item, {
            now: new Date().toISOString(),
            nextDueAt: deferWrongPlaneDueAt(),
          });
          return;
        }
        if (
          item.lane === "history" &&
          kernelPressure.throttle_history &&
          input.plane !== "bootstrap"
        ) {
          await this.settleDueWork(store, item, {
            now: new Date().toISOString(),
            nextDueAt: deferWrongPlaneDueAt(),
          });
          return;
        }
        if (
          item.lane === "media" &&
          (kernelPressure.throttle_media ||
            !humanIdle ||
            this.kernelRuntime.shouldDeferHistorySync())
        ) {
          await this.settleDueWork(store, item, {
            now: new Date().toISOString(),
            nextDueAt: deferWrongPlaneDueAt(),
          });
          return;
        }
        const thread = conversationThreadFromStreamKey(
          driver.source,
          item.stream_key,
        );
        if (!thread) {
          const now = new Date().toISOString();
          await this.settleDueWork(store, item, {
            now,
            nextDueAt: nextDueAfterFailure(item.attempts, now),
            errorCode: "invalid_config",
          });
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
          if (looksLikeSyncPressure(error)) {
            claimPressure = true;
          }
          const now = new Date().toISOString();
          await this.settleDueWork(store, item, {
            now,
            nextDueAt: nextDueAfterFailure(item.attempts, now),
            errorCode: safeErrorCode(error),
          });
          return;
        }
        const older = item.lane === "history";
        const media = item.lane === "media";
        const key = streamPaceKey(installation.id, stream.stream_key);
        const preferred = dueWorkStreamPreferred(item.lane, stream.thread_id);
        let idleMs = dueWorkStreamIdleMs(
          stream,
          installation.config,
          classifyDueWorkHeat({
            preferred,
            eager: older || media,
          }),
          catalogSize,
        );
        this.rememberStreamMeta(key, stream);
        this.streamPulling.add(key);
        if (older) {
          this.streamCatchingUp.add(key);
          this.streamPullingHistory.add(key);
        }
        this.publishStreams();
        try {
          const polled = await this.exclusiveStream(
            installation.id,
            stream.stream_key,
            () =>
              runInSyncLane(item.lane, () =>
                pollStream(
                  host,
                  store,
                  installation,
                  stream,
                  DEFAULT_MAX_PAGES,
                  { older, media },
                  this.quota,
                ),
              ),
            { skipIfBusy: item.lane !== "interactive" },
          );
          if (polled === undefined) {
            await this.settleDueWork(store, item, {
              now: new Date().toISOString(),
              nextDueAt: new Date().toISOString(),
            });
            return;
          }
          if (pollRunsHadPressure(polled)) {
            claimPressure = true;
          }
          const summary = summarizeRuns(polled);
          const hasMore = polled.some(
            (run) => "has_more" in run && run.has_more === true,
          );
          const heat = classifyDueWorkHeat({
            preferred,
            acceptedCount: summary.accepted_count,
            eager: older || media || hasMore,
          });
          idleMs = dueWorkStreamIdleMs(
            stream,
            installation.config,
            heat,
            catalogSize,
          );
          const result = {
            key,
            pages: polled,
            pagesBudget: DEFAULT_MAX_PAGES,
            idleMs,
            error: null as unknown,
          };
          this.rememberStreamPace(result);
          await rememberEngineResult(
            engine,
            installation.id,
            { stream, older, media, idleMs },
            result,
          );
          accepted += summary.accepted_count;
          pages += polled.length;
          if (summary.accepted_count > 0 && stream.thread_id) {
            this.inbox.publishThreadUpdated(stream.thread_id);
          }
          const settledAt = new Date().toISOString();
          const state = await store.getSyncState(
            installation.id,
            stream.stream_key,
          );
          const nextDueAt =
            state?.idle_until && state.idle_until > settledAt
              ? state.idle_until
              : settledAt;
          recordDueWorkFreshness({
            installationId: installation.id,
            lane: item.lane,
            heat,
            idleMs,
            settledAt,
            nextDueAt,
          });
          await this.settleDueWork(store, item, {
            now: settledAt,
            nextDueAt,
            acceptedCount: summary.accepted_count,
          });
        } catch (error) {
          if (looksLikeSyncPressure(error)) {
            claimPressure = true;
          }
          this.rememberStreamPace({
            key,
            pages: [],
            pagesBudget: DEFAULT_MAX_PAGES,
            idleMs,
            error,
          });
          await rememberEngineResult(
            engine,
            installation.id,
            { stream, older, media, idleMs },
            { pages: [], error },
          );
          const now = new Date().toISOString();
          await this.settleDueWork(store, item, {
            now,
            nextDueAt: nextDueAfterFailure(item.attempts, now),
            errorCode: safeErrorCode(error),
          });
        } finally {
          this.streamPulling.delete(key);
          this.streamPullingHistory.delete(key);
          this.publishStreams();
        }
      };
      await Promise.all([
        mapLimit(liveItems, Math.max(1, liveConcurrency), pollItem),
        mapLimit(historyItems, Math.max(1, historyConcurrency), pollItem),
      ]);
      await yieldToEventLoop();
      if (mediaConcurrency <= 0) {
        const deferredAt = deferWrongPlaneDueAt();
        for (const item of mediaItems) {
          await this.settleDueWork(store, item, {
            now: new Date().toISOString(),
            nextDueAt: deferredAt,
          });
        }
      } else {
        await mapLimit(mediaItems, mediaConcurrency, pollItem);
      }
      if (accepted > 0) {
        await this.inbox.publishInboxDigest();
      }
      void this.refreshSyncSnapshot(installation.id);
      return { pressure: claimPressure, accepted };
    } finally {
      finishPull({
        accepted,
        pages,
        catchingUp: this.streamCatchingUp.size,
      });
      this.publishStreams();
    }
  }

  private dueWorkClaimLimitFor(plane: "steady" | "bootstrap"): number {
    return this.dueWorkLimiters[plane].limit(dueWorkClaimLimit(plane));
  }

  private observeDueWorkPressure(
    plane: "steady" | "bootstrap",
    pressure: boolean,
  ): void {
    this.dueWorkLimiters[plane].observe(
      pressure || dueWorkHasWritePressure(processSyncMetrics.snapshot()),
      dueWorkClaimLimit(plane),
    );
  }

  private async catalogSizeFor(
    store: ConnectorRuntimeStore,
    installationId: string,
  ): Promise<number> {
    const cached = this.catalogSizeByInstall.get(installationId);
    if (cached != null) {
      return cached;
    }
    const catalog = await store.getSyncCatalog(installationId);
    this.catalogSizeByInstall.set(installationId, catalog.members.length);
    return catalog.members.length;
  }

  private async settleDueWork(
    store: ConnectorRuntimeStore,
    item: SyncWorkRecord,
    input: {
      now: string;
      nextDueAt: string;
      errorCode?: string;
      acceptedCount?: number;
    },
  ): Promise<void> {
    await store.settleSyncWork({
      id: item.id,
      owner: this.dueWorkOwner,
      now: input.now,
      outcome: "retry",
      next_due_at: input.nextDueAt,
      error_code: input.errorCode,
      accepted_count: input.acceptedCount,
    });
  }

  private async discoverCatalogDueWork(
    store: ConnectorRuntimeStore,
    installationId: string,
    plane: "steady" | "bootstrap",
  ): Promise<void> {
    const host = this.runtime.requireHost();
    const installation = await this.requireInstallation(store, installationId);
    const driver = this.drivers.get(installation.connector_type);
    if (!driver || !driverPolls(driver)) {
      return;
    }
    const engine = new SyncEngine(store);
    let members: readonly SyncCatalogMember[] = [];
    if (driver.bindSyncSource) {
      const source = await driver.bindSyncSource(
        installation,
        asConnectorHost(host),
        process.env,
      );
      const view = await engine.refreshCatalog({
        installation_id: installation.id,
        source,
        pages: catalogRefreshPages({ catalogTick: true }),
        force: plane === "bootstrap",
      });
      members = view.members;
    } else {
      const resolved = await driver.resolveStreams(
        installation,
        asConnectorHost(host),
        process.env,
        {
          threads: await loadEligibleInstallationThreads(
            host.get("authority"),
            installation.org_id,
            installation,
            driver,
            preferredThreadId(),
          ),
          catalog: [],
          discover: true,
        },
      );
      const fallbackMembers = catalogMembersFromStreams(installation.id, resolved);
      if (fallbackMembers.length > 0) {
        const view = await store.applySyncCatalogPage({
          installation_id: installation.id,
          members: fallbackMembers.map((member) => ({
            stream_key: member.stream_key,
            thread_id: member.thread_id,
            label: member.label,
            kind: member.kind,
          })),
          now: new Date().toISOString(),
          complete: true,
        });
        members = view.members;
      }
    }
    if (members.length === 0) {
      return;
    }
    await this.enqueueDueWorkFromCatalog(
      store,
      installation.id,
      "steady",
      members,
    );
    await this.enqueueDueWorkFromCatalog(
      store,
      installation.id,
      "bootstrap",
      members,
    );
  }

  private async catchUp(installationId: string): Promise<void> {
    try {
      if (dueWorkEnabled()) {
        await withDeadline(
          this.catchUpDueWork(installationId),
          connectorSyncTimeoutMs(),
          `catchUp ${installationId}`,
        );
        return;
      }
      await withDeadline(
        this.sync(installationId, DEFAULT_MAX_PAGES, {
          skipIdle: true,
          capCatchUp: true,
          syncPlane: "bootstrap",
          allowHistory: true,
          discover: true,
        }),
        connectorSyncTimeoutMs(),
        `catchUp ${installationId}`,
      );
    } catch (error) {
      await applyPullOutcome([error]);
    }
  }

  private async catchUpDueWork(installationId: string): Promise<void> {
    const store = this.runtime.requireHost().get("authority");
    await this.discoverCatalogDueWork(store, installationId, "bootstrap");
    await this.runDueWorkPlane(store, {
      plane: "bootstrap",
      lanes: syncRunWorkLanes("archive"),
      allowHistory: true,
      installationId,
    });
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
      const humanIdle = isHumanIdle();
      if (driver.bindSyncSource && options?.discover === true) {
        const source = await driver.bindSyncSource(
          installation,
          asConnectorHost(host),
          process.env,
        );
        await engine.refreshCatalog({
          installation_id: installation.id,
          source,
          pages: catalogRefreshPages({ discover: true }),
          force: true,
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
      const resolvedStreams = await driver.resolveStreams(
        installation,
        asConnectorHost(host),
        process.env,
        {
          threads,
          catalog: catalog.members,
          discover: !driver.bindSyncSource && options?.discover === true,
        },
      );
      const requestedStreamKeys = options?.streamKeys?.length
        ? new Set(options.streamKeys)
        : null;
      const streams = requestedStreamKeys
        ? resolvedStreams.filter((stream) =>
            requestedStreamKeys.has(stream.stream_key),
          )
        : resolvedStreams;
      await this.persistPickedChatNames(store, installation, streams);
      this.pruneStreamPace(installation.id, streams);
      const storedStates = await store.listSyncStates(installation.id);
      const stateByKey = new Map(
        storedStates.map((state) => [state.stream_key, state] as const),
      );
      const cursorStates = new Map<string, string | undefined>();
      const cursorKeys = streams
        .map((stream) => stream.stream_key)
        .filter((streamKey) => {
          const state = stateByKey.get(streamKey);
          return !state || state.phase === "live" || state.phase === "steady";
        });
      const cursors = await store.listCursors(installation.id, cursorKeys);
      const storedCursorByKey = new Map(
        cursors.map((cursor) => [cursor.stream_key, cursor.cursor] as const),
      );
      for (const streamKey of cursorKeys) {
        cursorStates.set(streamKey, storedCursorByKey.get(streamKey));
      }
      const fallbackMembers = catalogMembersFromStreams(installation.id, streams);
      const mountedStreamKeys = new Set(streams.map((stream) => stream.stream_key));
      const planMembers = scopeSyncCatalogMembers(
        catalog.members,
        mountedStreamKeys,
        fallbackMembers,
      );
      const catalogIncomplete = catalog.catalog ? !catalog.catalog.complete : true;
      const steadyEnv = steadyCapacityFromEnv();
      const planInput = {
        installation_id: installation.id,
        preferredThreadId: preferredThreadId(),
        humanIdle,
        rotateFrom: this.lastCatchUpCursor,
        rotateSeedFrom: this.lastSeedCursor,
        pages: options?.capCatchUp ? DEFAULT_MAX_PAGES : maxPages,
        members: planMembers,
        fallbackMembers,
        cursorStates,
      };
      const liveCap = humanIdle
        ? IDLE_STREAM_CONCURRENCY
        : LIVE_STREAM_CONCURRENCY;
      const splitPlan =
        options?.capCatchUp || options?.syncPlane
          ? await engine.planSplit({
              ...planInput,
              liveRing: this.liveRing,
              bootstrapLimits: options?.discover
                ? {
                    interactive: 1,
                    live: 16,
                    catalog: 0,
                    history: 16,
                    media: 0,
                  }
                : {
                    interactive: 1,
                    live: humanIdle ? liveCap : 0,
                    catalog: 0,
                    history: 1,
                    media: 0,
                  },
              steadyLimits: {
                ...steadyLaneLimitsForCount({
                  members: planMembers,
                  states: stateByKey,
                  tickIntervalMs: pullIntervalMs(),
                  catalogIncomplete,
                  targetIdleMs: steadyEnv.targetIdleMs,
                  maxLive: liveCap,
                }),
                catalog: 0,
                media:
                  options?.syncPlane === "bootstrap"
                    ? 0
                    : 1,
              },
            })
          : null;
      const work = splitPlan
        ? options?.syncPlane === "bootstrap"
          ? splitPlan.bootstrap
          : options?.syncPlane === "steady"
            ? splitPlan.steady
            : splitPlan.all
        : await engine.plan(planInput);
      const streamByKey = new Map(
        streams.map((stream) => [stream.stream_key, stream] as const),
      );
      const pressure = this.kernelRuntime.pressureView();
      const allowBackgroundMedia =
        options?.syncPlane !== "bootstrap" &&
        humanIdle &&
        pressure.interactive_ready &&
        !pressure.throttle_media &&
        !this.kernelRuntime.shouldDeferHistorySync();
      const uncapped = work.flatMap((item) => {
        if (item.lane === "catalog") {
          return [];
        }
        const stream = streamByKey.get(item.stream_key);
        if (!stream) {
          return [];
        }
        if (!allowHistory && (item.older || item.lane === "history")) {
          return [];
        }
        if (pressure.throttle_history && (item.older || item.lane === "history")) {
          if (options?.syncPlane !== "bootstrap") {
            return [];
          }
        }
        if ((item.media || item.lane === "media") && !allowBackgroundMedia) {
          return [];
        }
        if (pressure.throttle_media && item.media) {
          return [];
        }
        const key = streamPaceKey(installation.id, stream.stream_key);
        this.rememberStreamMeta(key, stream);
        const budget = syncExecutionBudget({
          humanIdle,
          capCatchUp: options?.capCatchUp,
          lane: item.lane,
          pages: item.pages,
          catchUpPages: streamCatchUpPages(stream, item.pages),
        });
        const throttled = applyKernelPressureToSyncBudget(
          {
            pages: budget.pages,
            concurrency: budget.concurrency,
            lane: item.lane,
          },
          pressure.level,
        );
        if (throttled.concurrency <= 0) {
          return [];
        }
        return [
          {
            stream,
            key,
            idleMs: streamIdleMs(stream, installation.config),
            older: item.older,
            pages: throttled.pages,
            lane: item.lane,
            media: item.media,
          },
        ];
      });
      const selected = capSelectedStreams(uncapped, {
        liveLimit: options?.discover ? 16 : liveCap,
        historyLimit: options?.discover
          ? 16
          : allowHistory && !pressure.throttle_history
            ? 1
            : 0,
        mediaLimit: allowBackgroundMedia ? 1 : 0,
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
        if (item.older || item.lane === "history") {
          this.streamCatchingUp.add(item.key);
        }
        if (item.older) {
          this.streamPullingHistory.add(item.key);
        }
      }
      this.publishStreams();
      const textItems = selected.filter((item) => !item.media);
      const liveTextItems = textItems.filter(
        (item) => !item.older && item.lane !== "history",
      );
      const historyTextItems = textItems.filter(
        (item) => item.older || item.lane === "history",
      );
      // Media never shares a tick with history catch-up; focus drain covers open threads.
      const mediaItems =
        historyTextItems.length > 0
          ? []
          : selected.filter((item) => item.media);
      const liveConcurrency = syncExecutionBudget({
        humanIdle,
        capCatchUp: options?.capCatchUp,
        lane: "live",
        pages: 1,
      }).concurrency;
      const historyConcurrency = syncExecutionBudget({
        humanIdle,
        capCatchUp: options?.capCatchUp,
        lane: "history",
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
          if (options?.syncRunId) {
            await assertSyncRunActive(
              store,
              options.syncRunId,
              installation.org_id,
            );
          }
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
      // Live and history use separate concurrency budgets so catch-up does not
      // throttle watermark pulls (and vice versa when both planes run).
      const [liveBatches, historyBatches] = await Promise.all([
        mapLimit(liveTextItems, liveConcurrency, runSelected),
        mapLimit(historyTextItems, historyConcurrency, runSelected),
      ]);
      await yieldToEventLoop();
      const mediaBatches = await mapLimit(mediaItems, mediaConcurrency, runSelected);
      const batches = [...liveBatches, ...historyBatches, ...mediaBatches];
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
        await this.inbox.publishInboxDigest();
        const notifyAccepted = (
          items: Array<{ stream: ConnectorStream }>,
          batches: Array<{ pages: ConnectorPollRunResult[] }>,
        ) => {
          for (let index = 0; index < items.length; index += 1) {
            const threadId = items[index]?.stream.thread_id;
            const batch = batches[index];
            if (
              !threadId ||
              !batch ||
              summarizeRuns(batch.pages).accepted_count === 0
            ) {
              continue;
            }
            this.inbox.publishThreadUpdated(threadId);
          }
        };
        notifyAccepted(liveTextItems, liveBatches);
        notifyAccepted(historyTextItems, historyBatches);
        notifyAccepted(mediaItems, mediaBatches);
      }
      this.publishStreams();
      void this.refreshSyncSnapshot(installation.id, streams);
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

  private async refreshSyncSnapshot(
    installationId: string,
    _streams?: readonly ConnectorStream[],
  ): Promise<void> {
    try {
      const store = this.runtime.requireHost().get("authority");
      const [catalog, states, attempt] = await Promise.all([
        store.getSyncCatalog(installationId),
        store.listSyncStates(installationId),
        store.latestAttempt(installationId),
      ]);
      const snapshot = buildSyncProgressSnapshot({
        installation_id: installationId,
        members: catalog.members,
        states,
        catalog_complete: catalog.catalog?.complete === true,
      });
      if (snapshot) {
        this.kernelRuntime.publishSyncSnapshot(snapshot);
      }
      if (attempt) {
        this.kernelRuntime.publishInstallAttempt(installationId, attempt);
      }
    } catch (error) {
      console.warn("sync progress snapshot refresh failed", error);
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
      });
      return true;
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
    const driver = this.drivers.get(installation.connector_type);
    if (
      !driver?.readPairingCode ||
      !driver.capabilities(installation).pairing_code
    ) {
      return Promise.resolve(undefined);
    }
    return driver.readPairingCode(installation);
  }

  private async assertInstallSecret(
    installation: ConnectorInstallation,
    input: { apiKey?: string; origin?: string },
  ): Promise<void> {
    const driver = this.drivers.get(installation.connector_type);
    if (
      driver?.authorizeLiveAccess &&
      driver.capabilities(installation).browser_live
    ) {
      try {
        await driver.authorizeLiveAccess(installation, {
          apiKey: input.apiKey,
          origin: input.origin,
          env: process.env,
        });
      } catch (error) {
        if (
          error instanceof ChannelDriverError &&
          error.code === "missing_credentials"
        ) {
          throw new PersonalConnectorError("unauthorized", error.message, 401);
        }
        throw wrapDriverError(error, "invalid_config");
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

  private async wakeStreamsForThreads(
    installationId: string,
    threadIds: readonly string[],
  ): Promise<void> {
    const streamKeys = streamKeysForThreadIds(threadIds);
    if (streamKeys.length === 0) {
      return;
    }
    const now = new Date().toISOString();
    await this.runtime.requireHost().get("authority").wakeUnassignedSyncWork({
      installation_id: installationId,
      stream_keys: streamKeys,
      now,
    });
    for (const streamKey of streamKeys) {
      this.liveRing.nudge(streamKey);
    }
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
        label: this.streamDisplayLabel(meta?.thread_id ?? null, meta?.label ?? null),
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
    const softMiss = input.error != null && isDeadlineExceeded(input.error);
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
      this.streamCatchingUp.delete(input.key);
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

  private async viewOf(
    store: ConnectorRuntimeStore,
    installation: ConnectorInstallation,
  ): Promise<EngineInstallationView> {
    const host = this.runtime.requireHost();
    const streams = host.get("connectors").listStreams(installation.id);
    const fallbackMembers = catalogMembersFromStreams(installation.id, streams);
    const [attempt, sync] = await Promise.all([
      store.latestAttempt(installation.id),
      loadSyncProgress(store, installation.id, {
        mountedStreamKeys: new Set(streams.map((stream) => stream.stream_key)),
        fallbackMembers,
      }),
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
    const code = error.reason ?? error.code;
    return new PersonalConnectorError(
      code,
      error.message,
      httpStatusFor(code),
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
    case "channel_required":
    case "conversation_required":
    case "kinds_required":
      return 400;
    case "already_installed":
      return 409;
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
  options?: { older?: boolean; latest?: boolean; media?: boolean },
  quota?: InstallationQuotaBook,
): Promise<ConnectorPollRunResult[]> {
  const runner = new ConnectorRunner(
    new InProcessConnectorInvoker(stream.connector),
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
      latest: options?.latest === true,
      media: options?.media,
      timeout_ms: connectorPollTimeoutMs(),
    });
    runs.push(run);
    if (run.status === "lease_unavailable") {
      if (currentSyncLane() === "interactive") {
        // Same-stream history may hold the lease; retry on the next focus/tick.
        break;
      }
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
    await yieldToEventLoop();
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

function bootstrapPullIntervalMs(): number {
  const raw = Number(process.env.REGENIC_BOOTSTRAP_PULL_MS ?? 1_500);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.max(500, Math.min(raw, 30_000));
}

function catalogPullIntervalMs(): number {
  const raw = Number(process.env.REGENIC_CATALOG_PULL_MS ?? DEFAULT_CATALOG_PULL_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.max(15_000, Math.min(raw, 120_000));
}

function dueWorkEnabled(): boolean {
  const raw = process.env.REGENIC_SYNC_DUE_WORK?.trim().toLowerCase();
  return raw !== "0" && raw !== "false";
}

function dueWorkClaimLimit(plane: "steady" | "bootstrap"): number {
  const fallback = plane === "bootstrap" ? 16 : 32;
  const raw = Number(
    process.env.REGENIC_SYNC_DUE_WORK_LIMIT ?? fallback,
  );
  if (!Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(1, Math.min(128, Math.floor(raw)));
}

function recordClaimedWorkLag(claimed: readonly SyncWorkRecord[]): void {
  for (const item of claimed) {
    recordWorkQueueLag(processSyncMetrics, item.next_due_at, {
      installation_id: item.installation_id,
      lane: item.lane,
    });
  }
}

function deferWrongPlaneDueAt(nowMs = Date.now()): string {
  return new Date(nowMs + 60_000).toISOString();
}

function nextDueAfterFailure(attempts: number, now: string): string {
  const delay = Math.min(300_000, 5_000 * 2 ** Math.min(Math.max(attempts, 1), 6));
  return new Date(Date.parse(now) + delay).toISOString();
}

function installationConcurrency(): number {
  const raw = Number(process.env.REGENIC_INSTALLATION_SYNC_CONCURRENCY ?? 4);
  if (!Number.isFinite(raw)) {
    return 4;
  }
  return Math.max(1, Math.min(16, Math.floor(raw)));
}

function syncInflightKey(
  installationId: string,
  syncPlane?: "bootstrap" | "steady",
): string {
  return `${installationId}:${syncPlane ?? "all"}`;
}

function syncRunWorkId(runId: string): string {
  return `sync-run:${runId}`;
}

function syncRunWorkStream(runId: string): string {
  return `__sync_run__:${runId}`;
}

async function assertSyncRunActive(
  store: ConnectorRuntimeStore,
  runId: string,
  orgId: string,
): Promise<void> {
  const run = await store.getSyncRun(runId, orgId);
  if (!run || (run.status !== "queued" && run.status !== "running")) {
    throw new Error(`Sync run is ${run?.status ?? "missing"}`);
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof ChannelDriverError) {
    return error.code;
  }
  if (error instanceof Error) {
    return (
      error.name
        .replace(/Error$/, "")
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .toLowerCase() || "sync_failed"
    );
  }
  return "sync_failed";
}

function isRecentFocusKind(
  kind: "hydrate" | "live" | "older" | "media" | "receipt",
): boolean {
  return kind === "hydrate" || kind === "live";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function streamPaceKey(installationId: string, streamKey: string): string {
  return `${installationId}:${streamKey}`;
}

/** Prefer connector pace or sync_mode; omit idle when neither is set (DSH). */
function streamIdleMs(
  stream: ConnectorStream,
  config?: Record<string, unknown>,
): number | undefined {
  const value = stream.pace?.idle_ms;
  const hintMs =
    Number.isInteger(value) && value !== undefined && value >= 1
      ? value
      : undefined;
  const mode = syncModeFromConfig(config);
  // No pace.idle_ms and no sync_mode → every tick (unchanged for DSH).
  if (hintMs === undefined && mode == null) {
    return undefined;
  }
  const preferred = preferredThreadId();
  const active = Boolean(
    preferred && stream.thread_id && stream.thread_id === preferred,
  );
  const tiers =
    mode != null ? syncModePreset(mode) : streamIdleTiersFromEnv();
  return pacedStreamIdleMs({
    active,
    hintMs,
    activeIdleMs: tiers.activeIdleMs,
    inactiveIdleMs: tiers.inactiveIdleMs,
  });
}

function dueWorkStreamPreferred(
  lane: SyncLane,
  threadId?: string | null,
): boolean {
  if (lane === "interactive") {
    return true;
  }
  const preferred = preferredThreadId();
  return Boolean(preferred && threadId && threadId === preferred);
}

function dueWorkStreamIdleMs(
  stream: ConnectorStream,
  config: Record<string, unknown> | undefined,
  heat: DueWorkHeat,
  catalogSize: number,
): number | undefined {
  const value = stream.pace?.idle_ms;
  const hintMs =
    Number.isInteger(value) && value !== undefined && value >= 1
      ? value
      : undefined;
  const mode = syncModeFromConfig(config);
  if (hintMs === undefined && mode == null) {
    return undefined;
  }
  const envTiers = streamIdleTiersFromEnv();
  const modeTiers = mode != null ? syncModePreset(mode) : null;
  return dueWorkIdleMs({
    heat,
    hintMs,
    activeIdleMs: modeTiers?.activeIdleMs ?? envTiers.activeIdleMs,
    hotIdleMs: envTiers.hotIdleMs,
    coldIdleMs: coldIdleMsForCatalogSize(catalogSize, envTiers.coldIdleMs),
  });
}

function pollRunsHadPressure(runs: ConnectorPollRunResult[]): boolean {
  return runs.some((run) => run.status === "throttled");
}

function recordDueWorkFreshness(input: {
  installationId: string;
  lane: SyncLane;
  heat: DueWorkHeat;
  idleMs?: number;
  settledAt: string;
  nextDueAt: string;
}): void {
  if (input.idleMs == null) {
    return;
  }
  const until = Date.parse(input.nextDueAt);
  const settled = Date.parse(input.settledAt);
  const freshnessMs =
    Number.isFinite(until) && Number.isFinite(settled)
      ? Math.max(0, until - settled)
      : input.idleMs;
  recordPollFreshness(processSyncMetrics, freshnessMs, {
    installation_id: input.installationId,
    lane: input.lane,
    status: input.heat,
  });
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

function threadsFromCatalog(
  members: readonly SyncCatalogMember[],
  source: string,
): ConversationThread[] {
  return members.flatMap((member) => {
    const thread = conversationThreadFromStreamKey(
      source,
      member.stream_key,
      member.thread_id,
    );
    return thread ? [thread] : [];
  });
}

async function rememberEngineResult(
  engine: SyncEngine,
  installationId: string,
  item: { stream: ConnectorStream; older: boolean; media: boolean; idleMs?: number },
  result: { pages: ConnectorPollRunResult[]; error?: unknown },
): Promise<void> {
  await engine.rememberResult(
    syncPageOutcomeFromPollRuns(
      installationId,
      {
        stream: item.stream,
        work: { older: item.older, media: item.media },
        idleMs: item.idleMs,
      },
      result,
      new Date().toISOString(),
    ),
  );
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

