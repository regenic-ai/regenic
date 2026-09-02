import type { SyncCatalogMember, SyncPhase, SyncStreamState } from "./sync-contracts";

/** One-time recent+history catch-up vs ongoing live tail only. */
export type SyncLifecycleMode = "bootstrap" | "steady";

export function syncLifecycleMode(phase: SyncPhase | undefined): SyncLifecycleMode {
  if (!phase || phase === "unseeded" || phase === "history") {
    return "bootstrap";
  }
  return "steady";
}

export function isBootstrapPhase(phase: SyncPhase | undefined): boolean {
  return syncLifecycleMode(phase) === "bootstrap";
}

export function isSteadyPhase(phase: SyncPhase | undefined): boolean {
  return syncLifecycleMode(phase) === "steady";
}

/** Bootstrap finished; stream is on live/steady tail only. */
export function isSyncComplete(phase: SyncPhase | undefined): boolean {
  return isSteadyPhase(phase);
}

export interface SyncLifecycleProgress {
  discovered: number;
  bootstrap_pending: number;
  steady: number;
  unseeded: number;
  history_backfill: number;
  media_pending: number;
}

export function summarizeSyncLifecycle(
  members: readonly SyncCatalogMember[],
  states: ReadonlyMap<string, SyncStreamState>,
): SyncLifecycleProgress {
  let bootstrapPending = 0;
  let steady = 0;
  let unseeded = 0;
  let historyBackfill = 0;
  let mediaPending = 0;
  for (const member of members) {
    const state = states.get(member.stream_key);
    const phase = state?.phase;
    if (!phase || phase === "unseeded") {
      bootstrapPending += 1;
      unseeded += 1;
    } else if (phase === "history") {
      bootstrapPending += 1;
      historyBackfill += 1;
    } else {
      steady += 1;
    }
    if (state?.media_pending) {
      mediaPending += 1;
    }
  }
  return {
    discovered: members.length,
    bootstrap_pending: bootstrapPending,
    steady,
    unseeded,
    history_backfill: historyBackfill,
    media_pending: mediaPending,
  };
}

export function partitionMembersByLifecycle(
  members: readonly SyncCatalogMember[],
  states: ReadonlyMap<string, SyncStreamState>,
): {
  bootstrap: SyncCatalogMember[];
  steady: SyncCatalogMember[];
} {
  const bootstrap: SyncCatalogMember[] = [];
  const steady: SyncCatalogMember[] = [];
  for (const member of members) {
    if (isBootstrapPhase(states.get(member.stream_key)?.phase)) {
      bootstrap.push(member);
    } else {
      steady.push(member);
    }
  }
  return { bootstrap, steady };
}
