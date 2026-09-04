import type {
  SyncCatalogMember,
  SyncLaneLimits,
  SyncStreamState,
  SyncWorkItem,
} from "./sync-contracts";
import { SYNC_CATALOG_STREAM, UNSEEN_SEED_PER_TICK } from "./sync-contracts";
import { partitionMembersByLifecycle } from "./sync-lifecycle";
import { SyncLiveRing } from "./sync-ring";
import { syncStateIsDue } from "./sync-phase";
import { steadyLaneLimits } from "./sync-steady-capacity";

export { DEFAULT_STEADY_LANE_LIMITS, steadyLaneLimits } from "./sync-steady-capacity";

export const DEFAULT_BOOTSTRAP_LANE_LIMITS: SyncLaneLimits = {
  interactive: 1,
  live: 16,
  catalog: 1,
  history: 32,
  media: 2,
};

/** Open-thread freshness only. Fleet history/seed wait until the human is idle. */
export const HUMAN_PRESENT_BOOTSTRAP_LIMITS: SyncLaneLimits = {
  interactive: 1,
  live: 0,
  catalog: 0,
  history: 0,
  media: 0,
};

export const HUMAN_PRESENT_STEADY_LIVE = 2;

export function syncLaneLimits(
  humanIdle: boolean,
  catalogIncomplete: boolean,
): SyncLaneLimits {
  if (humanIdle) {
    return {
      interactive: 1,
      live: 1,
      catalog: catalogIncomplete ? 1 : 0,
      history: 2,
      media: 2,
    };
  }
  return {
    interactive: 1,
    live: 2,
    catalog: catalogIncomplete ? 1 : 0,
    history: 0,
    media: 1,
  };
}

export function bootstrapWorkerLaneLimits(
  catalogIncomplete: boolean,
): SyncLaneLimits {
  return {
    ...DEFAULT_BOOTSTRAP_LANE_LIMITS,
    catalog: catalogIncomplete ? DEFAULT_BOOTSTRAP_LANE_LIMITS.catalog : 0,
  };
}

export interface SyncScheduleInput {
  members: readonly SyncCatalogMember[];
  states: ReadonlyMap<string, SyncStreamState>;
  preferredThreadId?: string | null;
  humanIdle: boolean;
  catalogIncomplete: boolean;
  rotateFrom?: string;
  rotateSeedFrom?: string;
  now: string;
  limits?: Partial<SyncLaneLimits>;
  pages?: number;
}

export interface SyncBootstrapScheduleInput
  extends Omit<SyncScheduleInput, "humanIdle" | "limits"> {
  limits?: Partial<SyncLaneLimits>;
  /** Default true (catch-up worker). False = open-thread head only. */
  humanIdle?: boolean;
}

export interface SyncSteadyScheduleInput
  extends Omit<SyncScheduleInput, "humanIdle" | "limits"> {
  limits?: Partial<SyncLaneLimits>;
  liveRing?: SyncLiveRing;
}

/** Plans one-time recent seed + history backfill work only. */
export function planBootstrapSyncWork(
  input: SyncBootstrapScheduleInput,
): SyncWorkItem[] {
  const { bootstrap } = partitionMembersByLifecycle(input.members, input.states);
  const humanIdle = input.humanIdle !== false;
  return planSyncWork({
    ...input,
    members: bootstrap,
    humanIdle,
    limits: humanIdle
      ? {
          ...bootstrapWorkerLaneLimits(input.catalogIncomplete),
          ...input.limits,
          history:
            input.limits?.history ??
            bootstrapWorkerLaneLimits(input.catalogIncomplete).history,
        }
      : {
          ...HUMAN_PRESENT_BOOTSTRAP_LIMITS,
          ...input.limits,
          live: 0,
          history: 0,
          catalog: 0,
        },
  });
}

/** Plans ongoing live/media polls; never schedules history. */
export function planSteadySyncWork(input: SyncSteadyScheduleInput): SyncWorkItem[] {
  const limits = {
    ...steadyLaneLimits(input.catalogIncomplete),
    ...input.limits,
    history: 0,
  };
  const pages = input.pages ?? 1;
  const preferredId = input.preferredThreadId?.trim() || null;
  const preferred = preferredId
    ? input.members.find((member) => member.thread_id === preferredId)
    : undefined;
  const planned: SyncWorkItem[] = [];
  const taken = new Set<string>();

  if (preferred && limits.interactive > 0) {
    planned.push({
      lane: "interactive",
      stream_key: preferred.stream_key,
      thread_id: preferred.thread_id,
      older: false,
      media: false,
      pages,
    });
    taken.add(preferred.stream_key);
  }

  const ring = input.liveRing ?? new SyncLiveRing();
  ring.adoptRotateFrom(input.rotateFrom, input.members);
  const liveMembers = ring.nextDue(
    input.members,
    input.states,
    input.now,
    Math.max(0, limits.live),
    taken,
  );
  for (const member of liveMembers) {
    planned.push({
      lane: "live",
      stream_key: member.stream_key,
      thread_id: member.thread_id,
      older: false,
      media: false,
      pages,
    });
    taken.add(member.stream_key);
  }

  if (limits.catalog > 0 && input.catalogIncomplete) {
    planned.push({
      lane: "catalog",
      stream_key: SYNC_CATALOG_STREAM,
      older: false,
      media: false,
      pages: 1,
    });
  }

  if (limits.media > 0) {
    const pending = input.members.filter(
      (member) => input.states.get(member.stream_key)?.media_pending === true,
    );
    const mediaPool = [
      ...pending.filter((member) => member.thread_id === preferredId),
      ...pending.filter((member) => member.thread_id !== preferredId),
    ];
    for (const member of mediaPool.slice(0, limits.media)) {
      planned.push({
        lane: "media",
        stream_key: member.stream_key,
        thread_id: member.thread_id,
        older: false,
        media: true,
        pages: 1,
      });
    }
  }

  return planned;
}

