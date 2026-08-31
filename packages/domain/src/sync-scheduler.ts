import type {
  SyncCatalogMember,
  SyncLaneLimits,
  SyncStreamState,
  SyncWorkItem,
} from "./sync-contracts";
import { SYNC_CATALOG_STREAM, UNSEEN_SEED_PER_TICK } from "./sync-contracts";
import { syncStateIsDue } from "./sync-phase";

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
    return !phase || phase === "unseeded" || phase === "history";
  });
  const live = rest.filter((member) => {
    const phase = states.get(member.stream_key)?.phase;
    return phase === "live" || phase === "steady";
  });
  return [...catchingUp, ...live];
}
