// Keep in sync with packages/domain `kernel-reachability`.
// The desktop renderer bundle does not import @regenic/domain.

/** Desktop-facing connection quality, distinct from process liveness. */
export type KernelReachability = "live" | "degraded" | "offline";

export interface KernelReachabilityInput {
  health_ok: boolean;
  personal_ok?: boolean;
  latency_ms?: number;
  stale_ms?: number;
  pressure_level?: "ok" | "elevated" | "critical";
}

interface KernelReachabilityThresholds {
  live_latency_ms: number;
  degraded_latency_ms: number;
  stale_ms: number;
}

const DEFAULT_KERNEL_REACHABILITY_THRESHOLDS: KernelReachabilityThresholds = {
  live_latency_ms: 2_000,
  degraded_latency_ms: 8_000,
  stale_ms: 30_000,
};

function classifyKernelReachability(
  input: KernelReachabilityInput,
  thresholds: KernelReachabilityThresholds = DEFAULT_KERNEL_REACHABILITY_THRESHOLDS,
): KernelReachability {
  if (!input.health_ok) {
    return "offline";
  }
  if (input.personal_ok === false) {
    return "offline";
  }
  const latency = input.latency_ms ?? 0;
  const stale = input.stale_ms ?? 0;
  if (
    input.pressure_level === "critical" ||
    latency >= thresholds.degraded_latency_ms ||
    stale >= thresholds.stale_ms
  ) {
    return "degraded";
  }
  if (
    input.pressure_level === "elevated" ||
    latency >= thresholds.live_latency_ms ||
    input.personal_ok === undefined
  ) {
    return "degraded";
  }
  return "live";
}

export type ConnectionProbeResult = KernelReachabilityInput;

export function connectionReachability(
  probe: ConnectionProbeResult,
): KernelReachability {
  return classifyKernelReachability(probe);
}

export function shouldKeepStaleUi(reachability: KernelReachability): boolean {
  return reachability === "live" || reachability === "degraded";
}

export function connectionErrorForReachability(
  reachability: KernelReachability,
  origin: string,
  copy: {
    offline: (input: { origin: string }) => string;
    degraded: (input: { origin: string }) => string;
  },
): string | null {
  if (reachability === "offline") {
    return copy.offline({ origin });
  }
  if (reachability === "degraded") {
    return copy.degraded({ origin });
  }
  return null;
}
