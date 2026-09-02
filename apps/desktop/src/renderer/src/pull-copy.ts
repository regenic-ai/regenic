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
  if (engine.installations.some((item) => item.last_attempt?.status === "running")) {
    return "syncing";
  }
  if (engine.pull?.streams.some((stream) => stream.work === "history")) {
    return "syncing";
  }
  return "running";
}

export function pullStatusLabel(pull?: PullStatusView | null): string {
  if (!pull) {
    return t("sync.off");
  }
  if (pull.phase === "pulling") {
    const historyCount = pull.streams.filter(isHistoryWork).length;
    if (historyCount > 1) {
      return t("sync.syncingCount", { count: historyCount });
    }
    const history = pull.streams.find(isHistoryWork);
    if (history?.label) {
      return t("sync.syncingNamed", { label: history.label });
    }
    if (history) {
      return t("sync.older");
    }
    const live = pull.streams.find((stream) => stream.phase === "pulling");
    if (live?.label) {
      return t("sync.syncingNamed", { label: live.label });
    }
    return t("sync.pulling");
  }
  if (pull.catching_up_count > 1) {
    return t("sync.catchingLeft", { count: pull.catching_up_count });
  }
  if (pull.catching_up_count === 1) {
    const active = pull.streams.find(
      (stream) => stream.phase === "catching_up" || stream.phase === "error",
    );
    return active?.label
      ? t("sync.catchingNamed", { label: active.label })
      : t("sync.catching");
  }
  if (pull.last_error) {
    return t("sync.retry");
  }
  if (pull.interval_ms) {
    return t("sync.every", { seconds: Math.round(pull.interval_ms / 1000) });
  }
  return t("sync.off");
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
