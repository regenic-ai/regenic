import { randomUUID } from "node:crypto";
import {
  PushIngestBackpressureError,
  PushIngestRejectedError,
  advancePushReconcileCursor,
  asConnectorHost,
  connectorSyncTimeoutMs,
  driverPolls,
  historyPolicyFromConfig,
  mediaPendingAfterPush,
  phaseAfterPush,
  processSyncMetrics,
  threadForSyncStream,
  threadIdOf,
  pushReconcileStart,
  pushWatermarkPageLimit,
  recordPushLag,
  validateConnectorLimits,
  watermarkAgeMs,
  withDeadline,
  type ConnectorInstallation,
  type InstallationLimitsView,
  type IngestValidationIssue,
  type PushIngestAck,
  type PushIngestSnapshot,
  type PushWatermarkPage,
  type PushWatermarkSummary,
} from "@regenic/domain";
import { PersonalConnectorError } from "./personal-errors";
import type { ConnectorPushState, ConnectorState, PushReconcileNote } from "./personal-connector-state";
import { ingestTokenMatches } from "./personal-ingest-token";
import { applyPullOutcome } from "./personal-pull-status";
import { safeErrorCode } from "./personal-connector-poll";
import { persistPushBackpressure } from "./personal-push-backpressure";

const MAINTENANCE_RETRY_AFTER_MS = 5_000;

export interface IngestAuth {
  /** Present when the caller authenticated with an installation ingest token. */
  token?: string;
  personalKey?: string | null;
}

export type ConnectorLimitsView = InstallationLimitsView & { installation_id: string };

export async function ingestPush(
  state: ConnectorPushState,
  installationId: string,
  body: unknown,
  auth: IngestAuth,
): Promise<PushIngestAck> {
  if (state.maintenanceHold) {
    throw new PersonalConnectorError(
      "disabled",
      "Store maintenance in progress",
      503,
      MAINTENANCE_RETRY_AFTER_MS,
    );
  }
  const installation = await requirePushInstallation(state, installationId, auth);
  const driver = state.drivers.get(installation.connector_type);
  if (!driver) {
    throw new PersonalConnectorError(
      "unsupported_channel",
      `Connector type cannot ingest pushes: ${installation.connector_type}`,
      501,
    );
  }
  let ack: PushIngestAck;
  try {
    ack = await state.pushGate.submit({
      installation,
      source: driver.source,
      batch: driver.transformPushBatch
        ? driver.transformPushBatch(installation, body)
        : body,
    });
  } catch (error) {
    if (error instanceof PushIngestBackpressureError) {
      persistPushBackpressure(
        state.runtime.requireHost().get("authority"),
        installation.org_id,
        error.retry_after_ms,
      );
      throw new PersonalConnectorError(
        "throttled",
        error.message,
        429,
        error.retry_after_ms,
      );
    }
    if (error instanceof PushIngestRejectedError) {
      throw new PersonalConnectorError(
        error.code,
        describeIssues(error.issues),
        error.code === "connector_mismatch" ? 403 : 400,
      );
    }
    throw error;
  }
  if (ack.accepted_count > 0) {
    state.inbox.touchInboxDigest();
  }
  if (ack.accepted_count > 0 || ack.duplicate_count > 0) {
    await markPushStreamLive(
      state,
      installation,
      ack.stream_key,
      reportedMediaPending(body, ack.retryable_count),
    );
  }
  return ack;
}

export async function listWatermarks(
  state: ConnectorPushState,
  installationId: string,
  auth: IngestAuth,
  query: { stream_keys?: string[]; after?: string; limit?: number } = {},
): Promise<PushWatermarkPage> {
  const installation = await requirePushInstallation(state, installationId, auth, {
    requireEnabled: false,
  });
  const store = state.runtime.requireHost().get("authority");
  const limit = pushWatermarkPageLimit(query.limit);
  const watermarks = await store.listPushWatermarks(installation.id, {
    ...(query.stream_keys?.length ? { stream_keys: query.stream_keys } : {}),
    ...(query.after ? { after: query.after } : {}),
    limit: limit + 1,
  });
  const page = watermarks.slice(0, limit);
  const overflow = watermarks[limit];
  return {
    watermarks: page,
    ...(overflow ? { next_after: page[page.length - 1]?.stream_key } : {}),
  };
}

