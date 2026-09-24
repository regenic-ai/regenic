import {
  SYNC_CATALOG_STREAM,
  UNSEEN_SEED_PER_TICK,
  type SyncCatalogMember,
  type SyncLane,
  type SyncStreamState,
} from "./sync-contracts";
import {
  addIdleMs,
  classifyDueWorkHeat,
  coldIdleMsForCatalogSize,
  DEFAULT_COLD_STREAM_IDLE_MS,
  nextDueAtForDueWork,
} from "./sync-idle";
import type { EnqueueSyncWork, SyncRunMode, SyncWorkIdentity } from "./sync-work";
import { syncWorkPriority } from "./sync-work";

export type DueWorkPlane = "steady" | "bootstrap";

export interface PlanDueSyncWorkInput {
  installation_id: string;
  members: readonly SyncCatalogMember[];
  states: ReadonlyMap<string, SyncStreamState>;
  now: string;
  plane: DueWorkPlane;
  preferredThreadId?: string | null;
  /** Full catalog size when `members` is an uncovered delta. */
  catalogSize?: number;
  coldIdleMs?: number;
  /** Unseeded streams due now besides the preferred thread. */
  firstSeedLimit?: number;
}

export function dueSyncWorkId(
  installationId: string,
  streamKey: string,
  lane: SyncLane,
  generation: number,
): string {
  return `due:${installationId}:${lane}:${generation}:${streamKey}`;
}

export function catalogDueWork(input: {
  installation_id: string;
  now: string;
  generation?: number;
  next_due_at?: string;
}): EnqueueSyncWork {
  const generation = input.generation ?? 1;
  return {
    id: dueSyncWorkId(
      input.installation_id,
      SYNC_CATALOG_STREAM,
      "catalog",
      generation,
    ),
    installation_id: input.installation_id,
    stream_key: SYNC_CATALOG_STREAM,
    lane: "catalog",
    priority: syncWorkPriority("catalog"),
    next_due_at: input.next_due_at ?? input.now,
    generation,
    now: input.now,
  };
}

export function needsCatalogDueWork(view: {
  members: readonly Pick<SyncCatalogMember, "stream_key">[];
  catalog?: { complete: boolean } | null;
}): boolean {
  const streamMembers = view.members.filter(
    (member) => member.stream_key && member.stream_key !== SYNC_CATALOG_STREAM,
  );
  return (
    streamMembers.length === 0 ||
    view.catalog == null ||
    view.catalog.complete !== true
  );
}

/** Lanes that mean this plane already has durable work and must not re-plan. */
export function dueWorkCoverageLanes(plane: DueWorkPlane): SyncLane[] {
  return plane === "bootstrap"
    ? ["history"]
    : ["interactive", "live", "media"];
}

export function syncWorkCoverageKey(
  streamKey: string,
  generation: number,
): string {
  return `${generation}:${streamKey}`;
}

/**
 * Members that do not yet have an unassigned work row at this generation.
 * Catalog refresh uses this so already-scheduled streams keep their due time.
 */
export function uncoveredCatalogMembers(
  members: readonly SyncCatalogMember[],
  existing: readonly Pick<SyncWorkIdentity, "stream_key" | "generation">[],
): SyncCatalogMember[] {
  const covered = new Set(
    existing
      .filter(
        (item) =>
          item.stream_key && item.stream_key !== SYNC_CATALOG_STREAM,
      )
      .map((item) => syncWorkCoverageKey(item.stream_key, item.generation)),
  );
  return members.filter((member) => {
    if (!member.stream_key || member.stream_key === SYNC_CATALOG_STREAM) {
      return false;
    }
    return !covered.has(
      syncWorkCoverageKey(member.stream_key, member.generation || 1),
    );
  });
}

/**
 * Turns catalog members + stored phases into durable due-work rows.
 * The hot tick should claim these by index, not rescan every member.
 */
