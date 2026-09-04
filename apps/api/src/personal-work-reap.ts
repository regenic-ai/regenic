import type { ExecutorRunHandle, Transcript, WorkRun, WorkRunStatus } from "@regenic/domain";

export const DEFAULT_WORK_REAP_STALE_MS = 3 * 60 * 1000;
export const WORK_REAP_LOG_EVERY_MS = 60 * 1000;
export const WORK_REAP_FOLLOW_COOLDOWN_MS = 30 * 1000;

export function workReapStaleMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.REGENIC_WORK_REAP_STALE_MS);
  if (Number.isFinite(raw) && raw >= 30_000) {
    return Math.floor(raw);
  }
  return DEFAULT_WORK_REAP_STALE_MS;
}

export function workAgeMs(createdAt: string, now: number): number {
  const at = Date.parse(createdAt);
  return Number.isFinite(at) ? Math.max(0, now - at) : 0;
}

export function isStaleWork(
  createdAt: string,
  now: number,
  staleMs: number = DEFAULT_WORK_REAP_STALE_MS,
): boolean {
  return workAgeMs(createdAt, now) >= staleMs;
}

export interface InboxTurnRow {
  status: boolean;
  turn?: { state: "open" | "ended"; ok?: boolean; reason?: string };
  activity?: string;
  text?: string;
}

export interface InboxTurnScan {
  liveTurn?: "open" | "ended";
  liveActivity?: string;
  liveOk?: boolean;
  inboxEnded: boolean;
  endedOk?: boolean;
  endedReason?: string;
  endedSummary?: string;
}

/** Newest-first rows. Live is the latest thread_status; any ended status can reap. */
export function scanInboxTurns(rows: readonly InboxTurnRow[]): InboxTurnScan {
  const live = rows.find((row) => row.status) ?? rows[0];
  let ended: InboxTurnRow | undefined;
  for (const row of rows) {
    if (row.status && row.turn?.state === "ended") {
      ended = row;
      break;
    }
  }
  return {
    liveTurn: live?.turn?.state,
    liveActivity: live?.activity,
    liveOk: live?.turn?.ok,
    inboxEnded: Boolean(ended),
    endedOk: ended?.turn?.ok,
    endedReason: ended?.turn?.reason,
    endedSummary: ended?.text?.trim() || undefined,
  };
}

export function shouldForceReap(input: {
  handleStatus: WorkRunStatus;
  inboxEnded: boolean;
}): boolean {
  return input.handleStatus === "running" && input.inboxEnded;
}

export function handleFromInboxEnd(
  run: Pick<WorkRun, "id" | "external_run_id" | "agent_thread_id" | "result">,
  scan: InboxTurnScan,
  transcript?: Transcript | null,
): ExecutorRunHandle {
  const summary =
    scan.endedSummary?.trim() ||
    transcript?.text?.trim() ||
    run.result?.summary?.trim() ||
    "";
  const ok = scan.endedOk !== false;
  return {
    external_run_id: run.external_run_id ?? run.id,
    agent_thread_id: run.agent_thread_id,
    status: ok ? "completed" : "failed",
    result: summary ? { summary } : run.result,
    transcript: transcript ?? {
      kind: "system",
      text: summary || undefined,
      turn: { state: "ended", ok, reason: scan.endedReason },
    },
  };
}
