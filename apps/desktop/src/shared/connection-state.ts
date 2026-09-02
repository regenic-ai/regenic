import {
  classifyKernelReachability,
  type KernelReachability,
  type KernelReachabilityInput,
} from "@regenic/domain/kernel-reachability";

export type { KernelReachability, KernelReachabilityInput };

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