export function planDueSyncWork(
  input: PlanDueSyncWorkInput,
): EnqueueSyncWork[] {
  const preferred = input.preferredThreadId?.trim() || null;
  const coldIdleMs = coldIdleMsForCatalogSize(
    input.catalogSize ?? input.members.length,
    input.coldIdleMs ?? DEFAULT_COLD_STREAM_IDLE_MS,
  );
  const firstSeedKeys = selectFirstSeedKeys({
    members: input.members,
    states: input.states,
    preferredThreadId: preferred,
    limit: input.firstSeedLimit,
  });
  const coldUnseededIndex = coldUnseededIndexByKey({
    plane: input.plane,
    members: input.members,
    states: input.states,
    preferredThreadId: preferred,
    firstSeedKeys,
  });
  const planned: EnqueueSyncWork[] = [];
  for (const member of input.members) {
    if (!member.stream_key || member.stream_key === SYNC_CATALOG_STREAM) {
      continue;
    }
    const state = input.states.get(member.stream_key);
    const lane = dueWorkLane({
      plane: input.plane,
      member,
      state,
      preferredThreadId: preferred,
    });
    if (!lane) {
      continue;
    }
    const generation = member.generation || state?.generation || 1;
    const heat = classifyDueWorkHeat({
      preferred: lane === "interactive",
      eager: dueWorkIsEager({
        plane: input.plane,
        state,
        streamKey: member.stream_key,
        firstSeedKeys,
      }),
    });
    const stagger = coldUnseededIndex.get(member.stream_key);
    planned.push({
      id: dueSyncWorkId(
        input.installation_id,
        member.stream_key,
        lane,
        generation,
      ),
      installation_id: input.installation_id,
      stream_key: member.stream_key,
      lane,
      priority: syncWorkPriority(lane),
      next_due_at:
        stagger != null
          ? addIdleMs(
              input.now,
              firstSeedStaggerDelayMs({
                index: stagger.index,
                count: stagger.count,
                windowMs: coldIdleMs,
              }),
            )
          : nextDueAtForDueWork({
              now: input.now,
              idleUntil: state?.idle_until,
              heat,
              coldIdleMs,
            }),
      generation,
      now: input.now,
    });
  }
  return planned.sort(
    (left, right) =>
      (right.priority ?? 0) - (left.priority ?? 0) ||
      left.next_due_at.localeCompare(right.next_due_at) ||
      left.stream_key.localeCompare(right.stream_key),
  );
}

export function firstSeedHeadLimit(limit?: number): number {
  if (limit == null || !Number.isFinite(limit)) {
    return UNSEEN_SEED_PER_TICK;
  }
  return Math.max(0, Math.min(64, Math.floor(limit)));
}

export function firstSeedHeadFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = Number(env.REGENIC_SYNC_FIRST_SEED_HEAD ?? UNSEEN_SEED_PER_TICK);
  if (!Number.isFinite(raw)) {
    return UNSEEN_SEED_PER_TICK;
  }
  return firstSeedHeadLimit(raw);
}

/** Preferred thread is excluded; it is already due now on the interactive lane. */
export function selectFirstSeedKeys(input: {
  members: readonly SyncCatalogMember[];
  states: ReadonlyMap<string, SyncStreamState>;
  preferredThreadId?: string | null;
  limit?: number;
}): Set<string> {
  const limit = firstSeedHeadLimit(input.limit);
  if (limit <= 0) {
    return new Set();
  }
  const preferred = input.preferredThreadId?.trim() || null;
  const ranked = input.members
    .filter((member) => isFirstSeedCandidate(member, input.states, preferred))
    .sort(compareFirstSeedMembers);
  return new Set(ranked.slice(0, limit).map((member) => member.stream_key));
}

/** Spread leftover unseeded work across the cold window instead of one due-now flood. */
export function firstSeedStaggerDelayMs(input: {
  index: number;
  count: number;
  windowMs: number;
}): number {
  const count = Math.max(1, Math.floor(input.count));
  const windowMs = Math.max(1, Math.floor(input.windowMs));
  const index = Math.max(0, Math.min(Math.floor(input.index), count - 1));
  return Math.max(1, Math.floor(((index + 1) / count) * windowMs));
}

export function syncRunWorkPlane(mode: SyncRunMode): DueWorkPlane {
  return mode === "continuous" ? "steady" : "bootstrap";
}

export function syncRunWorkLanes(mode: SyncRunMode): SyncLane[] {
  if (mode === "archive") {
    return ["interactive", "live", "catalog", "history"];
  }
  if (mode === "continuous") {
    return ["interactive", "live", "catalog", "media"];
  }
  return ["interactive", "live", "catalog"];
}

/**
 * Streams a user SyncRun should pull now. Continuous only claims already-due
 * work. Quick start / archive wake the open thread plus a recent head.
 */
export function selectSyncRunWakeKeys(input: {
  mode: SyncRunMode;
  members: readonly SyncCatalogMember[];
  preferredThreadId?: string | null;
  streamKeys?: readonly string[];
  limit?: number;
}): string[] {
  if (input.streamKeys?.length) {
    return [
      ...new Set(
        input.streamKeys
          .map((key) => key.trim())
          .filter((key) => key && key !== SYNC_CATALOG_STREAM),
      ),
    ];
  }
  if (input.mode === "continuous") {
    return [];
  }
  return selectQuickStartStreamKeys({
    members: input.members,
    preferredThreadId: input.preferredThreadId,
    limit: input.limit,
  });
}

