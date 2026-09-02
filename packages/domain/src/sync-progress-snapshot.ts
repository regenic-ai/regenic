import type { SyncCatalogMember, SyncStreamState } from "./sync-contracts";
import {
  emptySyncProgress,
  scopeSyncCatalogMembers,
  type SyncProgressView,
} from "./sync-progress";

/** Aggregated sync counters without loading full member rows on read paths. */
export interface SyncProgressCounts {
  catalog_members: number;
  catalog_complete: boolean;
  unseeded: number;
  seeded: number;
  backfilling: number;
  media_pending: number;
}

export interface SyncProgressSnapshot {
  installation_id: string;
  updated_at: string;
  counts: SyncProgressCounts;
  progress: SyncProgressView;
}

export function emptySyncProgressCounts(): SyncProgressCounts {
  return {
    catalog_members: 0,
    catalog_complete: false,
    unseeded: 0,
    seeded: 0,
    backfilling: 0,
    media_pending: 0,
  };
}

export function syncProgressViewFromCounts(
  counts: SyncProgressCounts,
): SyncProgressView {
  return {
    discovered: counts.catalog_members,
    seeded: counts.seeded,
    unseeded: counts.unseeded,
    backfilling: counts.backfilling,
    media_pending: counts.media_pending,
    catalog_complete: counts.catalog_complete,
  };
}

export function countSyncProgress(
  members: readonly SyncCatalogMember[],
  states: readonly SyncStreamState[],
  catalogComplete: boolean,
): SyncProgressCounts {
  const byKey = new Map(states.map((state) => [state.stream_key, state]));
  let seeded = 0;
  let unseeded = 0;
  let backfilling = 0;
  let mediaPending = 0;
  for (const member of members) {
    const state = byKey.get(member.stream_key);
    if (!state || state.phase === "unseeded") {
      unseeded += 1;
    } else {
      seeded += 1;
    }
    if (state?.phase === "history") {
      backfilling += 1;
    }
    if (state?.media_pending) {
      mediaPending += 1;
    }
  }
  return {
    catalog_members: members.length,
    catalog_complete: catalogComplete,
    unseeded,
    seeded,
    backfilling,
    media_pending: mediaPending,
  };
}

export function buildSyncProgressSnapshot(input: {
  installation_id: string;
  members: readonly SyncCatalogMember[];
  states: readonly SyncStreamState[];
  catalog_complete: boolean;
  mountedStreamKeys?: ReadonlySet<string>;
  fallbackMembers?: readonly SyncCatalogMember[];
  now?: () => string;
}): SyncProgressSnapshot | null {
  const members = input.mountedStreamKeys
    ? scopeSyncCatalogMembers(
        input.members,
        input.mountedStreamKeys,
        input.fallbackMembers ?? [],
      )
    : [...input.members];
  if (members.length === 0 && !input.catalog_complete) {
    return null;
  }
  const counts = countSyncProgress(
    members,
    input.states,
    input.catalog_complete,
  );
  return {
    installation_id: input.installation_id,
    updated_at: (input.now ?? (() => new Date().toISOString()))(),
    counts,
    progress: syncProgressViewFromCounts(counts),
  };
}

/** In-memory sync progress cache refreshed by sync ticks, not by read paths. */
export class SyncProgressSnapshotStore {
  private readonly snapshots = new Map<string, SyncProgressSnapshot>();

  publish(snapshot: SyncProgressSnapshot): SyncProgressSnapshot {
    this.snapshots.set(snapshot.installation_id, snapshot);
    return snapshot;
  }

  peek(installationId: string): SyncProgressSnapshot | null {
    return this.snapshots.get(installationId) ?? null;
  }

  peekProgress(installationId: string): SyncProgressView | null {
    return this.snapshots.get(installationId)?.progress ?? null;
  }

  list(): SyncProgressSnapshot[] {
    return [...this.snapshots.values()];
  }

  clear(installationId?: string): void {
    if (installationId) {
      this.snapshots.delete(installationId);
      return;
    }
    this.snapshots.clear();
  }
}
