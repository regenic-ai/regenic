import type {
  SyncCatalogMember,
  SyncCatalogView,
  SyncStore,
  SyncStreamState,
} from "./sync-contracts";
import { summarizeSyncLifecycle } from "./sync-lifecycle";

export interface SyncProgressView {
  discovered: number;
  seeded: number;
  unseeded: number;
  backfilling: number;
  media_pending: number;
  catalog_complete: boolean;
  /** Streams still in one-time seed or history backfill. */
  bootstrap_pending: number;
  /** Streams on ongoing live/steady tail only. */
  steady: number;
}

export function emptySyncProgress(): SyncProgressView {
  return {
    discovered: 0,
    seeded: 0,
    unseeded: 0,
    backfilling: 0,
    media_pending: 0,
    catalog_complete: false,
    bootstrap_pending: 0,
    steady: 0,
  };
}

export function scopeSyncCatalogMembers(
  catalogMembers: readonly SyncCatalogMember[],
  mountedStreamKeys: ReadonlySet<string>,
  fallbackMembers: readonly SyncCatalogMember[],
): SyncCatalogMember[] {
  if (mountedStreamKeys.size === 0) {
    return [...fallbackMembers];
  }
  const scoped = catalogMembers.filter((member) =>
    mountedStreamKeys.has(member.stream_key),
  );
  return scoped.length > 0 ? scoped : [...fallbackMembers];
}

export function summarizeSyncProgress(
  catalog: SyncCatalogView,
  states: readonly SyncStreamState[],
): SyncProgressView {
  const byKey = new Map(states.map((state) => [state.stream_key, state]));
  let seeded = 0;
  let unseeded = 0;
  let backfilling = 0;
  let mediaPending = 0;
  for (const member of catalog.members) {
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
  const lifecycle = summarizeSyncLifecycle(catalog.members, byKey);
  return {
    discovered: catalog.members.length,
    seeded,
    unseeded,
    backfilling,
    media_pending: mediaPending,
    catalog_complete: catalog.catalog?.complete === true,
    bootstrap_pending: lifecycle.bootstrap_pending,
    steady: lifecycle.steady,
  };
}

export function publishedSyncProgress(
  catalog: SyncCatalogView,
  states: readonly SyncStreamState[],
): SyncProgressView | null {
  if (!catalog.catalog && catalog.members.length === 0) {
    return null;
  }
  return summarizeSyncProgress(catalog, states);
}

export function aggregateSyncProgress(
  items: readonly SyncProgressView[],
): SyncProgressView {
  const active = items.filter(
    (item) => item.discovered > 0 || item.catalog_complete,
  );
  if (active.length === 0) {
    return emptySyncProgress();
  }
  return {
    discovered: active.reduce((sum, item) => sum + item.discovered, 0),
    seeded: active.reduce((sum, item) => sum + item.seeded, 0),
    unseeded: active.reduce((sum, item) => sum + item.unseeded, 0),
    backfilling: active.reduce((sum, item) => sum + item.backfilling, 0),
    media_pending: active.reduce((sum, item) => sum + item.media_pending, 0),
    catalog_complete: active.every((item) => item.catalog_complete),
    bootstrap_pending: active.reduce((sum, item) => sum + item.bootstrap_pending, 0),
    steady: active.reduce((sum, item) => sum + item.steady, 0),
  };
}

export async function loadSyncProgress(
  store: Pick<SyncStore, "getSyncCatalog" | "listSyncStates">,
  installationId: string,
  options?: {
    mountedStreamKeys?: ReadonlySet<string>;
    fallbackMembers?: readonly SyncCatalogMember[];
  },
): Promise<SyncProgressView | null> {
  const [catalog, states] = await Promise.all([
    store.getSyncCatalog(installationId),
    store.listSyncStates(installationId),
  ]);
  if (!options?.mountedStreamKeys) {
    return publishedSyncProgress(catalog, states);
  }
  const members = scopeSyncCatalogMembers(
    catalog.members,
    options.mountedStreamKeys,
    options.fallbackMembers ?? [],
  );
  return publishedSyncProgress({ ...catalog, members }, states);
}