export function planSyncWork(input: SyncScheduleInput): SyncWorkItem[] {
  const limits = {
    ...syncLaneLimits(input.humanIdle, input.catalogIncomplete),
    ...input.limits,
  };
  const pages = input.pages ?? 1;
  const preferredId = input.preferredThreadId?.trim() || null;
  const preferred = preferredId
    ? input.members.find((member) => member.thread_id === preferredId)
    : undefined;
  const planned: SyncWorkItem[] = [];
  const taken = new Set<string>();

  if (preferred && limits.interactive > 0) {
    planned.push({
      lane: "interactive",
      stream_key: preferred.stream_key,
      thread_id: preferred.thread_id,
      older: false,
      media: false,
      pages,
    });
    taken.add(preferred.stream_key);
  }

  const livePool = rankLiveMembers(input.members, input.states, preferredId);
  const unseen = livePool.filter((member) => {
    const state = input.states.get(member.stream_key);
    return !state || state.phase === "unseeded";
  });
  const seeds = rotateFromKey(unseen, input.rotateSeedFrom ?? input.rotateFrom).slice(
    0,
    UNSEEN_SEED_PER_TICK,
  );
  const liveRest = [
    ...seeds,
    ...livePool.filter(
      (member) => !seeds.some((seed) => seed.stream_key === member.stream_key),
    ),
  ].filter(
    (member) =>
      !taken.has(member.stream_key) &&
      syncStateIsDue(input.states.get(member.stream_key), input.now, false),
  );
  for (const member of liveRest.slice(0, Math.max(0, limits.live))) {
    planned.push({
      lane: "live",
      stream_key: member.stream_key,
      thread_id: member.thread_id,
      older: false,
      media: false,
      pages,
    });
    taken.add(member.stream_key);
  }

  if (limits.catalog > 0 && input.catalogIncomplete) {
    planned.push({
      lane: "catalog",
      stream_key: SYNC_CATALOG_STREAM,
      older: false,
      media: false,
      pages: 1,
    });
  }

  const historyPool = rotateFromKey(
    input.members.filter((member) => {
      if (taken.has(member.stream_key) || member.thread_id === preferredId) {
        return false;
      }
      const state = input.states.get(member.stream_key);
      return state?.phase === "history";
    }),
    input.rotateFrom,
  );
  for (const member of historyPool.slice(0, Math.max(0, limits.history))) {
    planned.push({
      lane: "history",
      stream_key: member.stream_key,
      thread_id: member.thread_id,
      older: true,
      media: false,
      pages,
    });
    taken.add(member.stream_key);
  }

  if (limits.media > 0) {
    const pending = input.members.filter(
      (member) => input.states.get(member.stream_key)?.media_pending === true,
    );
    // Text may already have claimed a stream this tick; media still runs
    // after text releases the stream lock.
    const mediaPool = [
      ...pending.filter((member) => member.thread_id === preferredId),
      ...pending.filter((member) => member.thread_id !== preferredId),
    ];
    for (const member of mediaPool.slice(0, limits.media)) {
      planned.push({
        lane: "media",
        stream_key: member.stream_key,
        thread_id: member.thread_id,
        older: false,
        media: true,
        pages: 1,
      });
    }
  }

  return planned;
}

export function lastHistoryWorkKey(
  items: readonly SyncWorkItem[],
): string | undefined {
  return [...items].reverse().find((item) => item.lane === "history")?.stream_key;
}

export function lastSeedWorkKey(
  items: readonly SyncWorkItem[],
): string | undefined {
  return [...items]
    .reverse()
    .find((item) => item.lane === "live" || item.lane === "interactive")
    ?.stream_key;
}

export function rotateFromKey<T extends { stream_key?: string; key?: string }>(
  items: readonly T[],
  from?: string,
): T[] {
  if (!from || items.length === 0) {
    return [...items];
  }
  const index = items.findIndex(
    (item) => item.stream_key === from || item.key === from,
  );
  if (index < 0) {
    return [...items];
  }
  const start = (index + 1) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

function rankLiveMembers(
  members: readonly SyncCatalogMember[],
  states: ReadonlyMap<string, SyncStreamState>,
  preferredId: string | null,
): SyncCatalogMember[] {
  const rest = members.filter((member) => member.thread_id !== preferredId);
  const catchingUp = rest.filter((member) => {
    const phase = states.get(member.stream_key)?.phase;
    return !phase || phase === "unseeded";
  });
  const live = rest.filter((member) => {
    const phase = states.get(member.stream_key)?.phase;
    return phase === "live" || phase === "steady";
  });
  return [...catchingUp, ...live];
}
