/** Directory and lifecycle data a connector reports. Scheduling stays in core. */

export interface SyncPollHint {
  /** Recent/live tail has been seeded at least once. */
  live_seeded?: boolean;
  /** History backfill still has older pages. */
  history_pending?: boolean;
}

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

export type SyncMode = "conversation" | "balanced" | "context";

export const DEFAULT_SYNC_MODE: SyncMode = "conversation";

export function parseSyncMode(raw: unknown): SyncMode | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toLowerCase();
  if (value === "conversation" || value === "balanced" || value === "context") {
    return value;
  }
  return null;
}

export const DEFAULT_CATALOG_OPTIONS_TIMEOUT_MS = 8_000;
