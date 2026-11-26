import {
  DeadlineExceededError,
  isBlobReservationConflict,
  asConnectorHost,
  connectorSyncTimeoutMs,
  driverPolls,
  fairSelectSyncWork,
  runInSyncLane,
  SyncEngine,
  buildSyncProgressSnapshot,
  streamIdleTiersFromEnv,
  syncOutcomeForPoll,
  withDeadline,
  yieldToEventLoop,
  type ConnectorPollRunResult,
  type ConnectorRuntimeStore,
  type ConnectorStream,
  CATALOG_RESCAN_MS,
  catalogDueWork,
  classifyDueWorkHeat,
  coldIdleMsForCatalogSize,
  threadForSyncStream,
  dueWorkCoverageLanes,
  firstSeedHeadFromEnv,
  looksLikeSyncPressure,
  needsCatalogDueWork,
  historyPolicyFromConfig,
  historySyncClaimLanes,
  messageDuty,
  nextDueAfterPoll,
  planSyncWorkGaps,
  sameLaneContinues,
  shouldReleaseInteractiveWork,
  threadIdOf,
  type SyncLane,
  type SyncPhase,
  type SyncWorkRecord,
  type KernelPressureView,
} from "@regenic/domain";
import {
  applyPullOutcome,
  beginPull,
  finishPull,
  preferredThreadId,
} from "./personal-pull-status";
import {
  isHumanIdle,
} from "./personal-human-pace";
import {
  catalogRefreshPages,
} from "./personal-stream-pace";

import { loadEligibleInstallationThreads } from "./personal-eligible-threads";

import { catalogMembersFromStreams } from "./connector-sync-members";

import type { ConnectorDueWorkState as ConnectorState } from "./personal-connector-state";
import type { PersonalSyncSettings } from "./personal-sync-settings";
import { ensureConnectorLivePush, reconcilePush } from "./personal-connector-push";
import {
  pollStream,
  mapLimit,
  safeErrorCode,
  summarizeRuns,
  DEFAULT_MAX_PAGES,
} from "./personal-connector-poll";
import {
  dueWorkBatchTimeoutMs,
  dueWorkClaimLeaseMs,
  dueWorkConcurrency,
  recordClaimedWorkLag,
  deferWrongPlaneDueAt,
  nextDueAfterBlobContention,
  nextDueAfterFailure,
  installationConcurrency,
  streamPaceKey,
  dueWorkStreamPreferred,
  dueWorkStreamIdleMs,
  recordDueWorkFreshness,
  dueWorkClaimLimitFor,
  observeDueWorkPressure,
} from "./personal-connector-rhythm";

