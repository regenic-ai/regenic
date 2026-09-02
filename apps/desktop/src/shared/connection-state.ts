/** Mirrors @regenic/domain/kernel-reachability for the desktop bundle. */
export type KernelReachability = "live" | "degraded" | "offline";

export interface ConnectionProbeResult {
  health_ok: boolean;
  personal_ok?: boolean;
  latency_ms?: number;
  stale_ms?: number;
  pressure_level?: "ok" | "elevated" | "critical";
}

const LIVE_LATENCY_MS = 2_000;
const DEGRADED_LATENCY_MS = 8_000;
const STALE_MS = 30_000;

export function connectionReachability(
  probe: ConnectionProbeResult,
): KernelReachability {
  if (!probe.health_ok || probe.personal_ok === false) {
    return "offline";
  }
  const latency = probe.latency_ms ?? 0;
  const stale = probe.stale_ms ?? 0;
  if (
    probe.pressure_level === "critical" ||
    latency >= DEGRADED_LATENCY_MS ||
    stale >= STALE_MS
  ) {
    return "degraded";
  }
  if (
    probe.pressure_level === "elevated" ||
    latency >= LIVE_LATENCY_MS ||
    probe.personal_ok === undefined
  ) {
    return "degraded";
  }
  return "live";
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
