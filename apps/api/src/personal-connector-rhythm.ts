import {
  connectorPollTimeoutMs,
  connectorSyncTimeoutMs,
  pacedStreamIdleMs,
  streamIdleTiersFromEnv,
  syncModeFromConfig,
  syncModePreset,
  type ConnectorStream,
  coldIdleMsForCatalogSize,
  DueWorkClaimLimiter,
  dueWorkHasWritePressure,
  dueWorkIdleMs,
  processSyncMetrics,
  recordPollFreshness,
  recordWorkQueueLag,
  type DueWorkHeat,
  type SyncLane,
  type SyncWorkRecord,
} from "@regenic/domain";

import {
  preferredThreadId,
} from "./personal-pull-status";

import {
  IDLE_HISTORY_STREAM_CONCURRENCY,
  LIVE_STREAM_CONCURRENCY,
} from "./personal-stream-pace";

const DEFAULT_PULL_MS = 2_000;
const DEFAULT_CATALOG_PULL_MS = 45_000;

export function pullIntervalMs(): number {
  const raw = Number(process.env.REGENIC_CONNECTOR_PULL_MS ?? DEFAULT_PULL_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.max(1_000, Math.min(raw, 60_000));
}

export function bootstrapPullIntervalMs(): number {
  const raw = Number(process.env.REGENIC_BOOTSTRAP_PULL_MS ?? 1_500);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.max(500, Math.min(raw, 30_000));
}

export function catalogPullIntervalMs(): number {
  const raw = Number(process.env.REGENIC_CATALOG_PULL_MS ?? DEFAULT_CATALOG_PULL_MS);
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.max(15_000, Math.min(raw, 120_000));
}

export function dueWorkBatchTimeoutMs(
  work: readonly { lane: string }[],
): number {
  const pollMs = connectorPollTimeoutMs();
  const live = work.filter(
    (item) => item.lane === "live" || item.lane === "interactive",
  ).length;
  const history = work.filter((item) => item.lane === "history").length;
  const waves = Math.max(
    Math.ceil(live / Math.max(1, LIVE_STREAM_CONCURRENCY)),
    Math.ceil(history / Math.max(1, IDLE_HISTORY_STREAM_CONCURRENCY)),
    1,
  );
  // Each list already stops at the poll timeout. The batch clock has to
  // cover every wave of this claim; a flat 30s cuts the later waves.
  return Math.max(connectorSyncTimeoutMs(), waves * pollMs + 5_000);
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

export function recordClaimedWorkLag(claimed: readonly SyncWorkRecord[]): void {
  for (const item of claimed) {
    recordWorkQueueLag(processSyncMetrics, item.next_due_at, {
      installation_id: item.installation_id,
      lane: item.lane,
    });
  }
}

export function deferWrongPlaneDueAt(nowMs = Date.now()): string {
  return new Date(nowMs + 60_000).toISOString();
}

export function nextDueAfterFailure(attempts: number, now: string): string {
  const delay = Math.min(300_000, 5_000 * 2 ** Math.min(Math.max(attempts, 1), 6));
  return new Date(Date.parse(now) + delay).toISOString();
}

export function installationConcurrency(): number {
  const raw = Number(process.env.REGENIC_INSTALLATION_SYNC_CONCURRENCY ?? 4);
  if (!Number.isFinite(raw)) {
    return 4;
  }
  return Math.max(1, Math.min(16, Math.floor(raw)));
}

export function streamPaceKey(installationId: string, streamKey: string): string {
  return `${installationId}:${streamKey}`;
}

/** Prefer connector pace or sync_mode; omit idle when neither is set (DSH). */
export function streamIdleMs(
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

export function dueWorkStreamPreferred(
  lane: SyncLane,
  threadId?: string | null,
): boolean {
  if (lane === "interactive") {
    return true;
  }
  const preferred = preferredThreadId();
  return Boolean(preferred && threadId && threadId === preferred);
}

export function dueWorkStreamIdleMs(
  stream: ConnectorStream,
  config: Record<string, unknown> | undefined,
  heat: DueWorkHeat,
  catalogSize: number,
  lane?: SyncLane,
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
  const idleMs = dueWorkIdleMs({
    heat,
    hintMs,
    activeIdleMs: modeTiers?.activeIdleMs ?? envTiers.activeIdleMs,
    hotIdleMs: envTiers.hotIdleMs,
    coldIdleMs: coldIdleMsForCatalogSize(catalogSize, envTiers.coldIdleMs),
  });
  if (lane === "history" || lane === "media" || idleMs == null) {
    return idleMs;
  }
  // Quiet chats still need a list-freshness pass. History keeps the long cold idle.
  return Math.min(idleMs, 2 * 60 * 1000);
}

export function recordDueWorkFreshness(input: {
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

export function dueWorkClaimLimitFor(
  limiters: {
    steady: DueWorkClaimLimiter;
    bootstrap: DueWorkClaimLimiter;
  },
  plane: "steady" | "bootstrap",
): number {
  return limiters[plane].limit(dueWorkClaimLimit(plane));
}

export function observeDueWorkPressure(
  limiters: {
    steady: DueWorkClaimLimiter;
    bootstrap: DueWorkClaimLimiter;
  },
  plane: "steady" | "bootstrap",
  pressure: boolean,
): void {
  limiters[plane].observe(
    pressure || dueWorkHasWritePressure(processSyncMetrics.snapshot()),
    dueWorkClaimLimit(plane),
  );
}