export async function runDueWorkPlane(
  state: ConnectorState,
  store: ConnectorRuntimeStore,
  input: {
    plane: "steady" | "bootstrap";
    lanes: SyncLane[];
    allowHistory: boolean;
    installationId?: string;
  },
): Promise<boolean> {
  await state.refreshSyncSettings();
  const settings = state.syncSettings;
  const now = new Date().toISOString();
  const limit = dueWorkClaimLimitFor(state.dueWorkLimiters, input.plane, settings);
  if (input.allowHistory && state.pushGate.pressured()) {
    return false;
  }
  const historyClaim = input.plane === "bootstrap" || input.lanes.includes("history");
  const claimLimit = historyClaim ? Math.min(limit * 2, 128) : limit;
  const claim = (at: string, size = claimLimit) =>
    store.claimSyncWork({
      owner: state.dueWorkOwner,
      now: at,
      lease_ms: dueWorkClaimLeaseMs(size, settings),
      limit: size,
      lanes: input.lanes,
      unassigned: true,
      ...(input.installationId
        ? { installation_id: input.installationId }
        : {}),
    });
  let claimed = await claim(now);
  if (claimed.length === 0) {
    const planned = await planDueWorkForInstallations(state, 
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
  if (historyClaim && claimed.length > limit) {
    const fair = fairSelectSyncWork(claimed, limit);
    const keepIds = new Set(fair.map((item) => item.id));
    const releasedAt = new Date().toISOString();
    for (const item of claimed) {
      if (keepIds.has(item.id)) continue;
      await settleDueWork(state, store, item, {
        now: releasedAt,
        nextDueAt: releasedAt,
      });
    }
    claimed = fair;
  }
  recordClaimedWorkLag(claimed);
  let pressure = (await executeClaimedDueWork(state, store, claimed, { ...input, execution: { settings } }))
    .pressure;
  if (claimed.some((item) => item.lane === "catalog")) {
    const followUp = await claim(new Date().toISOString(), limit);
    if (followUp.length > 0) {
      recordClaimedWorkLag(followUp);
      pressure =
        (await executeClaimedDueWork(state, store, followUp, { ...input, execution: { settings } })).pressure ||
        pressure;
    }
  }
  observeDueWorkPressure(state.dueWorkLimiters, input.plane, pressure, state.syncSettings);
  return true;
}

async function planDueWorkForInstallations(
  state: ConnectorState,
  store: ConnectorRuntimeStore,
  plane: "steady" | "bootstrap",
  installationId?: string,
): Promise<number> {
  const installations = (await store.listInstallations(state.runtime.orgId()))
    .filter((installation) =>
      installationId ? installation.id === installationId : true,
    );
  let planned = 0;
  for (const installation of installations) {
    const driver = state.drivers.get(installation.connector_type);
    if (
      installation.status !== "enabled" ||
      !driver ||
      !driverPolls(driver)
    ) {
      continue;
    }
    const head = await store.getSyncCatalogHead(installation.id);
    const queueHasWork = await store.hasUnassignedSyncWork({
      installation_id: installation.id,
      lanes: dueWorkCoverageLanes(plane),
    });
    if (
      !queueHasWork &&
      needsCatalogDueWork({
        member_count: head.member_count,
        catalog: head.has_cursor ? { complete: head.complete } : null,
      })
    ) {
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
            generation: head.generation,
          }),
        );
        planned += 1;
      }
    }
    if (head.member_count === 0) {
      continue;
    }
    planned += await enqueueDueWorkFromCatalog(state, 
      store,
      installation.id,
      plane,
    );
  }
  return planned;
}

export async function enqueueDueWorkFromCatalog(
  state: ConnectorState,
  store: ConnectorRuntimeStore,
  installationId: string,
  plane: "steady" | "bootstrap",
  options?: { reconcileBootstrap?: boolean },
): Promise<number> {
  // Catalog members have no sync row yet, so the gap index labels them
  // missing "live". Backfill turns that into a history seed. Steady only
  // catches up attachments and does not spend the first-seed budget.
  const seedLimit = plane === "bootstrap"
    ? state.syncSettings?.first_seed_limit ?? firstSeedHeadFromEnv()
    : 0;
  if (plane === "bootstrap" && options?.reconcileBootstrap) {
    return enqueueSyncWorkGaps(state, store, installationId, {
      unseededLimit: seedLimit,
    });
  }
  return enqueueSyncWorkGaps(state, store, installationId, {
    lanes: plane === "steady" ? ["media"] : ["history", "live"],
    unseededLimit: seedLimit,
  });
}

async function enqueueSyncWorkGaps(
  state: ConnectorState,
  store: ConnectorRuntimeStore,
  installationId: string,
  options?: {
    lanes?: readonly SyncLane[];
    unseededLimit?: number;
  },
): Promise<number> {
  const head = await store.getSyncCatalogHead(installationId);
  state.catalogSizeByInstall.set(installationId, head.member_count);
  const gaps = await store.listSyncWorkGaps(installationId, {
    unseeded_limit: options?.unseededLimit ?? 0,
  });
  const installation = await store.findInstallation(installationId);
  const policy = historyPolicyFromConfig(installation?.config);
  const selected = options?.lanes
    ? gaps.filter((gap) => options.lanes?.includes(gap.missing_lane))
    : gaps;
  if (selected.length === 0) {
    return 0;
  }
  return store.enqueueSyncWorkMany(
    planSyncWorkGaps({
      installation_id: installationId,
      gaps: selected,
      now: new Date().toISOString(),
      coldIdleMs: coldIdleMsForCatalogSize(
        head.member_count,
        streamIdleTiersFromEnv().coldIdleMs,
      ),
      preferredThreadId: preferredThreadId(),
      policy,
    }),
  );
}

