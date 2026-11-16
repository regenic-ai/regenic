import type { SyncLane, SyncPhase, SyncStreamState } from "./sync-contracts";

/**
 * Whether this installation backfills older messages.
 * Connectors do not read this. `sync_mode` only sets the live idle.
 */
export type HistoryPolicy = "backfill" | "incremental";

export const DEFAULT_HISTORY_POLICY: HistoryPolicy = "backfill";

export function historyPolicyFromConfig(
  config: Record<string, unknown> | null | undefined,
): HistoryPolicy {
  if (!config || typeof config !== "object") {
    return DEFAULT_HISTORY_POLICY;
  }
  const raw = config.history_policy;
  if (typeof raw !== "string") {
    return DEFAULT_HISTORY_POLICY;
  }
  const value = raw.trim().toLowerCase();
  if (value === "backfill" || value === "incremental") {
    return value;
  }
  return DEFAULT_HISTORY_POLICY;
}

/** Steady tick. New messages are pushed. Catalog stays on its own tick. */
export function steadySyncClaimLanes(): readonly SyncLane[] {
  return ["media"];
}

/** History tick. It does not share a claim with live or catalog. */
export function historySyncClaimLanes(): readonly SyncLane[] {
  return ["history"];
}

/**
 * History keeps running while a person is reading the inbox.
 * Memory pressure is the only reason to skip the tick.
 */
export function shouldRunHistoryTick(input: {
  backgroundReleased: boolean;
  deferHistory: boolean;
  throttleHistory: boolean;
}): boolean {
  return (
    input.backgroundReleased && !input.deferHistory && !input.throttleHistory
  );
}

/**
 * One background message duty. Media is a side lane on the steady tick.
 * Backfill owes history until the source says there is nothing older.
 * Incremental never owes history. New messages are pushed, so no phase owes live.
 */
export function owedSyncLanes(
  state: Pick<SyncStreamState, "phase" | "media_pending">,
  policy: HistoryPolicy = DEFAULT_HISTORY_POLICY,
  options?: { live_via?: "poll" | "push" },
): SyncLane[] {
  const lanes: SyncLane[] = [];
  if (messageDuty(state.phase, policy) === "history") {
    lanes.push("history");
  } else if ((options?.live_via ?? "poll") === "poll") {
    lanes.push("live");
  }
  if (state.media_pending) {
    lanes.push("media");
  }
  return lanes;
}

export function messageDuty(
  phase: SyncPhase | undefined,
  policy: HistoryPolicy = DEFAULT_HISTORY_POLICY,
): "history" | "live" {
  if (policy === "backfill" && phase === "history") {
    return "history";
  }
  return "live";
}

/**
 * Phase to store when a push is the first sign of a stream.
 * `null` leaves an existing live or history phase alone.
 * Hybrid installs that backfill start in history so the core pulls older
 * messages; webhook-only and incremental installs stay on the push tail.
 */
export function phaseAfterPush(input: {
  prior?: SyncPhase;
  policy?: HistoryPolicy;
  /** Driver accepts history polls (`poll` or `hybrid`). */
  polls: boolean;
}): SyncPhase | null {
  if (input.prior && input.prior !== "unseeded") {
    return null;
  }
  if ((input.policy ?? DEFAULT_HISTORY_POLICY) === "backfill" && input.polls) {
    return "history";
  }
  return "live";
}

/**
 * Media flag to store after a push. `null` leaves the existing flag.
 * Webhook-only installs cannot drain downloads, so the report is ignored.
 * An omitted report is not a clear.
 */
export function mediaPendingAfterPush(input: {
  reported?: boolean;
  polls: boolean;
}): boolean | null {
  if (!input.polls || input.reported === undefined) {
    return null;
  }
  return input.reported;
}

/** Incremental installs do not stay in the history phase. */
export function releaseHistoryPhase<T extends { phase: SyncPhase }>(
  state: T,
  policy: HistoryPolicy = DEFAULT_HISTORY_POLICY,
): T {
  if (policy === "incremental" && state.phase === "history") {
    return { ...state, phase: "live" };
  }
  return state;
}
