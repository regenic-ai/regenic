import type { SyncCatalogMember, SyncLaneLimits, SyncStreamState } from "./sync-contracts";
import { partitionMembersByLifecycle } from "./sync-lifecycle";

export const DEFAULT_STEADY_TARGET_IDLE_MS = 15_000;
export const MIN_STEADY_LIVE_PER_TICK = 32;
export const MAX_STEADY_LIVE_PER_TICK = 128;

export const DEFAULT_STEADY_LANE_LIMITS: SyncLaneLimits = {
  interactive: 1,
  live: 32,
  catalog: 0,
  history: 0,
  media: 4,
};

export function steadyLaneLimits(catalogIncomplete: boolean): SyncLaneLimits {
  return {
    ...DEFAULT_STEADY_LANE_LIMITS,
    catalog: catalogIncomplete ? 1 : 0,
  };
}

export interface SteadyCapacityInput {
  steadyCount: number;
  tickIntervalMs: number;
  targetIdleMs?: number;
  minLive?: number;
  maxLive?: number;
}

/** Live polls per steady tick needed to keep up with the target idle interval. */
export function steadyLiveLimit(input: SteadyCapacityInput): number {
  if (input.steadyCount <= 0) {
    return input.minLive ?? MIN_STEADY_LIVE_PER_TICK;
  }
  const tick = Math.max(1, input.tickIntervalMs);
  const targetIdle = Math.max(1, input.targetIdleMs ?? DEFAULT_STEADY_TARGET_IDLE_MS);
  const needed = Math.ceil((input.steadyCount * tick) / targetIdle);
  const min = input.minLive ?? MIN_STEADY_LIVE_PER_TICK;
  const max = input.maxLive ?? MAX_STEADY_LIVE_PER_TICK;
  return Math.min(max, Math.max(min, needed));
}

/** Stretch tail idle as steady fan-out grows so API load stays bounded. */
export function steadyTargetIdleMs(
  steadyCount: number,
  baseIdleMs = DEFAULT_STEADY_TARGET_IDLE_MS,
): number {
  if (steadyCount <= 64) {
    return baseIdleMs;
  }
  if (steadyCount <= 256) {
    return baseIdleMs * 2;
  }
  return baseIdleMs * 4;
}

export function steadyLaneLimitsForCount(input: {
  members: readonly SyncCatalogMember[];
  states: ReadonlyMap<string, SyncStreamState>;
  tickIntervalMs: number;
  catalogIncomplete: boolean;
  targetIdleMs?: number;
  maxLive?: number;
}): Partial<SyncLaneLimits> {
  const { steady } = partitionMembersByLifecycle(input.members, input.states);
  const targetIdle = input.targetIdleMs ?? steadyTargetIdleMs(steady.length);
  const base = steadyLaneLimits(input.catalogIncomplete);
  return {
    ...base,
    live: steadyLiveLimit({
      steadyCount: steady.length,
      tickIntervalMs: input.tickIntervalMs,
      targetIdleMs: targetIdle,
      maxLive: input.maxLive,
    }),
  };
}

export function steadyCapacityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { targetIdleMs: number; maxLive: number } {
  const targetRaw = Number(env.REGENIC_STEADY_TARGET_IDLE_MS ?? DEFAULT_STEADY_TARGET_IDLE_MS);
  const maxRaw = Number(env.REGENIC_STEADY_LIVE_MAX ?? MAX_STEADY_LIVE_PER_TICK);
  return {
    targetIdleMs:
      Number.isFinite(targetRaw) && targetRaw >= 1_000
        ? Math.floor(targetRaw)
        : DEFAULT_STEADY_TARGET_IDLE_MS,
    maxLive:
      Number.isFinite(maxRaw) && maxRaw >= MIN_STEADY_LIVE_PER_TICK
        ? Math.floor(maxRaw)
        : MAX_STEADY_LIVE_PER_TICK,
  };
}