export async function executeClaimedDueWork(
  state: ConnectorState,
  store: ConnectorRuntimeStore,
  claimed: SyncWorkRecord[],
  input: {
    plane: "steady" | "bootstrap";
    allowHistory: boolean;
    syncRunId?: string;
    execution?: { settings: PersonalSyncSettings | undefined };
  },
): Promise<{ pressure: boolean; accepted_count: number; retry_count: number }> {
  const { settings } = input.execution ?? { settings: state.syncSettings };
  const groups = new Map<string, SyncWorkRecord[]>();
  for (const work of claimed) {
    const group = groups.get(work.installation_id) ?? [];
    group.push(work);
    groups.set(work.installation_id, group);
  }
  const errors: unknown[] = [];
  let pressure = false;
  let acceptedCount = 0;
  let retryCount = 0;
  await mapLimit([...groups.entries()], settings?.installation_concurrency ?? installationConcurrency(), async ([installationId, work]) => {
    const now = new Date().toISOString();
    const catalogWork = work.filter((item) => item.lane === "catalog");
    const streamWork = work.filter((item) => item.lane !== "catalog");
    try {
      if (catalogWork.length > 0) {
        await withDeadline(
          discoverCatalogDueWork(state, store, installationId, input.plane),
          connectorSyncTimeoutMs(),
          `due-work catalog ${installationId}`,
        );
        const settledAt = new Date().toISOString();
        const nextDue = new Date(Date.parse(settledAt) + CATALOG_RESCAN_MS).toISOString();
        for (const item of catalogWork) {
          await store.settleSyncWork({
            id: item.id,
            owner: state.dueWorkOwner,
            now: settledAt,
            outcome: "retry",
            next_due_at: nextDue,
          });
        }
      }
      if (streamWork.length === 0) {
        return;
      }
      const kernelPressure = state.kernelRuntime.pressureView();
      const humanIdle = isHumanIdle();
      const concurrency = dueWorkConcurrency(settings, kernelPressure.level, humanIdle);
      const polled = await withDeadline(
        pollClaimedDueWorkStreams(state, 
          store,
          installationId,
          streamWork,
          input,
          { kernelPressure, humanIdle, concurrency },
        ),
        dueWorkBatchTimeoutMs(streamWork, settings, concurrency),
        `due-work ${input.plane} ${installationId}`,
      );
      if (polled.pressure) {
        pressure = true;
      }
      acceptedCount += polled.accepted;
      retryCount += polled.retry_count;
    } catch (error) {
      errors.push(error);
      retryCount += work.length;
      if (looksLikeSyncPressure(error)) {
        pressure = true;
      }
      // The batch clock ran out before every wave finished. Reschedule those
      // rows immediately; this is not a connector failure.
      const timedOut = error instanceof DeadlineExceededError;
      const retryAt = new Date().toISOString();
      for (const item of work) {
        await store.settleSyncWork({
          id: item.id,
          owner: state.dueWorkOwner,
          now: retryAt,
          outcome: "retry",
          next_due_at: timedOut
            ? retryAt
            : nextDueAfterFailure(item.attempts, retryAt),
          error_code: timedOut ? undefined : safeErrorCode(error),
        });
      }
    }
    await yieldToEventLoop();
  });
  if (errors.length > 0) {
    await applyPullOutcome(errors);
  }
  return { pressure, accepted_count: acceptedCount, retry_count: retryCount };
}

