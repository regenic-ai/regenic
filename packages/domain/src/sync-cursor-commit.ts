import type { HistoryPolicy } from "./sync-history";
import type { SyncPhase } from "./sync-contracts";

/** Which call this page was. Scroll is not a background duty. */
export type CursorKind = "live" | "history" | "scroll";

export function cursorKindFromPoll(input: {
  older?: boolean;
  before?: string | null;
}): CursorKind {
  if (input.before?.trim()) {
    return "scroll";
  }
  if (input.older === true) {
    return "history";
  }
  return "live";
}

export interface CursorWrite {
  live: boolean;
  history: boolean;
  /** Persist the returned cursor on the lease. Scroll never does. */
  lease: boolean;
}

/**
 * A history page writes only the history cursor.
 * A live page writes only the live cursor, except the first seed page,
 * which copies the same opaque cursor into both so the walk can start.
 * Scroll writes nothing.
 */
export function cursorWriteFor(input: {
  kind: CursorKind;
  seedHistory: boolean;
}): CursorWrite {
  if (input.kind === "scroll") {
    return { live: false, history: false, lease: false };
  }
  if (input.kind === "history") {
    return { live: false, history: true, lease: true };
  }
  return { live: true, history: input.seedHistory, lease: true };
}

/**
 * Whether this same lane should fetch another page.
 * `history_pending` decides backfill. It does not make a live page continue.
 * A history page continues only from its own `has_more`.
 */
export function sameLaneContinues(input: {
  kind: CursorKind;
  hasMore: boolean;
  historyPending?: boolean;
}): boolean {
  if (input.kind === "scroll") {
    return false;
  }
  if (input.kind === "history") {
    return input.hasMore === true;
  }
  if (input.historyPending === true) {
    return false;
  }
  return input.hasMore === true;
}
export function shouldSeedHistoryCursor(input: {
  policy: HistoryPolicy;
  phase?: SyncPhase | null;
  historyCursor?: string | null;
  historyPending: boolean;
}): boolean {
  if (input.policy !== "backfill" || input.historyPending !== true) {
    return false;
  }
  if (input.historyCursor?.trim()) {
    return false;
  }
  return !input.phase || input.phase === "unseeded";
}

/**
 * Cursor handed to the connector. Regenic does not parse it.
 * Missing value means "use the lease".
 */
export function pollCursorValue(input: {
  kind: CursorKind;
  liveCursor?: string | null;
  historyCursor?: string | null;
  leaseCursor?: string | null;
}): string | undefined {
  if (input.kind === "history") {
    return input.historyCursor?.trim() || input.leaseCursor?.trim() || undefined;
  }
  return input.liveCursor?.trim() || input.leaseCursor?.trim() || undefined;
}
