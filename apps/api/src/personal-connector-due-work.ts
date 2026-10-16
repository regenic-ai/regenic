import {
  DeadlineExceededError,
  asConnectorHost,
  connectorSyncTimeoutMs,
  driverPolls,
  runInSyncLane,
  SyncEngine,
  applyKernelPressureToSyncBudget,
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
  conversationThreadFromStreamKey,
  dueWorkCoverageLanes,
  firstSeedHeadFromEnv,
  looksLikeSyncPressure,
  needsCatalogDueWork,
  historyPolicyFromConfig,
  historySyncClaimLanes,
  messageDuty,
  liveWorkAfterInteractiveRelease,
  nextDueAfterPoll,
  planSyncWorkGaps,
  sameLaneContinues,
  shouldReleaseInteractiveWork,
  type SyncLane,
  type SyncPhase,
  type SyncWorkRecord,
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
  syncExecutionBudget,
} from "./personal-stream-pace";

import { loadEligibleInstallationThreads } from "./personal-eligible-threads";

import { catalogMembersFromStreams } from "./connector-sync-members";

import type { ConnectorState } from "./personal-connector-state";
import {
  pollStream,
  mapLimit,
  safeErrorCode,
  summarizeRuns,
  LEASE_MS,
  DEFAULT_MAX_PAGES,
} from "./personal-connector-poll";
import {
  dueWorkBatchTimeoutMs,
  recordClaimedWorkLag,
  deferWrongPlaneDueAt,
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
  const now = new Date().toISOString();
  const limit = dueWorkClaimLimitFor(state.dueWorkLimiters, input.plane);
  const claim = (at: string) =>
    store.claimSyncWork({
      owner: state.dueWorkOwner,
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
  recordClaimedWorkLag(claimed);
  let pressure = (await executeClaimedDueWork(state, store, claimed, input))
    .pressure;
  if (claimed.some((item) => item.lane === "catalog")) {
    const followUp = await claim(new Date().toISOString());
    if (followUp.length > 0) {
      recordClaimedWorkLag(followUp);
      pressure =
        (await executeClaimedDueWork(state, store, followUp, input)).pressure ||
        pressure;
    }
  }
  observeDueWorkPressure(state.dueWorkLimiters, input.plane, pressure);
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
  const coverageLanes = dueWorkCoverageLanes(plane);
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
      lanes: coverageLanes,
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
  if (plane === "bootstrap" && options?.reconcileBootstrap) {
    return enqueueSyncWorkGaps(state, store, installationId);
  }
  return enqueueSyncWorkGaps(state, store, installationId, {
    lanes: plane === "steady" ? ["live", "media"] : ["history"],
    unseededLimit: plane === "steady" ? firstSeedHeadFromEnv() : 0,
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
      const polled = await withDeadline(
        pollClaimedDueWorkStreams(state, 
          store,
          installationId,
          streamWork,
          input,
        ),
        dueWorkBatchTimeoutMs(streamWork),
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
  return { pressure, accepted_count: acceptedCount };
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
): Promise<{ pressure: boolean; accepted: number }> {
  const host = state.runtime.requireHost();
  const installation = await state.requireInstallation(store, installationId);
  const driver = state.drivers.get(installation.connector_type);
  if (!driver || !driverPolls(driver) || installation.status !== "enabled") {
    const now = new Date().toISOString();
    for (const item of streamWork) {
      await settleDueWork(state, store, item, {
        now,
        nextDueAt: nextDueAfterFailure(item.attempts, now),
        errorCode: "unsupported_connector",
      });
    }
    return { pressure: false, accepted: 0 };
  }
  const engine = new SyncEngine(store);
  const humanIdle = isHumanIdle();
  const kernelPressure = state.kernelRuntime.pressureView();
  const catalogSize = await catalogSizeFor(state, store, installation.id);
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
  state.publishStreams();
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
        await settleDueWork(state, store, item, {
          now: new Date().toISOString(),
          nextDueAt: new Date().toISOString(),
        });
        return;
      }
      if (!input.allowHistory && item.lane === "history") {
        await settleDueWork(state, store, item, {
          now: new Date().toISOString(),
          nextDueAt: deferWrongPlaneDueAt(),
        });
        return;
      }
      if (item.lane === "media" && input.plane === "bootstrap") {
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
        await settleDueWork(state, store, item, {
          now: new Date().toISOString(),
          nextDueAt: deferWrongPlaneDueAt(),
        });
        return;
      }
      if (item.lane === "history") {
        const prior = await store.getSyncState(installation.id, item.stream_key);
        const policy = historyPolicyFromConfig(installation.config);
        if (messageDuty(prior?.phase, policy) !== "history") {
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
      const thread = conversationThreadFromStreamKey(
        driver.source,
        item.stream_key,
      );
      if (!thread) {
        const now = new Date().toISOString();
        await settleDueWork(state, store, item, {
          now,
          nextDueAt: nextDueAfterFailure(item.attempts, now),
          errorCode: "invalid_config",
        });
        return;
      }
      const threadId = `${thread.source}:${thread.target}`;
      if (
        shouldReleaseInteractiveWork({
          lane: item.lane,
          threadId,
          preferredThreadId: preferredThreadId(),
        })
      ) {
        await releaseStaleInteractiveClaim(
          state,
          store,
          item,
          catalogSize,
        );
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
          { skipIfBusy: item.lane !== "interactive" },
        );
        if (polled === undefined) {
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
          await releaseStaleInteractiveClaim(
            state,
            store,
            item,
            catalogSize,
          );
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
        await settleDueWork(state, store, item, {
          now,
          nextDueAt: nextDueAfterFailure(item.attempts, now),
          errorCode: safeErrorCode(error),
        });
      } finally {
        state.streamPulling.delete(key);
        state.streamPullingHistory.delete(key);
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
    return { pressure: claimPressure, accepted };
  } finally {
    finishPull({
      accepted,
      pages,
      catchingUp: state.streamCatchingUp.size,
    });
    state.publishStreams();
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

async function releaseStaleInteractiveClaim(
  state: ConnectorState,
  store: ConnectorRuntimeStore,
  item: SyncWorkRecord,
  catalogSize: number,
): Promise<void> {
  const now = new Date().toISOString();
  await store.settleSyncWork({
    id: item.id,
    owner: state.dueWorkOwner,
    now,
    outcome: "cancelled",
  });
  await store.enqueueSyncWork(
    liveWorkAfterInteractiveRelease({
      installation_id: item.installation_id,
      stream_key: item.stream_key,
      generation: item.generation,
      now,
      coldIdleMs: coldIdleMsForCatalogSize(
        catalogSize,
        streamIdleTiersFromEnv().coldIdleMs,
      ),
    }),
  );
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
  const store = state.runtime.requireHost().get("authority");
  await discoverCatalogDueWork(state, store, installationId, "bootstrap");
  await runDueWorkPlane(state, store, {
    plane: "bootstrap",
    lanes: [...historySyncClaimLanes()],
    allowHistory: true,
    installationId,
  });
}

async function refreshSyncSnapshot(
  state: ConnectorState,
  installationId: string,
  _streams?: readonly ConnectorStream[],
): Promise<void> {
  try {
    const store = state.runtime.requireHost().get("authority");
    const [catalog, states, attempt] = await Promise.all([
      store.getSyncCatalog(installationId),
      store.listSyncPhaseHeads(installationId),
      store.latestAttempt(installationId),
    ]);
    const snapshot = buildSyncProgressSnapshot({
      installation_id: installationId,
      members: catalog.members,
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
  const host = state.runtime.requireHost();
  const store = host.get("authority");
  const installations = await store.listInstallations(state.runtime.orgId());
  const errors: unknown[] = [];
  await mapLimit(installations, installationConcurrency(), async (installation) => {
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
    try {
      const source = await driver.bindSyncSource(
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
    } catch (error) {
      errors.push(error);
    }
    await yieldToEventLoop();
  });
  if (errors.length > 0) {
    await applyPullOutcome(errors);
  }
}