/** Claimed stream work polls that stream only — never re-plans the installation. */
async function pollClaimedDueWorkStreams(
  state: ConnectorState,
  store: ConnectorRuntimeStore,
  installationId: string,
  streamWork: SyncWorkRecord[],
  input: {
    plane: "steady" | "bootstrap";
    allowHistory: boolean;
    syncRunId?: string;
  },
  budget: {
    kernelPressure: KernelPressureView;
    humanIdle: boolean;
    concurrency: ReturnType<typeof dueWorkConcurrency>;
  },
): Promise<{ pressure: boolean; accepted: number; retry_count: number }> {
  const host = state.runtime.requireHost();
  const installation = await state.requireInstallation(store, installationId);
  const driver = state.drivers.get(installation.connector_type);
  if (!driver || installation.status !== "enabled") {
    const now = new Date().toISOString();
    for (const item of streamWork) {
      await settleDueWork(state, store, item, {
        now,
        nextDueAt: nextDueAfterFailure(item.attempts, now),
        errorCode: "unsupported_connector",
      });
    }
    return { pressure: false, accepted: 0, retry_count: 0 };
  }
  const engine = new SyncEngine(store);
  const { humanIdle, kernelPressure, concurrency } = budget;
  const catalogSize = await catalogSizeFor(state, store, installation.id);
  const { live: liveConcurrency, history: historyConcurrency, media: mediaConcurrency } = concurrency;
  const liveItems = streamWork.filter(
    (item) => item.lane === "interactive" || item.lane === "live",
  );
  const historyItems = streamWork.filter((item) => item.lane === "history");
  const mediaItems = streamWork.filter((item) => item.lane === "media");
  let accepted = 0;
  let pages = 0;
  let claimPressure = false;
  let retryCount = 0;
  const reportsPull = streamWork.some(
    (item) =>
      item.lane !== "live" && item.lane !== "interactive",
  );
  if (reportsPull) {
    beginPull();
    state.publishStreams();
  }
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
          await settleDueWork(state, store, item, {
            now: new Date().toISOString(),
            nextDueAt: new Date().toISOString(),
          });
          return;
        }
      }
      if (state.maintenanceHold) {
        retryCount += 1;
        await settleDueWork(state, store, item, {
          now: new Date().toISOString(),
          nextDueAt: new Date().toISOString(),
        });
        return;
      }
      if (item.lane === "live" || item.lane === "interactive") {
        if (item.lane === "interactive") {
          const thread = threadForSyncStream({
            source: driver.source,
            streamKey: item.stream_key,
            allowOpaqueTarget: true,
          });
          try {
            if (!thread) {
              throw new Error("Interactive push stream has no conversation");
            }
            const stream = await driver.resolveThreadStream(
              installation,
              thread,
              asConnectorHost(host),
              process.env,
            );
            state.rememberStreamMeta(
              streamPaceKey(installation.id, stream.stream_key),
              stream,
            );
            await ensureConnectorLivePush(state, installation.id);
            const nudged = await asConnectorHost(host).livePush?.nudge(
              installation.id,
              stream.stream_key,
            );
            if (!nudged) {
              throw new Error("Connector live tail is not ready");
            }
            await store.settleSyncWork({
              id: item.id,
              owner: state.dueWorkOwner,
              now: new Date().toISOString(),
              outcome: "succeeded",
            });
          } catch (error) {
            retryCount += 1;
            const now = new Date().toISOString();
            await settleDueWork(state, store, item, {
              now,
              nextDueAt: nextDueAfterFailure(item.attempts, now),
              errorCode: safeErrorCode(error),
            });
          }
        } else {
          // New messages are pushed. Cancel leftover background latest rows.
          await store.settleSyncWork({
            id: item.id,
            owner: state.dueWorkOwner,
            now: new Date().toISOString(),
            outcome: "succeeded",
          });
        }
        return;
      }
      if (!driverPolls(driver)) {
        retryCount += 1;
        const now = new Date().toISOString();
        await settleDueWork(state, store, item, {
          now,
          nextDueAt: nextDueAfterFailure(item.attempts, now),
          errorCode: "unsupported_connector",
        });
        return;
      }
      if (!input.allowHistory && item.lane === "history") {
        retryCount += 1;
        await settleDueWork(state, store, item, {
          now: new Date().toISOString(),
          nextDueAt: deferWrongPlaneDueAt(),
        });
        return;
      }
      if (item.lane === "media" && input.plane === "bootstrap") {
        retryCount += 1;
        await settleDueWork(state, store, item, {
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
        retryCount += 1;
        await settleDueWork(state, store, item, {
          now: new Date().toISOString(),
          nextDueAt: deferWrongPlaneDueAt(),
        });
        return;
      }
      if (
        item.lane === "media" &&
        (kernelPressure.throttle_media ||
          !humanIdle ||
          state.kernelRuntime.shouldDeferHistorySync())
      ) {
        retryCount += 1;
        await settleDueWork(state, store, item, {
          now: new Date().toISOString(),
          nextDueAt: deferWrongPlaneDueAt(),
        });
        return;
      }
      if (item.lane === "history" && state.pushGate.installationBusy(installation.id)) {
        retryCount += 1;
        const now = new Date().toISOString();
        await settleDueWork(state, store, item, {
          now,
          nextDueAt: now,
        });
        return;
      }
      if (item.lane === "history") {
        const prior = await store.getSyncState(installation.id, item.stream_key);
        const policy = historyPolicyFromConfig(installation.config);
        const phase = prior?.phase ?? "unseeded";
        // messageDuty stays "live" until a page has been read. The first
        // backfill page is still this history row; closing it leaves the
        // catalog discovered and the inbox empty.
        const seedsBackfill = phase === "unseeded" && policy === "backfill";
        if (!seedsBackfill && messageDuty(phase, policy) !== "history") {
          const now = new Date().toISOString();
          if (prior) {
            await store.putSyncState({ ...prior, updated_at: now });
          }
          await store.settleSyncWork({
            id: item.id,
            owner: state.dueWorkOwner,
            now,
            outcome: "succeeded",
          });
          return;
        }
      }
      const thread = threadForSyncStream({
        source: driver.source,
        streamKey: item.stream_key,
        allowOpaqueTarget: true,
      });
      if (!thread) {
        retryCount += 1;
        const now = new Date().toISOString();
        await settleDueWork(state, store, item, {
          now,
          nextDueAt: nextDueAfterFailure(item.attempts, now),
          errorCode: "invalid_config",
        });
        return;
      }
      const threadId = threadIdOf(thread);
      if (
        shouldReleaseInteractiveWork({
          lane: item.lane,
          threadId,
          preferredThreadId: preferredThreadId(),
        })
      ) {
        await releaseStaleInteractiveClaim(state, store, item);
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
        retryCount += 1;
        if (looksLikeSyncPressure(error)) {
          claimPressure = true;
        }
        const now = new Date().toISOString();
        await settleDueWork(state, store, item, {
          now,
          nextDueAt: nextDueAfterFailure(item.attempts, now),
          errorCode: safeErrorCode(error),
        });
        return;
      }
      const older = item.lane === "history";
      const media = item.lane === "media";
      const priorState = await store.getSyncState(
        installation.id,
        item.stream_key,
      );
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
        item.lane,
      );
      state.rememberStreamMeta(key, stream);
      state.streamPulling.add(key);
      if (older) {
        state.streamCatchingUp.add(key);
        state.streamPullingHistory.add(key);
      } else if (media) {
        state.streamPullingMedia.add(key);
      }
      state.publishStreams();
      try {
        const polled = await state.exclusiveStream(
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
                state.quota,
              ),
            ),
          { skipIfBusy: true },
        );
        if (polled === undefined) {
          retryCount += 1;
          await settleDueWork(state, store, item, {
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
        const historyPending = polled.some(
          (run) => "poll_hint" in run && run.poll_hint?.history_pending === true,
        );
        const continues =
          item.lane === "media"
            ? hasMore
            : sameLaneContinues({
                kind: older ? "history" : "live",
                hasMore,
                historyPending,
              });
        const heat = classifyDueWorkHeat({
          preferred,
          acceptedCount: summary.accepted_count,
          eager: older || media || continues,
        });
        idleMs = dueWorkStreamIdleMs(
          stream,
          installation.config,
          heat,
          catalogSize,
          item.lane,
        );
        const result = {
          key,
          pages: polled,
          pagesBudget: DEFAULT_MAX_PAGES,
          idleMs,
          error: null as unknown,
        };
        state.rememberStreamPace(result);
        await rememberEngineResult(
          engine,
          installation.id,
          {
            stream,
            older,
            media,
            idleMs,
            phase: priorState?.phase,
            historyCursor: priorState?.history_cursor,
            historyPolicy: historyPolicyFromConfig(installation.config),
          },
          result,
        );
        accepted += summary.accepted_count;
        pages += polled.length;
        if (summary.accepted_count > 0 && stream.thread_id) {
          state.inbox.publishThreadUpdated(stream.thread_id);
        }
        const settledAt = new Date().toISOString();
        if (
          shouldReleaseInteractiveWork({
            lane: item.lane,
            threadId: stream.thread_id ?? threadId,
            preferredThreadId: preferredThreadId(),
          })
        ) {
          await releaseStaleInteractiveClaim(state, store, item);
          return;
        }
        const syncState = await store.getSyncState(
          installation.id,
          stream.stream_key,
        );
        const nextDueAt = nextDueAfterPoll({
          now: settledAt,
          idleUntil: syncState?.idle_until,
          idleMs,
          heat,
          coldIdleMs: coldIdleMsForCatalogSize(
            catalogSize,
            streamIdleTiersFromEnv().coldIdleMs,
          ),
        });
        recordDueWorkFreshness({
          installationId: installation.id,
          lane: item.lane,
          heat,
          idleMs,
          settledAt,
          nextDueAt,
        });
        await settleDueWork(state, store, item, {
          now: settledAt,
          nextDueAt,
          acceptedCount: summary.accepted_count,
        });
      } catch (error) {
        retryCount += 1;
        if (looksLikeSyncPressure(error)) {
          claimPressure = true;
        }
        state.rememberStreamPace({
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
        const blobContention = isBlobReservationConflict(error);
        await settleDueWork(state, store, item, {
          now,
          nextDueAt: blobContention
            ? nextDueAfterBlobContention(now)
            : nextDueAfterFailure(item.attempts, now),
          // Shared body writes are not a failure streak. A later real error
          // starts its backoff from the next claim, not from dozens of pages.
          errorCode: blobContention ? undefined : safeErrorCode(error),
        });
      } finally {
        state.streamPulling.delete(key);
        state.streamPullingHistory.delete(key);
        state.streamPullingMedia.delete(key);
        state.publishStreams();
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
        retryCount += 1;
        await settleDueWork(state, store, item, {
          now: new Date().toISOString(),
          nextDueAt: deferredAt,
        });
      }
    } else {
      await mapLimit(mediaItems, mediaConcurrency, pollItem);
    }
    if (accepted > 0) {
      await state.inbox.publishInboxDigest();
    }
    void refreshSyncSnapshot(state, installation.id);
    return { pressure: claimPressure, accepted, retry_count: retryCount };
  } finally {
    if (reportsPull) {
      finishPull({
        accepted,
        pages,
        catchingUp: state.streamCatchingUp.size,
      });
      state.publishStreams();
    }
  }
}

async function catalogSizeFor(
  state: ConnectorState,
  store: ConnectorRuntimeStore,
  installationId: string,
): Promise<number> {
  const cached = state.catalogSizeByInstall.get(installationId);
  if (cached != null) {
    return cached;
  }
  const head = await store.getSyncCatalogHead(installationId);
  state.catalogSizeByInstall.set(installationId, head.member_count);
  return head.member_count;
}

async function releaseStaleInteractiveClaim(
  state: ConnectorState,
  store: ConnectorRuntimeStore,
  item: SyncWorkRecord,
): Promise<void> {
  const now = new Date().toISOString();
  await store.settleSyncWork({
    id: item.id,
    owner: state.dueWorkOwner,
    now,
    outcome: "cancelled",
  });
}

async function settleDueWork(
  state: ConnectorState,
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
    owner: state.dueWorkOwner,
    now: input.now,
    outcome: "retry",
    next_due_at: input.nextDueAt,
    error_code: input.errorCode,
    accepted_count: input.acceptedCount,
  });
}

