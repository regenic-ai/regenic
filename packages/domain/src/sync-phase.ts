import type {
  SyncPageOutcome,
  SyncPhase,
  SyncPollHint,
  SyncStreamState,
} from "./sync-contracts";
import type { CursorKind } from "./sync-cursor-commit";
import { sameLaneContinues } from "./sync-cursor-commit";
import type { HistoryPolicy } from "./sync-history";

/**
 * Opaque empty check only — core must not parse wire cursor encodings.
 * Lifecycle comes from SyncPollHint / stored phase.
 */
export function streamCursorUnseeded(value?: string | null): boolean {
  return !value?.trim();
}

export function deriveSyncPhase(input: {
  live_cursor?: string | null;
  history_cursor?: string | null;
  idle_until?: string | null;
  poll_hint?: SyncPollHint;
  now?: string;
  /** Prior stored phase when poll_hint is absent (opaque non-empty cursor). */
  fallback_phase?: SyncPhase;
  cursor_kind?: CursorKind;
  history_policy?: HistoryPolicy;
}): SyncPhase {
  if (input.poll_hint) {
    return deriveSyncPhaseFromHint(input.poll_hint, input.idle_until, input.now, {
      fallback: input.fallback_phase,
      policy: input.history_policy,
      cursorKind: input.cursor_kind,
    });
  }
  if (streamCursorUnseeded(input.live_cursor)) {
    return "unseeded";
  }
  if (input.fallback_phase) {
    if (
      input.fallback_phase !== "unseeded" &&
      input.fallback_phase !== "history" &&
      input.idle_until &&
      input.now &&
      input.idle_until > input.now
    ) {
      return "steady";
    }
    return input.fallback_phase;
  }
  // Non-empty wire cursor without a hint must not invent "live".
  return "unseeded";
}

export interface SyncPhaseGuard {
  fallback?: SyncPhase;
  policy?: HistoryPolicy;
  cursorKind?: CursorKind;
}

export function deriveSyncPhaseFromHint(
  hint: SyncPollHint,
  idleUntil?: string | null,
  now?: string,
  guard?: SyncPhaseGuard,
): SyncPhase {
  const policy = guard?.policy ?? "backfill";
  const fallback = guard?.fallback;
  const kind = guard?.cursorKind;
  if (kind === "scroll" && fallback && fallback !== "unseeded") {
    return fallback;
  }
  if (policy === "incremental") {
    if (
      hint.live_seeded === false &&
      fallback !== "live" &&
      fallback !== "steady"
    ) {
      return "unseeded";
    }
    if (idleUntil && now && idleUntil > now) {
      return "steady";
    }
    return "live";
  }
  // Opening a chat pulls the newest page and must not finish or restart history.
  if (kind === "live" && fallback === "history") {
    return "history";
  }
  // A stream that already caught up stays on the live tail.
  if (fallback === "live" || fallback === "steady") {
    if (hint.live_seeded === false) {
      return fallback;
    }
    if (idleUntil && now && idleUntil > now) {
      return "steady";
    }
    return fallback === "steady" ? "steady" : "live";
  }
  if (hint.live_seeded === false) {
    return "unseeded";
  }
  if (hint.history_pending === true) {
    return "history";
  }
  if (idleUntil && now && idleUntil > now) {
    return "steady";
  }
  return "live";
}

export function syncStateFromCursor(input: {
  installation_id: string;
  stream_key: string;
  cursor?: string | null;
  now: string;
  generation?: number;
}): SyncStreamState {
  const live = input.cursor?.trim() || undefined;
  return {
    installation_id: input.installation_id,
    stream_key: input.stream_key,
    phase: deriveSyncPhase({ live_cursor: live, history_cursor: live, now: input.now }),
    live_cursor: live,
    history_cursor: live,
    media_pending: false,
    generation: input.generation ?? 1,
    updated_at: input.now,
  };
}

export function advanceSyncState(
  current: SyncStreamState | null,
  outcome: SyncPageOutcome,
): SyncStreamState {
  const live =
    outcome.next_live_cursor !== undefined
      ? outcome.next_live_cursor
      : current?.live_cursor;
  const history =
    outcome.next_history_cursor !== undefined
      ? outcome.next_history_cursor
      : current?.history_cursor;
  const mediaPending =
    outcome.media_pending !== undefined
      ? outcome.media_pending
      : (current?.media_pending ?? false);
  const continues = sameLaneContinues({
    kind: outcome.cursor_kind ?? (outcome.older ? "history" : "live"),
    hasMore: outcome.has_more,
    historyPending: outcome.poll_hint?.history_pending === true,
  });
  const idleUntil =
    !outcome.error &&
    !continues &&
    outcome.idle_ms &&
    outcome.idle_ms > 0
      ? new Date(Date.parse(outcome.now) + outcome.idle_ms).toISOString()
      : continues || outcome.error
        ? undefined
        : current?.idle_until;
  const phase = outcome.error
    ? (current?.phase ?? "live")
    : deriveSyncPhase({
        live_cursor: live,
        history_cursor: history,
        idle_until: idleUntil,
        poll_hint: outcome.poll_hint,
        now: outcome.now,
        fallback_phase: current?.phase,
        cursor_kind: outcome.cursor_kind,
        history_policy: outcome.history_policy,
      });
  return {
    installation_id: outcome.installation_id,
    stream_key: outcome.stream_key,
    phase,
    live_cursor: live,
    history_cursor: history,
    media_pending: mediaPending,
    idle_until: idleUntil,
    generation: current?.generation ?? 1,
    updated_at: outcome.now,
  };
}

export function syncStateIsDue(
  state: SyncStreamState | undefined,
  now: string,
  preferred: boolean,
): boolean {
  if (preferred || !state) {
    return true;
  }
  if (state.phase === "unseeded" || state.phase === "history") {
    return true;
  }
  if (!state.idle_until) {
    return true;
  }
  return state.idle_until <= now;
}

export function shouldKeepSyncCatchingUp(input: {
  has_more: boolean;
  accepted_count: number;
  quarantined_count: number;
  error?: unknown;
}): boolean {
  if (input.error) {
    return true;
  }
  if (input.has_more) {
    return true;
  }
  return false;
}
