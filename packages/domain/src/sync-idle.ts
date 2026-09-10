/**
 * Core-owned stream idle tiers. Connectors may hint via `pace.idle_ms`;
 * they must not encode active/inactive — Core classifies from thread focus.
 */

/** After an empty poll on the open / preferred thread. */
export const DEFAULT_ACTIVE_STREAM_IDLE_MS = 15_000;
/** After an empty poll on background streams. */
export const DEFAULT_INACTIVE_STREAM_IDLE_MS = 180_000;

export function pacedStreamIdleMs(input: {
  active: boolean;
  /** Generic connector hint (`pace.idle_ms`); optional. */
  hintMs?: number;
  activeIdleMs?: number;
  inactiveIdleMs?: number;
}): number {
  const activeFloor = Math.max(
    1_000,
    input.activeIdleMs ?? DEFAULT_ACTIVE_STREAM_IDLE_MS,
  );
  const inactiveFloor = Math.max(
    activeFloor,
    input.inactiveIdleMs ?? DEFAULT_INACTIVE_STREAM_IDLE_MS,
  );
  const hint =
    typeof input.hintMs === "number" &&
    Number.isFinite(input.hintMs) &&
    input.hintMs >= 1
      ? Math.floor(input.hintMs)
      : undefined;
  if (input.active) {
    return hint != null ? Math.max(activeFloor, hint) : activeFloor;
  }
  const fromHint = hint != null ? hint * 4 : inactiveFloor;
  return Math.max(inactiveFloor, fromHint);
}

export function streamIdleTiersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { activeIdleMs: number; inactiveIdleMs: number } {
  return {
    activeIdleMs: clampIdleEnv(
      env.REGENIC_ACTIVE_STREAM_IDLE_MS,
      DEFAULT_ACTIVE_STREAM_IDLE_MS,
      5_000,
      60_000,
    ),
    inactiveIdleMs: clampIdleEnv(
      env.REGENIC_INACTIVE_STREAM_IDLE_MS,
      DEFAULT_INACTIVE_STREAM_IDLE_MS,
      30_000,
      600_000,
    ),
  };
}

function clampIdleEnv(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(min, Math.min(Math.floor(value), max));
}
