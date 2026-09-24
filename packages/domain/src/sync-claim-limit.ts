import type { SyncMetricAggregate } from "./sync-observability";

export const DEFAULT_DUE_WORK_CLAIM_LIMIT = 32;
export const DEFAULT_BOOTSTRAP_DUE_WORK_CLAIM_LIMIT = 16;
export const MIN_DUE_WORK_CLAIM_LIMIT = 1;
export const MAX_DUE_WORK_CLAIM_LIMIT = 128;
export const WRITE_WAIT_PRESSURE_MS = 250;

/**
 * Process-local AIMD around the due-work claim cap. Halve on 429 / quota
 * throttle / write wait; +1 on a clean tick. Not persisted across processes.
 */
export class DueWorkClaimLimiter {
  private value: number;

  constructor(
    private readonly floor = MIN_DUE_WORK_CLAIM_LIMIT,
    private readonly ceiling = MAX_DUE_WORK_CLAIM_LIMIT,
    initial = DEFAULT_DUE_WORK_CLAIM_LIMIT,
  ) {
    this.value = clampClaimLimit(initial, this.floor, this.ceiling);
  }

  limit(cap = this.ceiling): number {
    return Math.min(this.value, clampClaimLimit(cap, this.floor, this.ceiling));
  }

  observe(pressure: boolean, cap = this.ceiling): void {
    const current = this.limit(cap);
    if (pressure) {
      this.value = Math.max(this.floor, Math.floor(current / 2) || this.floor);
      return;
    }
    this.value = Math.min(this.ceiling, current + 1);
  }
}

export function looksLikeSyncPressure(error: unknown): boolean {
  if (error == null) {
    return false;
  }
  if (
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "throttled"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /\b429\b|rate.?limit|throttl/i.test(message);
}

export function dueWorkHasWritePressure(
  snapshot: readonly SyncMetricAggregate[],
  thresholdMs = WRITE_WAIT_PRESSURE_MS,
): boolean {
  return snapshot.some(
    (row) => row.name === "writer_wait_ms" && row.last >= thresholdMs,
  );
}

function clampClaimLimit(raw: number, min: number, max: number): number {
  if (!Number.isFinite(raw)) {
    return max;
  }
  return Math.max(min, Math.min(Math.floor(raw), max));
}
