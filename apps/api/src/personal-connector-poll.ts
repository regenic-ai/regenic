import { randomUUID } from "node:crypto";
import type { Host } from "@regenic/plugin-host";
import {
  ChannelDriverError,
  ConnectorRunner,
  InProcessConnectorInvoker,
  DeadlineExceededError,
  InstallationQuotaBook,
  connectorPollTimeoutMs,
  cursorKindFromPoll,
  cursorWriteFor,
  historyPolicyFromConfig,
  pollCursorValue,
  sameLaneContinues,
  SyncEngine,
  syncOutcomeForPoll,
  yieldToEventLoop,
  type ConnectorInstallation,
  type ConnectorPollRunResult,
  type ConnectorRuntimeStore,
  type ConnectorStream,
  type SyncPhase,
} from "@regenic/domain";
import { PersonalConnectorError } from "./personal-errors";

export const DEFAULT_MAX_PAGES = 1;

export const LEASE_MS = 60_000;

export function wrapDriverError(
  error: unknown,
  fallback: "sync_failed" | "send_failed" | "invalid_config",
): PersonalConnectorError {
  if (error instanceof PersonalConnectorError) {
    return error;
  }
  if (error instanceof DeadlineExceededError) {
    return new PersonalConnectorError(
      error.code,
      error.message,
      httpStatusFor(error.code),
    );
  }
  if (error instanceof ChannelDriverError) {
    const code = error.reason ?? error.code;
    return new PersonalConnectorError(
      code,
      error.message,
      httpStatusFor(code),
    );
  }
  const message =
    error instanceof Error ? error.message : "Connector operation failed";
  return new PersonalConnectorError(fallback, message, httpStatusFor(fallback));
}

function httpStatusFor(code: string): number {
  switch (code) {
    case "invalid_config":
    case "missing_credentials":
    case "channel_required":
    case "conversation_required":
    case "kinds_required":
      return 400;
    case "already_installed":
      return 409;
    case "unsupported_channel":
      return 501;
    case "no_sender":
      return 404;
    case "disabled":
    case "lease_unavailable":
      return 409;
    case "deadline_exceeded":
      return 504;
    case "throttled":
      return 429;
    default:
      return 502;
  }
}

export function historyPendingFromRuns(pages: ConnectorPollRunResult[]): boolean {
  const completed = pages.filter(
    (page) => "poll_hint" in page || "has_more" in page,
  );
  if (completed.length === 0) {
    return true;
  }
  for (let index = completed.length - 1; index >= 0; index -= 1) {
    const page = completed[index];
    if (page && "poll_hint" in page && page.poll_hint) {
      return page.poll_hint.history_pending === true;
    }
  }
  return completed.some((page) => "has_more" in page && page.has_more === true);
}

export async function pollStream(
  host: Host,
  store: ConnectorRuntimeStore,
  installation: ConnectorInstallation,
  stream: ConnectorStream,
  maxPages: number,
  options?: {
    older?: boolean;
    latest?: boolean;
    media?: boolean;
    before?: string;
    before_external_id?: string;
  },
  quota?: InstallationQuotaBook,
): Promise<ConnectorPollRunResult[]> {
  const runner = new ConnectorRunner(
    new InProcessConnectorInvoker(stream.connector),
    host.get("ingest"),
    store,
    () => new Date().toISOString(),
    quota,
  );
  const runs: ConnectorPollRunResult[] = [];
  const seenCursors = new Set<string>();
  const kind = cursorKindFromPoll({
    older: options?.older,
    before: options?.before,
  });
  const syncState = await store.getSyncState(installation.id, stream.stream_key);
  const selected = pollCursorValue({
    kind,
    liveCursor: syncState?.live_cursor,
    historyCursor: syncState?.history_cursor,
  });
  const write = cursorWriteFor({ kind, seedHistory: false });
  for (let page = 0; page < maxPages; page += 1) {
    const run = await runner.poll({
      installation_id: installation.id,
      stream_key: stream.stream_key,
      lease_owner: `personal-api:${randomUUID()}`,
      lease_duration_ms: LEASE_MS,
      older: options?.older === true,
      latest: options?.latest === true,
      media: options?.media,
      before: options?.before,
      before_external_id: options?.before_external_id,
      ...(page === 0 && selected ? { cursor: selected } : {}),
      commit_cursor: write.lease,
      timeout_ms: connectorPollTimeoutMs(),
    });
    runs.push(run);
    if (run.status === "lease_unavailable") {
      // Another lane holds the lease; retry on the next tick without sticky-alert.
      break;
    }
    if (run.status === "throttled" || run.status === "unsupported_mode") {
      break;
    }
    if (run.status !== "completed") {
      break;
    }
    const historyPending =
      "poll_hint" in run && run.poll_hint?.history_pending === true;
    if (
      !sameLaneContinues({
        kind,
        hasMore: run.has_more === true,
        historyPending,
      }) ||
      !run.next_cursor
    ) {
      break;
    }
    if (seenCursors.has(run.next_cursor)) {
      break;
    }
    seenCursors.add(run.next_cursor);
    await yieldToEventLoop();
  }
  return runs;
}

export async function rememberPolledStream(
  store: ConnectorRuntimeStore,
  installation: ConnectorInstallation,
  stream: ConnectorStream,
  prior: { phase?: SyncPhase | null; history_cursor?: string | null } | null,
  options: {
    older?: boolean;
    before?: string | null;
    media?: boolean;
    idleMs?: number;
  },
  pages: ConnectorPollRunResult[],
): Promise<void> {
  await new SyncEngine(store).rememberResult(
    syncOutcomeForPoll(
      installation.id,
      {
        stream,
        prior,
        policy: historyPolicyFromConfig(installation.config),
        older: options.older,
        before: options.before,
        media: options.media,
        idleMs: options.idleMs,
      },
      { pages },
      new Date().toISOString(),
    ),
  );
}

export function safeErrorCode(error: unknown): string {
  if (error instanceof ChannelDriverError) {
    return error.code;
  }
  if (error instanceof Error) {
    return (
      error.name
        .replace(/Error$/, "")
        .replace(/([a-z])([A-Z])/g, "$1_$2")
        .toLowerCase() || "sync_failed"
    );
  }
  return "sync_failed";
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

export function summarizeRuns(runs: ConnectorPollRunResult[]): {
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
} {
  return runs.reduce(
    (acc, run) => {
      if (!("result" in run)) {
        return acc;
      }
      for (const record of run.result.records) {
        if (record.status === "accepted") {
          acc.accepted_count += 1;
        }
        if (record.status === "duplicate") {
          acc.duplicate_count += 1;
        }
        if (record.status === "quarantined") {
          acc.quarantined_count += 1;
        }
      }
      return acc;
    },
    { accepted_count: 0, duplicate_count: 0, quarantined_count: 0 },
  );
}
