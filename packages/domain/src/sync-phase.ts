import type {
  SyncPageOutcome,
  SyncPhase,
  SyncPollHint,
  SyncStreamState,
} from "./sync-contracts";

export function streamCursorUnseeded(value?: string | null): boolean {
  if (!value?.trim()) {
    return true;
  }
  // DSH bounded-history resume (`afterSeq:beforeSeq`) has not produced a
  // first ingest page yet — treat it as still unseeded.
  if (/^(-1|\d+):(\d+)$/.test(value.trim())) {
    return true;
  }
  try {
    const parsed = JSON.parse(value) as { recent_seeded?: unknown };
    if (parsed && typeof parsed === "object" && "recent_seeded" in parsed) {
      return parsed.recent_seeded !== true;
    }
  } catch {
    // A non-JSON cursor still means this stream has been polled.
  }
  return false;
}

export function historyCursorPending(value?: string | null): boolean {
  if (!value?.trim()) {
    return false;
  }
  if (/^(-1|\d+):(\d+)$/.test(value.trim())) {
    return true;
  }
  try {
    const parsed = JSON.parse(value) as {
      history_token?: unknown;
      sort?: unknown;
    };
    if (!parsed || typeof parsed !== "object") {
      return false;
    }
    if (typeof parsed.history_token === "string" && parsed.history_token.trim()) {
      return true;
    }
    return parsed.sort === "desc";
  } catch {
    return false;
  }
}

export function deriveSyncPhase(input: {
  live_cursor?: string | null;
  history_cursor?: string | null;
  idle_until?: string | null;
  poll_hint?: SyncPollHint;
  now?: string;
}): SyncPhase {
  if (input.poll_hint) {
    return deriveSyncPhaseFromHint(input.poll_hint, input.idle_until, input.now);
  }
  if (streamCursorUnseeded(input.live_cursor)) {
    return "unseeded";
  }
  if (historyCursorPending(input.history_cursor ?? input.live_cursor)) {
    return "history";
  }
  if (input.idle_until && input.now && input.idle_until > input.now) {
    return "steady";
  }
  return "live";
}

export function deriveSyncPhaseFromHint(
  hint: SyncPollHint,
  idleUntil?: string | null,
  now?: string,
): SyncPhase {
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
      : current?.history_cursor ?? live;
  const mediaPending =
    outcome.media_pending !== undefined
      ? outcome.media_pending
      : (current?.media_pending ?? false);
  const idleUntil =
    !outcome.error &&
    !outcome.has_more &&
    outcome.idle_ms &&
    outcome.idle_ms > 0
      ? new Date(Date.parse(outcome.now) + outcome.idle_ms).toISOString()
      : outcome.has_more || outcome.error
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
