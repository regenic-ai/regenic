import { applySyncCatalogMembers, emptySyncCatalog } from "./sync-catalog";
import type {
  SyncCatalogMember,
  SyncCatalogView,
  SyncPageOutcome,
  SyncSource,
  SyncStore,
  SyncStreamState,
  SyncWorkItem,
} from "./sync-contracts";
import { CATALOG_RESCAN_MS } from "./sync-contracts";
import { lastHistoryWorkKey, planSyncWork, syncLaneLimits } from "./sync-scheduler";
import { advanceSyncState, syncStateFromCursor } from "./sync-phase";

export interface SyncEngineOptions {
  now?: () => string;
  catalogRescanMs?: number;
}

export interface SyncPlanInput {
  installation_id: string;
  preferredThreadId?: string | null;
  humanIdle: boolean;
  rotateFrom?: string;
  pages?: number;
  fallbackMembers?: readonly SyncCatalogMember[];
  cursorStates?: ReadonlyMap<string, string | undefined>;
}

export interface SyncRefreshCatalogInput {
  installation_id: string;
  source: SyncSource;
  pages?: number;
  force?: boolean;
}

export class SyncEngine {
  private readonly now: () => string;
  private readonly catalogRescanMs: number;

  constructor(
    private readonly store: SyncStore,
    options: SyncEngineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.catalogRescanMs = options.catalogRescanMs ?? CATALOG_RESCAN_MS;
  }

  async catalog(installationId: string): Promise<SyncCatalogView> {
    return this.store.getSyncCatalog(installationId);
  }

  async refreshCatalog(input: SyncRefreshCatalogInput): Promise<SyncCatalogView> {
    if (!input.source.listDirectory) {
      return this.store.getSyncCatalog(input.installation_id);
    }
    let view = await this.store.getSyncCatalog(input.installation_id);
    const pages = Math.max(1, input.pages ?? 1);
    if (!input.force && this.catalogFresh(view)) {
      return view;
    }
    for (let page = 0; page < pages; page += 1) {
      const cursor = view.catalog?.complete ? null : (view.catalog?.cursor ?? null);
      const listed = await input.source.listDirectory(cursor);
      view = await this.store.applySyncCatalogPage({
        installation_id: input.installation_id,
        members: listed.members,
        now: this.now(),
        next_cursor: listed.next_cursor,
        complete: listed.complete,
      });
      if (listed.complete || !listed.next_cursor) {
        break;
      }
    }
    return view;
  }

  async plan(input: SyncPlanInput): Promise<SyncWorkItem[]> {
    const view = await this.store.getSyncCatalog(input.installation_id);
    const storedStates = await this.store.listSyncStates(input.installation_id);
    const states = new Map(
      storedStates.map((state) => [state.stream_key, state] as const),
    );
    const members =
      view.members.length > 0
        ? view.members
        : [...(input.fallbackMembers ?? [])];
    const now = this.now();
    for (const member of members) {
      if (states.has(member.stream_key)) {
        continue;
      }
      const cursor = input.cursorStates?.get(member.stream_key);
      states.set(
        member.stream_key,
        syncStateFromCursor({
          installation_id: input.installation_id,
          stream_key: member.stream_key,
          cursor,
          now,
        }),
      );
    }
    const catalogIncomplete = view.catalog ? !view.catalog.complete : true;
    return planSyncWork({
      members,
      states,
      preferredThreadId: input.preferredThreadId,
      humanIdle: input.humanIdle,
      catalogIncomplete,
      rotateFrom: input.rotateFrom,
      now,
      pages: input.pages,
      limits: syncLaneLimits(input.humanIdle, catalogIncomplete),
    });
  }

  async rememberResult(outcome: SyncPageOutcome): Promise<SyncStreamState> {
    const current = await this.store.getSyncState(
      outcome.installation_id,
      outcome.stream_key,
    );
    return this.store.putSyncState(advanceSyncState(current, outcome));
  }

  lastHistoryKey(items: readonly SyncWorkItem[]): string | undefined {
    return lastHistoryWorkKey(items);
  }

  catalogFresh(view: SyncCatalogView, now = this.now()): boolean {
    if (!view.catalog?.complete || !view.catalog.updated_at) {
      return false;
    }
    const updated = Date.parse(view.catalog.updated_at);
    const current = Date.parse(now);
    if (!Number.isFinite(updated) || !Number.isFinite(current)) {
      return false;
    }
    return current - updated < this.catalogRescanMs;
  }
}

export class MemorySyncStore implements SyncStore {
  private readonly catalogs = new Map<string, SyncCatalogView>();
  private readonly states = new Map<string, SyncStreamState>();

  async getSyncCatalog(installationId: string): Promise<SyncCatalogView> {
    return cloneCatalog(this.catalogs.get(installationId) ?? emptySyncCatalog(installationId));
  }

  async applySyncCatalogPage(
    input: Parameters<SyncStore["applySyncCatalogPage"]>[0],
  ): Promise<SyncCatalogView> {
    const current = await this.getSyncCatalog(input.installation_id);
    const next = applySyncCatalogMembers(current, input);
    this.catalogs.set(input.installation_id, next);
    return cloneCatalog(next);
  }

  async listSyncStates(installationId: string): Promise<SyncStreamState[]> {
    return [...this.states.values()]
      .filter((state) => state.installation_id === installationId)
      .map((state) => ({ ...state }));
  }

  async getSyncState(
    installationId: string,
    streamKey: string,
  ): Promise<SyncStreamState | null> {
    const state = this.states.get(stateKey(installationId, streamKey));
    return state ? { ...state } : null;
  }

  async putSyncState(state: SyncStreamState): Promise<SyncStreamState> {
    const next = { ...state };
    this.states.set(stateKey(state.installation_id, state.stream_key), next);
    return { ...next };
  }

  clear(installationId?: string): void {
    if (!installationId) {
      this.catalogs.clear();
      this.states.clear();
      return;
    }
    this.catalogs.delete(installationId);
    for (const key of [...this.states.keys()]) {
      if (key.startsWith(`${installationId}\u0000`)) {
        this.states.delete(key);
      }
    }
  }
}

function stateKey(installationId: string, streamKey: string): string {
  return `${installationId}\u0000${streamKey}`;
}

function cloneCatalog(view: SyncCatalogView): SyncCatalogView {
  return {
    members: view.members.map((member) => ({ ...member })),
    catalog: view.catalog ? { ...view.catalog } : null,
  };
}
