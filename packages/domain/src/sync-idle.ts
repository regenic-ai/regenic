/**
 * Core-owned stream idle tiers. Connectors may hint via `pace.idle_ms`;
 * they must not encode active/inactive — Core classifies from thread focus.
 *
 * No hint ⇒ caller should leave idle unset (every tick). DSH omits `pace`;
 * Feishu declares `idle_ms` and gets active/inactive floors.
 *
 * Due-work heat is not a new lane: interactive/hot/cold share live (or
 * interactive) work and differ only in `next_due_at` / `idle_ms`.
 */

/** After an empty poll on the open / preferred thread. */
export const DEFAULT_ACTIVE_STREAM_IDLE_MS = 15_000;
/** After an empty poll on background streams (legacy fat-tick path). */
export const DEFAULT_INACTIVE_STREAM_IDLE_MS = 180_000;
/** After a webhook-woken or recently accepted background poll. */
export const DEFAULT_HOT_STREAM_IDLE_MS = 60_000;
/** After an empty poll on a cold background stream, and first plan without idle. */
export const DEFAULT_COLD_STREAM_IDLE_MS = 3_600_000;
export const MIN_COLD_STREAM_IDLE_MS = 1_800_000;
export const MAX_COLD_STREAM_IDLE_MS = 14_400_000;

export type DueWorkHeat = "interactive" | "hot" | "cold";

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
  const hint = positiveIdleMs(input.hintMs);
  if (input.active) {
    return hint != null ? Math.max(activeFloor, hint) : activeFloor;
  }
  const fromHint = hint != null ? hint * 4 : inactiveFloor;
  return Math.max(inactiveFloor, fromHint);
}

/**
 * Preferred thread stays interactive. First seed, media catch-up, and
 * recently accepted polls stay hot. Everything else is cold.
 */
export function classifyDueWorkHeat(input: {
  preferred: boolean;
  acceptedCount?: number;
  eager?: boolean;
}): DueWorkHeat {
  if (input.preferred) {
    return "interactive";
  }
  if ((input.acceptedCount ?? 0) > 0 || input.eager) {
    return "hot";
  }
  return "cold";
}

export function dueWorkIdleMs(input: {
  heat: DueWorkHeat;
  hintMs?: number;
  activeIdleMs?: number;
  hotIdleMs?: number;
  coldIdleMs?: number;
}): number {
  const hint = positiveIdleMs(input.hintMs);
  if (input.heat === "interactive") {
    return pacedStreamIdleMs({
      active: true,
      hintMs: hint,
      activeIdleMs: input.activeIdleMs,
      inactiveIdleMs: input.hotIdleMs ?? DEFAULT_HOT_STREAM_IDLE_MS,
    });
  }
  if (input.heat === "hot") {
    const floor = Math.max(1_000, input.hotIdleMs ?? DEFAULT_HOT_STREAM_IDLE_MS);
    return hint != null ? Math.max(floor, hint) : floor;
  }
  const floor = Math.max(
    MIN_COLD_STREAM_IDLE_MS,
    input.coldIdleMs ?? DEFAULT_COLD_STREAM_IDLE_MS,
  );
  const fromHint = hint != null ? hint * 4 : floor;
  return Math.max(floor, fromHint);
}

export function nextDueAtForDueWork(input: {
  now: string;
  idleUntil?: string;
  heat: DueWorkHeat;
  coldIdleMs?: number;
}): string {
  if (input.heat === "interactive" || input.heat === "hot") {
    return input.now;
  }
  if (input.idleUntil && input.idleUntil > input.now) {
    return input.idleUntil;
  }
  return addIdleMs(input.now, input.coldIdleMs ?? DEFAULT_COLD_STREAM_IDLE_MS);
}

/** Stretch cold idle as catalog fan-out grows so minute-level live queues cannot form. */
export function coldIdleMsForCatalogSize(
  catalogSize: number,
  baseIdleMs = DEFAULT_COLD_STREAM_IDLE_MS,
  maxIdleMs = MAX_COLD_STREAM_IDLE_MS,
): number {
  const base = Math.max(
    MIN_COLD_STREAM_IDLE_MS,
    Math.min(Math.floor(baseIdleMs), maxIdleMs),
  );
  if (!Number.isFinite(catalogSize) || catalogSize <= 256) {
    return base;
  }
  if (catalogSize <= 1_024) {
    return Math.min(maxIdleMs, Math.floor(base * 1.5));
  }
  if (catalogSize <= 4_096) {
    return Math.min(maxIdleMs, base * 2);
  }
  return maxIdleMs;
}

export function addIdleMs(now: string, idleMs: number): string {
  const parsed = Date.parse(now);
  if (!Number.isFinite(parsed) || !Number.isFinite(idleMs) || idleMs <= 0) {
    return now;
  }
  return new Date(parsed + Math.floor(idleMs)).toISOString();
}

export function streamIdleTiersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): {
  activeIdleMs: number;
  inactiveIdleMs: number;
  hotIdleMs: number;
  coldIdleMs: number;
} {
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
    hotIdleMs: clampIdleEnv(
      env.REGENIC_HOT_STREAM_IDLE_MS,
      DEFAULT_HOT_STREAM_IDLE_MS,
      15_000,
      180_000,
    ),
    coldIdleMs: clampIdleEnv(
      env.REGENIC_COLD_STREAM_IDLE_MS,
      DEFAULT_COLD_STREAM_IDLE_MS,
      MIN_COLD_STREAM_IDLE_MS,
      MAX_COLD_STREAM_IDLE_MS,
    ),
  };
}

function positiveIdleMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
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
