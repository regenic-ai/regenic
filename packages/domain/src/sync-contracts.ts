/** Opaque connector cursor. Encoding stays in the channel adapter. */
export type SyncCursorValue = string;

export type SyncLane =
  | "interactive"
  | "live"
  | "catalog"
  | "history"
  | "media";

export type SyncPhase = "unseeded" | "live" | "history" | "steady";

export const SYNC_LANES: readonly SyncLane[] = [
  "interactive",
  "live",
  "catalog",
  "history",
  "media",
] as const;

export const SYNC_CATALOG_STREAM = "__catalog__";

export interface SyncCatalogMember {
  installation_id: string;
  stream_key: string;
  thread_id?: string;
  label?: string;
  kind?: string;
  generation: number;
  discovered_at: string;
  last_seen_at: string;
}

export interface SyncCatalogSnapshot {
  installation_id: string;
  cursor?: string;
  complete: boolean;
  generation: number;
  updated_at: string;
}

export interface SyncCatalogView {
  members: SyncCatalogMember[];
  catalog: SyncCatalogSnapshot | null;
}

export interface SyncDirectoryMember {
  stream_key: string;
  thread_id?: string;
  label?: string;
  kind?: string;
}

export interface SyncDirectoryPage {
  members: SyncDirectoryMember[];
  next_cursor?: string;
  complete: boolean;
}

export interface SyncSource {
  listDirectory?(cursor: string | null): Promise<SyncDirectoryPage>;
}

export interface SyncStreamState {
  installation_id: string;
  stream_key: string;
  phase: SyncPhase;
  live_cursor?: string;
  history_cursor?: string;
  media_pending: boolean;
  idle_until?: string;
  generation: number;
  updated_at: string;
}

export interface SyncWorkItem {
  lane: SyncLane;
  stream_key: string;
  thread_id?: string;
  older: boolean;
  media: boolean;
  pages: number;
}

export interface SyncLaneLimits {
  interactive: number;
  live: number;
  catalog: number;
  history: number;
  media: number;
}

export interface ApplySyncCatalogPageInput {
  installation_id: string;
  members: readonly SyncDirectoryMember[];
  now: string;
  next_cursor?: string;
  complete: boolean;
}

export interface SyncPageOutcome {
  installation_id: string;
  stream_key: string;
  thread_id?: string;
  older: boolean;
  media: boolean;
  accepted_count: number;
  quarantined_count: number;
  has_more: boolean;
  next_live_cursor?: string;
  next_history_cursor?: string;
  media_pending?: boolean;
  idle_ms?: number;
  error?: unknown;
  now: string;
}

export interface SyncStore {
  getSyncCatalog(installationId: string): Promise<SyncCatalogView>;
  applySyncCatalogPage(input: ApplySyncCatalogPageInput): Promise<SyncCatalogView>;
  listSyncStates(installationId: string): Promise<SyncStreamState[]>;
  getSyncState(
    installationId: string,
    streamKey: string,
  ): Promise<SyncStreamState | null>;
  putSyncState(state: SyncStreamState): Promise<SyncStreamState>;
}

export const CATALOG_RESCAN_MS = 5 * 60_000;
export const PREFER_THREAD_MS = 2 * 60_000;
export const DEFAULT_SYNC_IDLE_MS = 15_000;
export const UNSEEN_SEED_PER_TICK = 16;