export async function summarizeWatermarks(
  state: ConnectorPushState,
  installationId: string,
  auth: IngestAuth,
): Promise<PushWatermarkSummary & { installation_id: string }> {
  const installation = await requirePushInstallation(state, installationId, auth, {
    requireEnabled: false,
  });
  const summary = await state.runtime.requireHost().get("authority")
    .summarizePushWatermarks(installation.id);
  return { installation_id: installation.id, ...summary };
}

/** Compare core watermarks with the channel and re-push gaps. Best-effort. */
export async function reconcilePush(
  state: ConnectorPushState,
  installationId: string,
): Promise<{ installation_id: string; repushed_batches: number }> {
  const store = state.runtime.requireHost().get("authority");
  const installation = await state.requireInstallation(store, installationId);
  const driver = state.drivers.get(installation.connector_type);
  if (!driver?.reconcilePush) {
    return { installation_id: installation.id, repushed_batches: 0 };
  }
  if (state.pushReconcileInflight.has(installation.id)) {
    return { installation_id: installation.id, repushed_batches: 0 };
  }
  state.pushReconcileInflight.add(installation.id);
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutMs = connectorSyncTimeoutMs();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
  let failed = false;
  let failure: unknown;
  let repushed = 0;
  try {
    const report = await withDeadline(
      state.drivers.runInstallation(installation, () =>
        driver.reconcilePush!(installation, asConnectorHost(state.runtime.requireHost()), {
          signal: controller.signal,
          async listWatermarks(query) {
            return listWatermarks(state, installation.id, {}, {
              stream_keys: query?.stream_keys ? [...query.stream_keys] : undefined,
              after: query?.after,
              limit: query?.limit,
            });
          },
          async push(batch) {
            const ack = await ingestPush(state, installation.id, batch, {});
            if (ack.accepted_count > 0 || ack.retryable_count > 0) {
              repushed += 1;
            }
            return ack;
          },
        }),
      ),
      timeoutMs,
      `reconcilePush ${installation.id}`,
    );
    return {
      installation_id: installation.id,
      repushed_batches: report?.repushed_batches ?? repushed,
    };
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    clearTimeout(abortTimer);
    controller.abort();
    state.pushReconcileInflight.delete(installation.id);
    const note: PushReconcileNote = {
      at: new Date().toISOString(),
      status: failed ? "error" : "ok",
      repushed_batches: repushed,
      ...(failed ? { error_code: safeErrorCode(failure) } : {}),
    };
    state.pushReconcileNotes.set(installation.id, note);
    processSyncMetrics.record({
      name: "push_reconcile_ms",
      value: Math.max(0, Date.now() - startedAt),
      labels: {
        installation_id: installation.id,
        operation: "push",
        status: failed ? "error" : "ok",
      },
    });
  }
}

const PUSH_RECONCILE_PER_TICK = 2;

/**
 * Cheap, install-level gap recovery for push connectors. Samples ingest
 * gauges, then round-robins a few enabled push installs that declare
 * `reconcilePush`. Yields while a push is already in flight.
 */
