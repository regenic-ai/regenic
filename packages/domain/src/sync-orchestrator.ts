import type { SyncCatalogMember, SyncStreamState, SyncWorkItem } from "./sync-contracts";
import { partitionMembersByLifecycle } from "./sync-lifecycle";
import {
  planBootstrapSyncWork,
  planSteadySyncWork,
  type SyncBootstrapScheduleInput,
  type SyncScheduleInput,
  type SyncSteadyScheduleInput,
} from "./sync-scheduler";
import { SyncLiveRing } from "./sync-ring";

export interface SyncTickPlan {
  bootstrap: SyncWorkItem[];
  steady: SyncWorkItem[];
  all: SyncWorkItem[];
}

export interface SyncTickPlanInput extends SyncScheduleInput {
  liveRing?: SyncLiveRing;
  bootstrapLimits?: SyncBootstrapScheduleInput["limits"];
  steadyLimits?: SyncSteadyScheduleInput["limits"];
}

export function planSyncTick(input: SyncTickPlanInput): SyncTickPlan {
  const { bootstrap, steady } = partitionMembersByLifecycle(
    input.members,
    input.states,
  );
  const bootstrapItems = planBootstrapSyncWork({
    members: bootstrap,
    states: input.states,
    preferredThreadId: input.preferredThreadId,
    humanIdle: input.humanIdle,
    catalogIncomplete: input.catalogIncomplete,
    rotateFrom: input.rotateFrom,
    rotateSeedFrom: input.rotateSeedFrom,
    now: input.now,
    pages: input.pages,
    limits: input.bootstrapLimits,
  });
  const steadyLimits = input.humanIdle
    ? input.steadyLimits
    : {
        ...input.steadyLimits,
        catalog: 0,
      };
  const steadyItems = planSteadySyncWork({
    members: steady,
    states: input.states,
    preferredThreadId: input.preferredThreadId,
    catalogIncomplete: input.catalogIncomplete,
    rotateFrom: input.rotateFrom,
    rotateSeedFrom: input.rotateSeedFrom,
    now: input.now,
    pages: input.pages,
    limits: steadyLimits,
    liveRing: input.liveRing,
  });
  return mergeSyncTickPlan(bootstrapItems, steadyItems);
}

export function mergeSyncTickPlan(
  bootstrap: readonly SyncWorkItem[],
  steady: readonly SyncWorkItem[],
): SyncTickPlan {
  const taken = new Set<string>();
  const all: SyncWorkItem[] = [];
  for (const item of [...bootstrap, ...steady]) {
    if (item.lane === "catalog") {
      all.push(item);
      continue;
    }
    if (taken.has(item.stream_key)) {
      continue;
    }
    taken.add(item.stream_key);
    all.push(item);
  }
  return { bootstrap: [...bootstrap], steady: [...steady], all };
}

export function statesMap(
  states: readonly SyncStreamState[],
): Map<string, SyncStreamState> {
  return new Map(states.map((state) => [state.stream_key, state] as const));
}

export function membersFromStates(
  states: readonly SyncStreamState[],
): SyncCatalogMember[] {
  return states.map((state) => ({
    installation_id: state.installation_id,
    stream_key: state.stream_key,
    generation: state.generation,
    discovered_at: state.updated_at,
    last_seen_at: state.updated_at,
  }));
}
