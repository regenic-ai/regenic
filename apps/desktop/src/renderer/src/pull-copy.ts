import { t } from "../../shared/i18n.ts";
import type { KernelReachability } from "../../shared/connection-state.ts";
import type { EngineChipState, PersonalEngineView, PullStatusView } from "./types.ts";

export function engineChip(
  engine: PersonalEngineView | null,
  reachability: KernelReachability = "live",
): EngineChipState {
  if (!engine || engine.kernel === "stopped") {
    return "stopped";
  }
  if (reachability === "degraded") {
    return "degraded";
  }
  // Connector attempts (live or history) must not paint the kernel as stuck.
  // Freshness/backfill copy lives in pullProgressChip / pullStatusLabel.
  return "running";
}

export function pullStatusLabel(pull?: PullStatusView | null): string {
  if (!pull) {
    return t("sync.off");
  }
  if (pull.phase === "pulling") {
    const historyCount = pull.streams.filter(isHistoryWork).length;
    if (historyCount > 1) {
      return t("sync.historyCount", { count: historyCount });
    }
    const history = pull.streams.find(isHistoryWork);
    if (history?.label) {
      return t("sync.historyNamed", { label: history.label });
    }
    if (history) {
      return t("sync.history");
    }
    const live = pull.streams.find(
      (stream) => stream.phase === "pulling" && stream.work !== "history",
    );
    if (live?.label) {
      return t("sync.latestNamed", { label: live.label });
    }
    if (live) {
      return t("sync.latest");
    }
    return t("sync.pulling");
  }
  if (pull.catching_up_count > 1) {
    return t("sync.historyLeft", { count: pull.catching_up_count });
  }
  if (pull.catching_up_count === 1) {
    const active = pull.streams.find(
      (stream) => stream.phase === "catching_up" || stream.phase === "error",
    );
    return active?.label
      ? t("sync.historyNamed", { label: active.label })
      : t("sync.history");
  }
  if (pull.last_error) {
    return t("sync.retry");
  }
  if (pull.interval_ms) {
    return t("sync.every", { seconds: Math.round(pull.interval_ms / 1000) });
  }
  return t("sync.off");
}

/** Compact titlebar chip: only when history backfill or live pull is active. */
export function pullProgressChip(pull?: PullStatusView | null): string | null {
  if (!pull) {
    return null;
  }
  const historyActive =
    pull.catching_up_count > 0 ||
    pull.streams.some(
      (stream) => isHistoryWork(stream) || stream.phase === "catching_up",
    );
  const liveActive =
    pull.phase === "pulling" &&
    pull.streams.some(
      (stream) => stream.phase === "pulling" && stream.work === "live",
    );
  if (!historyActive && !liveActive) {
    return null;
  }
  return pullStatusLabel(pull);
}

export function threadSyncLabel(
  threadId: string,
  pull?: PullStatusView | null,
): string | null {
  const stream = pull?.streams.find((item) => item.thread_id === threadId);
  if (!stream) {
    return null;
  }
  if (stream.phase === "error") {
    return t("thread.syncInterrupted");
  }
  if (isHistoryWork(stream)) {
    return t("thread.syncOlder");
  }
  return null;
}

export function threadSyncTone(
  threadId: string,
  pull?: PullStatusView | null,
): "syncing" | "error" | null {
  const stream = pull?.streams.find((item) => item.thread_id === threadId);
  if (!stream) {
    return null;
  }
  if (stream.phase === "error") {
    return "error";
  }
  if (isHistoryWork(stream)) {
    return "syncing";
  }
  return null;
}

function isHistoryWork(stream: {
  work?: "live" | "history" | null;
}): boolean {
  return stream.work === "history";
}
