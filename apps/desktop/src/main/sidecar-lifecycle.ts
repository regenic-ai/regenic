/** 75% of the 2Gi API cgroup, same ratio as the DSH 3072Mi heap on 4Gi. */
export const API_OLD_SPACE_MB = 1536;
export const SIDECAR_RESTART_BASE_MS = 1_000;
export const SIDECAR_RESTART_MAX_MS = 15_000;
export const SIDECAR_STABLE_MS = 60_000;

export function nodeOptionsWithApiHeap(current: string | undefined): string {
  const flag = `--max-old-space-size=${API_OLD_SPACE_MB}`;
  if (current?.includes("--max-old-space-size")) return current;
  const trimmed = current?.trim();
  return trimmed ? `${trimmed} ${flag}` : flag;
}

export function sidecarRestartDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt));
  const scaled = SIDECAR_RESTART_BASE_MS * 2 ** Math.min(exponent, 4);
  return Math.min(SIDECAR_RESTART_MAX_MS, scaled);
}
