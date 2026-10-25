import { randomUUID } from "node:crypto";
import {
  connectorSyncTimeoutMs,
  type ConnectorRuntimeStore,
  type IngestQuarantine,
  firstSeedHeadFromEnv,
  MAX_DUE_WORK_CLAIM_LIMIT,
  needsCatalogDueWork,
  selectSyncRunWakeKeys,
  syncRunWorkLanes,
  syncRunWorkPlane,
  type SyncRun,
  type SyncWorkRecord,
} from "@regenic/domain";
import {
  PersonalConnectorError,
} from "./personal-errors";
import {
  preferredThreadId,
} from "./personal-pull-status";

import type { ConnectorDueWorkState as ConnectorState } from "./personal-connector-state";
import type { StartSyncRunInput } from "./personal-connector-types";
import {
  safeErrorCode,
  LEASE_MS,
  DEFAULT_MAX_PAGES,
} from "./personal-connector-poll";
import {
  recordClaimedWorkLag,
  dueWorkClaimLimitFor,
} from "./personal-connector-rhythm";
import {
  discoverCatalogDueWork,
  enqueueDueWorkFromCatalog,
  executeClaimedDueWork,
} from "./personal-connector-due-work";

const MAX_PAGES_CAP = 5;

export async function startSyncRun(
  state: ConnectorState,
  installationId: string,
  input: StartSyncRunInput = {},
): Promise<SyncRun> {
  const host = state.runtime.requireHost();
  const store = host.get("authority");
  const installation = await state.requireInstallation(store, installationId);
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
  void executeDurableSyncRun(state, run.id).catch((error) => {
    console.error("durable connector sync failed", safeErrorCode(error));
  });
  return (await store.getSyncRun(run.id, installation.org_id)) ?? run;
}

export async function listSyncRuns(
  state: ConnectorState,
  installationId?: string,
  limit?: number,
): Promise<SyncRun[]> {
  const store = state.runtime.requireHost().get("authority");
  return store.listSyncRuns({
    org_id: state.runtime.orgId(),
    ...(installationId ? { installation_id: installationId } : {}),
    ...(limit ? { limit } : {}),
  });
}

export async function getSyncRun(state: ConnectorState, runId: string): Promise<SyncRun> {
  const run = await state.runtime
    .requireHost()
    .get("authority")
    .getSyncRun(runId, state.runtime.orgId());
  if (!run) {
    throw new PersonalConnectorError(
      "sync_failed",
      "Sync run was not found",
      404,
    );
  }
  return run;
}

export async function commandSyncRun(
  state: ConnectorState,
  runId: string,
  command: "pause" | "resume" | "cancel",
): Promise<SyncRun> {
  const store = state.runtime.requireHost().get("authority");
  const run = await store.commandSyncRun({
    id: runId,
    org_id: state.runtime.orgId(),
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
    void executeDurableSyncRun(state, run.id).catch((error) => {
      console.error("resumed connector sync failed", safeErrorCode(error));
    });
  }
  return run;
}

export async function listQuarantines(
  state: ConnectorState,
  installationId: string,
): Promise<IngestQuarantine[]> {
  const store = state.runtime.requireHost().get("authority");
  await state.requireInstallation(store, installationId);
  return store.listQuarantines(installationId);
}

export async function retryQuarantines(
  state: ConnectorState,
  installationId: string,
  quarantineId?: string,
): Promise<SyncRun> {
  const quarantines = await listQuarantines(state, installationId);
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
  return startSyncRun(state, installationId, {
    mode: "quick_start",
    stream_keys: [...new Set(selected.map((item) => item.stream_key))],
  });
}

async function executeDurableSyncRun(state: ConnectorState, runId: string): Promise<void> {
  const store = state.runtime.requireHost().get("authority");
  const run = await store.getSyncRun(runId, state.runtime.orgId());
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
    const result = await executeSyncRunDueWork(state, store, run);
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
async function executeSyncRunDueWork(
  state: ConnectorState,
  store: ConnectorRuntimeStore,
  run: SyncRun,
): Promise<{ accepted_count: number }> {
  const plane = syncRunWorkPlane(run.mode);
  const lanes = syncRunWorkLanes(run.mode);
  const allowHistory = run.mode === "archive";
  let catalog = await store.getSyncCatalog(run.installation_id);
  if (needsCatalogDueWork(catalog) || catalog.members.length === 0) {
    await discoverCatalogDueWork(state, store, run.installation_id, plane);
    catalog = await store.getSyncCatalog(run.installation_id);
  } else {
    await enqueueDueWorkFromCatalog(state, 
      store,
      run.installation_id,
      plane,
      { reconcileBootstrap: plane === "bootstrap" },
    );
    if (plane === "bootstrap") {
      await enqueueDueWorkFromCatalog(state, 
        store,
        run.installation_id,
        "steady",
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
      dueWorkClaimLimitFor(state.dueWorkLimiters, plane),
      wakeKeys.length + 1,
      firstSeedHeadFromEnv() + 2,
    ),
  );
  const claim = async (): Promise<SyncWorkRecord[]> =>
    store.claimSyncWork({
      owner: state.dueWorkOwner,
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
    const executed = await executeClaimedDueWork(state, store, claimed, {
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
          await executeClaimedDueWork(state, store, followUp, {
            plane,
            allowHistory,
            syncRunId: run.id,
          })
        ).accepted_count;
      }
    }
  } else if (wakeKeys.length > 0) {
    for (const streamKey of wakeKeys) {
      await state.exclusiveStream(
        run.installation_id,
        streamKey,
        async () => undefined,
        { skipIfBusy: false },
      );
    }
  }
  return { accepted_count: accepted };
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

function clampPages(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    return DEFAULT_MAX_PAGES;
  }
  return Math.min(value, MAX_PAGES_CAP);
}
