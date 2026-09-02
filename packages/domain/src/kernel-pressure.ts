import type { SyncLane } from "./sync-contracts";

/** Process load seen by the personal kernel sidecar. */
export type KernelPressureLevel = "ok" | "elevated" | "critical";

export interface KernelPressureSample {
  rss_bytes: number;
  heap_used_bytes: number;
  event_loop_lag_ms?: number;
  sync_active?: boolean;
  interactive_waiters?: number;
}

export interface KernelPressureThresholds {
  elevated_heap_bytes: number;
  critical_heap_bytes: number;
  elevated_lag_ms: number;
  critical_lag_ms: number;
}

export const DEFAULT_KERNEL_PRESSURE_THRESHOLDS: KernelPressureThresholds = {
  elevated_heap_bytes: 400 * 1024 * 1024,
  critical_heap_bytes: 768 * 1024 * 1024,
  elevated_lag_ms: 100,
  critical_lag_ms: 500,
};

export function kernelPressureThresholdsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): KernelPressureThresholds {
  return {
    elevated_heap_bytes: readPositiveIntEnv(
      env.REGENIC_KERNEL_ELEVATED_HEAP_BYTES,
      DEFAULT_KERNEL_PRESSURE_THRESHOLDS.elevated_heap_bytes,
    ),
    critical_heap_bytes: readPositiveIntEnv(
      env.REGENIC_KERNEL_CRITICAL_HEAP_BYTES,
      DEFAULT_KERNEL_PRESSURE_THRESHOLDS.critical_heap_bytes,
    ),
    elevated_lag_ms: readPositiveIntEnv(
      env.REGENIC_KERNEL_ELEVATED_LAG_MS,
      DEFAULT_KERNEL_PRESSURE_THRESHOLDS.elevated_lag_ms,
    ),
    critical_lag_ms: readPositiveIntEnv(
      env.REGENIC_KERNEL_CRITICAL_LAG_MS,
      DEFAULT_KERNEL_PRESSURE_THRESHOLDS.critical_lag_ms,
    ),
  };
}

function readPositiveIntEnv(raw: unknown, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export interface KernelPressureView {
  level: KernelPressureLevel;
  interactive_ready: boolean;
  throttle_history: boolean;
  throttle_media: boolean;
}

export interface SyncBudgetInput {
  pages: number;
  concurrency: number;
  lane: SyncLane;
}

export function classifyKernelPressure(
  sample: KernelPressureSample,
  thresholds: KernelPressureThresholds = DEFAULT_KERNEL_PRESSURE_THRESHOLDS,
): KernelPressureLevel {
  const heap = Math.max(sample.heap_used_bytes, sample.rss_bytes);
  const lag = sample.event_loop_lag_ms ?? 0;
  if (
    heap >= thresholds.critical_heap_bytes ||
    lag >= thresholds.critical_lag_ms
  ) {
    return "critical";
  }
  if (
    heap >= thresholds.elevated_heap_bytes ||
    lag >= thresholds.elevated_lag_ms ||
    (sample.sync_active === true && (sample.interactive_waiters ?? 0) > 0)
  ) {
    return "elevated";
  }
  return "ok";
}

export function kernelPressureView(
  sample: KernelPressureSample,
  thresholds?: KernelPressureThresholds,
): KernelPressureView {
  const level = classifyKernelPressure(sample, thresholds);
  return {
    level,
    interactive_ready: level === "ok",
    throttle_history: level !== "ok",
    throttle_media: level === "critical",
  };
}

/** Background connector ticks should wait while inbox/engine reads are in flight. */
export function shouldDeferBackgroundSync(
  sample: KernelPressureSample,
  thresholds: KernelPressureThresholds = DEFAULT_KERNEL_PRESSURE_THRESHOLDS,
): boolean {
  if ((sample.interactive_waiters ?? 0) > 0) {
    return true;
  }
  return classifyKernelPressure(sample, thresholds) === "critical";
}

/** Adjust a planned sync budget under load. History and media yield first. */
export function applyKernelPressureToSyncBudget(
  budget: SyncBudgetInput,
  level: KernelPressureLevel,
): SyncBudgetInput {
  if (level === "ok") {
    return budget;
  }
  if (budget.lane === "history") {
    return { ...budget, pages: 1, concurrency: 1 };
  }
  if (budget.lane === "media") {
    if (level === "critical") {
      return { ...budget, pages: 1, concurrency: 0 };
    }
    return { ...budget, pages: 1, concurrency: 1 };
  }
  const concurrency =
    level === "critical"
      ? 1
      : Math.max(1, Math.floor(budget.concurrency / 2));
  const pages = level === "critical" ? 1 : budget.pages;
  return { ...budget, pages, concurrency };
}
