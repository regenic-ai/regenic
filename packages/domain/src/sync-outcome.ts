import type { ConnectorStream } from "./channel-driver";
import type { ConnectorPollRunResult } from "./connector-runner";
import type { SyncPageOutcome, SyncPhase, SyncWorkItem } from "./sync-contracts";
import {
  cursorKindFromPoll,
  cursorWriteFor,
  sameLaneContinues,
  shouldSeedHistoryCursor,
  type CursorKind,
} from "./sync-cursor-commit";
import type { HistoryPolicy } from "./sync-history";

export interface SyncPollRunSummary {
  pages: ConnectorPollRunResult[];
  error?: unknown;
}

export interface SyncPollRunItem {
  stream: ConnectorStream;
  work: Pick<SyncWorkItem, "older" | "media">;
  idleMs?: number;
  pollHint?: SyncPageOutcome["poll_hint"];
  cursorKind?: CursorKind;
  historyPolicy?: HistoryPolicy;
  phase?: SyncPhase | null;
  historyCursor?: string | null;
}

export function summarizePollRuns(
  pages: readonly ConnectorPollRunResult[],
): { accepted_count: number; quarantined_count: number } {
  let accepted_count = 0;
  let quarantined_count = 0;
  for (const page of pages) {
    if (!("result" in page) || !page.result) {
      continue;
    }
    for (const record of page.result.records) {
      if (record.status === "accepted") {
        accepted_count += 1;
      } else if (record.status === "quarantined") {
        quarantined_count += 1;
      }
    }
  }
  return { accepted_count, quarantined_count };
}

export function syncOutcomeForPoll(
  installationId: string,
  input: {
    stream: SyncPollRunItem["stream"];
    prior?: { phase?: SyncPhase | null; history_cursor?: string | null } | null;
    policy?: HistoryPolicy;
    older?: boolean;
    before?: string | null;
    media?: boolean;
    idleMs?: number;
  },
  runs: SyncPollRunSummary,
  now: string,
): SyncPageOutcome {
  return syncPageOutcomeFromPollRuns(
    installationId,
    {
      stream: input.stream,
      work: { older: input.older === true, media: input.media === true },
      idleMs: input.idleMs,
      cursorKind: cursorKindFromPoll({
        older: input.older,
        before: input.before,
      }),
      historyPolicy: input.policy ?? "backfill",
      phase: input.prior?.phase,
      historyCursor: input.prior?.history_cursor,
    },
    runs,
    now,
  );
}

export function syncPageOutcomeFromPollRuns(
  installationId: string,
  item: SyncPollRunItem,
  runs: SyncPollRunSummary,
  now: string,
): SyncPageOutcome {
  const summary = summarizePollRuns(runs.pages);
  const last = [...runs.pages].reverse().find((page) => "next_cursor" in page);
  const nextCursor =
    last && "next_cursor" in last ? last.next_cursor : undefined;
  const mediaPage = [...runs.pages]
    .reverse()
    .find((page) => "media_pending" in page);
  const pollHintPage = [...runs.pages]
    .reverse()
    .find((page) => "poll_hint" in page && page.poll_hint !== undefined);
  const pollHint =
    pollHintPage && "poll_hint" in pollHintPage
      ? pollHintPage.poll_hint
      : item.pollHint;
  const rawHasMore = runs.pages.some(
    (page) => "has_more" in page && page.has_more === true,
  );
  const kind = item.cursorKind ?? (item.work.older ? "history" : "live");
  const policy = item.historyPolicy ?? "backfill";
  const write = cursorWriteFor({
    kind,
    seedHistory:
      kind === "live" &&
      shouldSeedHistoryCursor({
        policy,
        phase: item.phase,
        historyCursor: item.historyCursor,
        historyPending: pollHint?.history_pending === true,
      }),
  });
  return {
    installation_id: installationId,
    stream_key: item.stream.stream_key,
    thread_id: item.stream.thread_id,
    older: item.work.older,
    media: item.work.media,
    accepted_count: summary.accepted_count,
    quarantined_count: summary.quarantined_count,
    has_more: sameLaneContinues({
      kind,
      hasMore: rawHasMore,
      historyPending: pollHint?.history_pending === true,
    }),
    ...(write.live ? { next_live_cursor: nextCursor } : {}),
    ...(write.history ? { next_history_cursor: nextCursor } : {}),
    cursor_kind: kind,
    history_policy: policy,
    media_pending:
      mediaPage && "media_pending" in mediaPage
        ? mediaPage.media_pending
        : undefined,
    poll_hint: pollHint,
    idle_ms: item.idleMs,
    error: runs.error,
    now,
  };
}
