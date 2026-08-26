import { t } from "../../shared/i18n.ts";
import type { EngineChipState, PersonalEngineView, PullStatusView } from "./types.ts";

export function engineChip(engine: PersonalEngineView | null): EngineChipState {
  if (!engine || engine.kernel === "stopped") {
    return "stopped";
  }
  if (
    engine.pull?.phase === "pulling" ||
    (engine.pull?.catching_up_count ?? 0) > 0 ||
    engine.installations.some((item) => item.last_attempt?.status === "running")
  ) {
    return "syncing";
  }
  return "running";
}

export function pullStatusLabel(pull?: PullStatusView | null): string {
  if (!pull) {
    return t("sync.off");
  }
  if (pull.phase === "pulling") {
    if (pull.catching_up_count > 1) {
      return t("sync.syncingCount", { count: pull.catching_up_count });
    }
    const active = pull.streams.find(
      (stream) => stream.phase === "pulling" || stream.phase === "catching_up",
    );
    if (active?.label) {
      return t("sync.syncingNamed", { label: active.label });
    }
    return pull.catching_up_count === 1 ? t("sync.older") : t("sync.pulling");
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
  if (stream.phase === "pulling" || stream.phase === "catching_up") {
    return t("thread.syncOlder");
  }
  if (stream.phase === "error") {
    return t("thread.syncInterrupted");
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
  if (stream.phase === "pulling" || stream.phase === "catching_up") {
    return "syncing";
  }
  return null;
}
