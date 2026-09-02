import type { ConnectorStream } from "./channel-driver";
import type { ConnectorPollRunResult } from "./connector-runner";
import type { SyncPageOutcome, SyncWorkItem } from "./sync-contracts";

export interface SyncPollRunSummary {
  pages: ConnectorPollRunResult[];
  error?: unknown;
}

export interface SyncPollRunItem {
  stream: ConnectorStream;
  work: Pick<SyncWorkItem, "older" | "media">;
  idleMs?: number;
  pollHint?: SyncPageOutcome["poll_hint"];
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
  return {
    installation_id: installationId,
    stream_key: item.stream.stream_key,
    thread_id: item.stream.thread_id,
    older: item.work.older,
    media: item.work.media,
    accepted_count: summary.accepted_count,
    quarantined_count: summary.quarantined_count,
    has_more: runs.pages.some(
      (page) => "has_more" in page && page.has_more === true,
    ),
    next_live_cursor: nextCursor,
    next_history_cursor: nextCursor,
    media_pending:
      mediaPage && "media_pending" in mediaPage
        ? mediaPage.media_pending
        : undefined,
    poll_hint:
      pollHintPage && "poll_hint" in pollHintPage
        ? pollHintPage.poll_hint
        : item.pollHint,
    idle_ms: item.idleMs,
    error: runs.error,
    now,
  };
}