export async function discoverCatalogDueWork(
  state: ConnectorState,
  store: ConnectorRuntimeStore,
  installationId: string,
  plane: "steady" | "bootstrap",
): Promise<void> {
  const host = state.runtime.requireHost();
  const installation = await state.requireInstallation(store, installationId);
  const driver = state.drivers.get(installation.connector_type);
  if (!driver || !driverPolls(driver)) {
    return;
  }
  return state.drivers.runInstallation(installation, async () => {
    const engine = new SyncEngine(store);
    if (driver.bindSyncSource) {
      const source = await driver.bindSyncSource(
        installation,
        asConnectorHost(host),
        process.env,
      );
      await engine.refreshCatalog({
        installation_id: installation.id,
        source,
        pages: catalogRefreshPages({ catalogTick: true }),
        force: plane === "bootstrap",
      });
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
        await store.applySyncCatalogPage({
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
      }
    }
    const head = await store.getSyncCatalogHead(installation.id);
    if (head.member_count === 0) {
      return;
    }
    await enqueueDueWorkFromCatalog(state, store, installation.id, "steady");
    await enqueueDueWorkFromCatalog(state, store, installation.id, "bootstrap", {
      reconcileBootstrap: true,
    });
  });
}

export async function catchUp(state: ConnectorState, installationId: string): Promise<void> {
  try {
    await withDeadline(
      catchUpDueWork(state, installationId),
      connectorSyncTimeoutMs(),
      `catchUp ${installationId}`,
    );
  } catch (error) {
    await applyPullOutcome([error]);
  }
}

async function catchUpDueWork(state: ConnectorState, installationId: string): Promise<void> {
  await ensureConnectorLivePush(state, installationId);
  await state.refreshSyncSettings();
  const store = state.runtime.requireHost().get("authority");
  const installation = await store.findInstallation(installationId);
  const driver = installation
    ? state.drivers.get(installation.connector_type)
    : undefined;
  if (installation && driver?.reconcilePush) {
    await reconcilePush(state, installationId);
  }
  await discoverCatalogDueWork(state, store, installationId, "bootstrap");
  await runDueWorkPlane(state, store, {
    plane: "bootstrap",
    lanes: [...historySyncClaimLanes()],
    allowHistory: true,
    installationId,
  });
}

const HIDDEN_THREADS_TTL_MS = 30_000;
const hiddenThreadsCache = new WeakMap<
  object,
  { org_id: string; at: number; ids: Promise<Set<string>> }
>();

// Snapshot refreshes run per sync tick; the executor-thread scan does not need to.
function hiddenExecutorThreads(
  store: { listHiddenExecutorThreadIds(orgId: string): Promise<string[]> },
  orgId: string,
): Promise<Set<string>> {
  const cached = hiddenThreadsCache.get(store);
  if (cached && cached.org_id === orgId && Date.now() - cached.at < HIDDEN_THREADS_TTL_MS) {
    return cached.ids;
  }
  const ids = store.listHiddenExecutorThreadIds(orgId).then((list) => new Set(list));
  hiddenThreadsCache.set(store, { org_id: orgId, at: Date.now(), ids });
  ids.catch(() => {
    if (hiddenThreadsCache.get(store)?.ids === ids) hiddenThreadsCache.delete(store);
  });
  return ids;
}

async function refreshSyncSnapshot(
  state: ConnectorState,
  installationId: string,
  _streams?: readonly ConnectorStream[],
): Promise<void> {
  try {
    const store = state.runtime.requireHost().get("authority");
    const [catalog, states, attempt, hidden] = await Promise.all([
      store.getSyncCatalog(installationId),
      store.listSyncPhaseHeads(installationId),
      store.latestAttempt(installationId),
      hiddenExecutorThreads(store, state.runtime.orgId()),
    ]);
    const snapshot = buildSyncProgressSnapshot({
      installation_id: installationId,
      members: catalog.members,
      hiddenThreadIds: hidden,
      states,
      catalog_complete: catalog.catalog?.complete === true,
    });
    if (snapshot) {
      state.kernelRuntime.publishSyncSnapshot(snapshot);
    }
    if (attempt) {
      state.kernelRuntime.publishInstallAttempt(installationId, attempt);
    }
  } catch (error) {
    console.warn("sync progress snapshot refresh failed", error);
  }
}

function pollRunsHadPressure(runs: ConnectorPollRunResult[]): boolean {
  return runs.some((run) => run.status === "throttled");
}

async function rememberEngineResult(
  engine: SyncEngine,
  installationId: string,
  item: {
    stream: ConnectorStream;
    older: boolean;
    media: boolean;
    idleMs?: number;
    historyPolicy?: "backfill" | "incremental";
    phase?: SyncPhase | null;
    historyCursor?: string | null;
  },
  result: { pages: ConnectorPollRunResult[]; error?: unknown },
): Promise<void> {
  await engine.rememberResult(
    syncOutcomeForPoll(
      installationId,
      {
        stream: item.stream,
        prior: { phase: item.phase, history_cursor: item.historyCursor },
        policy: item.historyPolicy,
        older: item.older,
        media: item.media,
        idleMs: item.idleMs,
      },
      result,
      new Date().toISOString(),
    ),
  );
}

export async function runCatalogTick(state: ConnectorState): Promise<void> {
  await state.refreshSyncSettings();
  const host = state.runtime.requireHost();
  const store = host.get("authority");
  const installations = await store.listInstallations(state.runtime.orgId());
  const errors: unknown[] = [];
  await mapLimit(installations, state.syncSettings?.installation_concurrency ?? installationConcurrency(), async (installation) => {
    if (state.kernelRuntime.shouldDeferHistorySync()) {
      return;
    }
    const driver = state.drivers.get(installation.connector_type);
    if (
      installation.status !== "enabled" ||
      !driver?.bindSyncSource ||
      !driverPolls(driver)
    ) {
      return;
    }
    const bindSyncSource = driver.bindSyncSource.bind(driver);
    try {
      await state.drivers.runInstallation(installation, async () => {
        const source = await bindSyncSource(
          installation,
          asConnectorHost(host),
          process.env,
        );
        const engine = new SyncEngine(store);
        await engine.refreshCatalogIfStale({
          installation_id: installation.id,
          source,
          pages: catalogRefreshPages({ catalogTick: true }),
          force: false,
        });
        await enqueueDueWorkFromCatalog(state,
          store,
          installation.id,
          "steady",
        );
        await enqueueDueWorkFromCatalog(state,
          store,
          installation.id,
          "bootstrap",
          { reconcileBootstrap: true },
        );
        void refreshSyncSnapshot(state, installation.id);
      });
    } catch (error) {
      errors.push(error);
    }
    await yieldToEventLoop();
  });
  if (errors.length > 0) {
    await applyPullOutcome(errors);
  }
}