export function selectQuickStartStreamKeys(input: {
  members: readonly SyncCatalogMember[];
  preferredThreadId?: string | null;
  limit?: number;
}): string[] {
  const limit = firstSeedHeadLimit(input.limit);
  const preferred = input.preferredThreadId?.trim() || null;
  const selected: string[] = [];
  const seen = new Set<string>();
  const take = (key?: string): void => {
    if (!key || key === SYNC_CATALOG_STREAM || seen.has(key)) {
      return;
    }
    seen.add(key);
    selected.push(key);
  };
  if (preferred) {
    for (const member of input.members) {
      if (member.thread_id === preferred) {
        take(member.stream_key);
      }
    }
  }
  const ranked = input.members
    .filter(
      (member) =>
        Boolean(member.stream_key) && member.stream_key !== SYNC_CATALOG_STREAM,
    )
    .sort(compareFirstSeedMembers);
  let remaining = limit;
  for (const member of ranked) {
    if (remaining <= 0) {
      break;
    }
    if (seen.has(member.stream_key)) {
      continue;
    }
    take(member.stream_key);
    remaining -= 1;
  }
  return selected;
}

function dueWorkLane(input: {
  plane: DueWorkPlane;
  member: SyncCatalogMember;
  state?: SyncStreamState;
  preferredThreadId: string | null;
}): SyncLane | null {
  const phase = input.state?.phase ?? "unseeded";
  const preferred =
    Boolean(input.preferredThreadId) &&
    input.member.thread_id === input.preferredThreadId;
  if (input.plane === "steady") {
    if (input.state?.media_pending) {
      return preferred ? "interactive" : "media";
    }
    if (phase === "history") {
      return null;
    }
    return preferred ? "interactive" : "live";
  }
  if (phase === "history" || phase === "unseeded") {
    return preferred ? "interactive" : phase === "unseeded" ? "live" : "history";
  }
  return null;
}

function dueWorkIsEager(input: {
  plane: DueWorkPlane;
  state?: SyncStreamState;
  streamKey: string;
  firstSeedKeys: ReadonlySet<string>;
}): boolean {
  const phase = input.state?.phase ?? "unseeded";
  if (input.state?.media_pending) {
    return true;
  }
  if (phase === "unseeded") {
    return input.firstSeedKeys.has(input.streamKey);
  }
  return input.plane === "bootstrap" && phase === "history";
}

function isFirstSeedCandidate(
  member: SyncCatalogMember,
  states: ReadonlyMap<string, SyncStreamState>,
  preferredThreadId: string | null,
): boolean {
  if (!member.stream_key || member.stream_key === SYNC_CATALOG_STREAM) {
    return false;
  }
  if (preferredThreadId && member.thread_id === preferredThreadId) {
    return false;
  }
  const state = states.get(member.stream_key);
  if (state?.media_pending) {
    return false;
  }
  return (state?.phase ?? "unseeded") === "unseeded";
}

function compareFirstSeedMembers(
  left: SyncCatalogMember,
  right: SyncCatalogMember,
): number {
  const seen = (right.last_seen_at || "").localeCompare(left.last_seen_at || "");
  if (seen !== 0) {
    return seen;
  }
  const discovered = (right.discovered_at || "").localeCompare(
    left.discovered_at || "",
  );
  if (discovered !== 0) {
    return discovered;
  }
  return left.stream_key.localeCompare(right.stream_key);
}

function coldUnseededIndexByKey(input: {
  plane: DueWorkPlane;
  members: readonly SyncCatalogMember[];
  states: ReadonlyMap<string, SyncStreamState>;
  preferredThreadId: string | null;
  firstSeedKeys: ReadonlySet<string>;
}): Map<string, { index: number; count: number }> {
  const keys = input.members
    .filter((member) => {
      if (!isFirstSeedCandidate(member, input.states, input.preferredThreadId)) {
        return false;
      }
      if (input.firstSeedKeys.has(member.stream_key)) {
        return false;
      }
      return (
        dueWorkLane({
          plane: input.plane,
          member,
          state: input.states.get(member.stream_key),
          preferredThreadId: input.preferredThreadId,
        }) != null
      );
    })
    .map((member) => member.stream_key)
    .sort((left, right) => left.localeCompare(right));
  const count = keys.length;
  return new Map(keys.map((key, index) => [key, { index, count }]));
}