export async function runPushReconcileTick(
  state: ConnectorState,
): Promise<{ checked: number; repushed_batches: number }> {
  state.pushGate.sampleObservability();
  if (state.maintenanceHold || state.pushGate.busy()) {
    return { checked: 0, repushed_batches: 0 };
  }
  const store = state.runtime.requireHost().get("authority");
  const candidates = (await store.listInstallations(state.runtime.orgId()))
    .filter((installation) => {
      if (installation.status !== "enabled") {
        return false;
      }
      const driver = state.drivers.get(installation.connector_type);
      return Boolean(driver?.reconcilePush);
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  if (candidates.length === 0) {
    return { checked: 0, repushed_batches: 0 };
  }
  const start = pushReconcileStart(candidates.length, state.pushReconcileCursor);
  let checked = 0;
  let repushed = 0;
  const errors: unknown[] = [];
  for (let offset = 0; offset < candidates.length && checked < PUSH_RECONCILE_PER_TICK; offset += 1) {
    if (state.pushGate.busy()) {
      break;
    }
    const installation = candidates[(start + offset) % candidates.length];
    if (!installation) {
      continue;
    }
    if (state.pushReconcileInflight.has(installation.id)) {
      checked += 1;
      continue;
    }
    const watermark = await store.summarizePushWatermarks(installation.id);
    recordPushLag(processSyncMetrics, watermark.last_updated_at, {
      installation_id: installation.id,
      operation: "push",
      status: "watermark",
    });
    try {
      const report = await reconcilePush(state, installation.id);
      checked += 1;
      repushed += report.repushed_batches;
    } catch (error) {
      errors.push(error);
      checked += 1;
    }
  }
  state.pushReconcileCursor = advancePushReconcileCursor(
    candidates.length,
    state.pushReconcileCursor,
    checked,
  );
  if (errors.length > 0) {
    await applyPullOutcome(errors);
  }
  return { checked, repushed_batches: repushed };
}

export interface PushIngestStatsView extends PushIngestSnapshot, PushWatermarkSummary {
  watermark_age_ms?: number;
  reconcile?: PushReconcileNote;
  backfill?: {
    unseeded: number;
    backfilling: number;
    media_pending: number;
    bootstrap_pending: number;
    steady: number;
  };
}

export async function ingestStats(
  state: ConnectorPushState,
  installationId: string,
  auth: IngestAuth,
): Promise<PushIngestStatsView> {
  const installation = await requirePushInstallation(state, installationId, auth, {
    requireEnabled: false,
  });
  const summary = await state.runtime.requireHost().get("authority")
    .summarizePushWatermarks(installation.id);
  const age = watermarkAgeMs(summary.last_updated_at);
  const reconcile = state.pushReconcileNotes.get(installation.id);
  const progress = state.kernelRuntime.peekSyncProgress(installation.id);
  return {
    ...state.pushGate.snapshot(installation.id),
    ...summary,
    ...(age !== undefined ? { watermark_age_ms: age } : {}),
    ...(reconcile ? { reconcile } : {}),
    ...(progress ? {
      backfill: {
        unseeded: progress.unseeded,
        backfilling: progress.backfilling,
        media_pending: progress.media_pending,
        bootstrap_pending: progress.bootstrap_pending,
        steady: progress.steady,
      },
    } : {}),
  };
}

/** Connector-owned new-message tail. Core due-work does not poll latest. */
export async function ensureConnectorLivePush(
  state: Pick<ConnectorPushState, "runtime" | "drivers" | "ownsLiveRuntime">,
  installationId: string,
): Promise<void> {
  if (!state.ownsLiveRuntime()) {
    asConnectorHost(state.runtime.requireHost()).livePush?.stop(installationId);
    return;
  }
  const store = state.runtime.requireHost().get("authority");
  const installation = await store.findInstallation(installationId);
  if (!installation || installation.org_id !== state.runtime.orgId() || installation.status !== "enabled") {
    asConnectorHost(state.runtime.requireHost()).livePush?.stop(installationId);
    return;
  }
  const driver = state.drivers.get(installation.connector_type);
  const host = asConnectorHost(state.runtime.requireHost());
  if (!host.push) {
    return;
  }
  // Execute-only drivers fork a process from startInstallation. Install,
  // catalog, and restart leave that lazy until a runtime call. Sync
  // connectors open their live tail here.
  if (driver?.startInstallation) {
    if (driver.capabilities(installation).sync) {
      await state.drivers.startInstallation(installation, host, {
        restart:
          host.livePush?.has(installation.id) === false ||
          host.livePush?.generation(installation.id) !== installation.updated_at,
      });
    }
    return;
  }
  host.livePush?.start({
    installationId: installation.id,
    generation: installation.updated_at,
    listStreams: () => host.get("connectors").listStreams(installation.id),
    push: (batch) => host.push!(installation, batch),
    resumeCursor: async (streamKey) => {
      const rows = await store.listPushWatermarks(installation.id, {
        stream_keys: [streamKey],
        limit: 1,
      });
      return rows[0]?.watermark;
    },
    pressure: () => host.pushPressure?.() ?? "ok",
  });
}

/** Persist an interactive wake so the background owner can refresh this stream. */
export async function enqueueInteractiveWake(
  state: Pick<ConnectorPushState, "runtime">,
  installationId: string,
  streamKey: string,
): Promise<void> {
  const store = state.runtime.requireHost().get("authority");
  const prior = await store.getSyncState(installationId, streamKey);
  const now = new Date().toISOString();
  await store.enqueueSyncWork({
    id: `push-nudge:${randomUUID()}`,
    installation_id: installationId,
    stream_key: streamKey,
    lane: "interactive",
    next_due_at: now,
    generation: prior?.generation ?? 1,
    now,
  });
}

export function forgetPushInstallation(
  state: Pick<ConnectorState, "runtime" | "pushGate" | "pushReconcileInflight" | "pushReconcileNotes">,
  installationId: string,
): void {
  asConnectorHost(state.runtime.requireHost()).livePush?.stop(installationId);
  state.pushGate.forget(installationId);
  state.pushReconcileInflight.delete(installationId);
  state.pushReconcileNotes.delete(installationId);
}

function reportedMediaPending(body: unknown, retryable: number): boolean | undefined {
  if (retryable > 0 || !body || typeof body !== "object") {
    return undefined;
  }
  const value = Reflect.get(body, "media_pending");
  return typeof value === "boolean" ? value : undefined;
}

async function markPushStreamLive(
  state: ConnectorPushState,
  installation: ConnectorInstallation,
  streamKey: string,
  reportedMedia?: boolean,
): Promise<void> {
  const store = state.runtime.requireHost().get("authority");
  const now = new Date().toISOString();
  const prior = await store.getSyncState(installation.id, streamKey);
  const driver = state.drivers.get(installation.connector_type);
  const thread = driver
    ? threadForSyncStream({
      source: driver.source,
      streamKey,
      allowOpaqueTarget: true,
    })
    : null;
  const polls = Boolean(driver) && driverPolls(driver);
  const phase = phaseAfterPush({
    prior: prior?.phase,
    policy: historyPolicyFromConfig(installation.config),
    polls,
  });
  const media = mediaPendingAfterPush({ reported: reportedMedia, polls });
  const storedPhase = phase ?? prior?.phase;
  const syncState = storedPhase && (phase || media !== null)
    ? {
      installation_id: installation.id,
      stream_key: streamKey,
      phase: storedPhase,
      media_pending: media ?? prior?.media_pending ?? false,
      generation: prior?.generation ?? 1,
      updated_at: now,
      ...(prior?.live_cursor ? { live_cursor: prior.live_cursor } : {}),
      ...(prior?.history_cursor ? { history_cursor: prior.history_cursor } : {}),
      ...(prior?.idle_until ? { idle_until: prior.idle_until } : {}),
    }
    : undefined;
  await store.noteSyncCatalogStream({
    installation_id: installation.id,
    stream_key: streamKey,
    now,
    ...(thread ? { thread_id: threadIdOf(thread) } : {}),
    ...(syncState ? { sync_state: syncState } : {}),
  });
  await store.wakeUnassignedSyncWork({
    installation_id: installation.id,
    stream_keys: [streamKey],
    now,
  });
}

export async function readLimits(
  state: ConnectorPushState,
  installationId: string,
  auth: IngestAuth,
): Promise<ConnectorLimitsView> {
  const installation = await requirePushInstallation(state, installationId, auth, {
    requireEnabled: false,
  });
  return { installation_id: installation.id, ...state.quota.limits(installation.id) };
}

/** An empty object clears the runtime adjustment and restores the declaration. */
export async function adjustLimits(
  state: ConnectorPushState,
  installationId: string,
  body: unknown,
  auth: IngestAuth,
): Promise<ConnectorLimitsView> {
  const installation = await requirePushInstallation(state, installationId, auth, {
    requireEnabled: false,
  });
  const validation = validateConnectorLimits(body ?? {});
  if (!validation.success) {
    throw new PersonalConnectorError(
      "invalid_config",
      describeIssues(validation.issues),
      400,
    );
  }
  state.quota.adjust(installation.id, validation.data);
  return { installation_id: installation.id, ...state.quota.limits(installation.id) };
}

async function requirePushInstallation(
  state: ConnectorPushState,
  installationId: string,
  auth: IngestAuth,
  options: { requireEnabled?: boolean } = {},
): Promise<ConnectorInstallation> {
  if (auth.token !== undefined &&
      !ingestTokenMatches(auth.personalKey, installationId, auth.token)) {
    throw new PersonalConnectorError(
      "personal_api_unauthorized",
      "Ingest token does not belong to this installation",
      401,
    );
  }
  const store = state.runtime.requireHost().get("authority");
  const installation = await state.requireInstallation(store, installationId);
  if (options.requireEnabled !== false && installation.status !== "enabled") {
    throw new PersonalConnectorError(
      "disabled",
      "Connector installation is disabled",
      409,
    );
  }
  return installation;
}

function describeIssues(issues: readonly IngestValidationIssue[]): string {
  const shown = issues.slice(0, 3).map((issue) =>
    `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  const more = issues.length > shown.length ? ` (+${issues.length - shown.length} more)` : "";
  return `${shown.join("; ")}${more}`;
}
