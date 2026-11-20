export const SIDECAR_RESTART_BASE_MS = 1_000;
export const SIDECAR_RESTART_MAX_MS = 15_000;
export const SIDECAR_STABLE_MS = 60_000;

export function sidecarRestartDelayMs(attempt: number): number {
  const exponent = Math.max(0, Math.floor(attempt));
  const scaled = SIDECAR_RESTART_BASE_MS * 2 ** Math.min(exponent, 4);
  return Math.min(SIDECAR_RESTART_MAX_MS, scaled);
}
