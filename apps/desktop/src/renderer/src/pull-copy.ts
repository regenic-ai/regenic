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
    return "off";
  }
  if (pull.phase === "pulling") {
    if (pull.catching_up_count > 1) {
      return `Syncing ${pull.catching_up_count} conversations`;
    }
    const active = pull.streams.find(
      (stream) => stream.phase === "pulling" || stream.phase === "catching_up",
    );
    if (active?.label) {
      return `Syncing ${active.label}`;
    }
    return pull.catching_up_count === 1 ? "Syncing older messages" : "Pulling";
  }
  if (pull.catching_up_count > 1) {
    return `Catching up · ${pull.catching_up_count} left`;
  }
  if (pull.catching_up_count === 1) {
    const active = pull.streams.find(
      (stream) => stream.phase === "catching_up" || stream.phase === "error",
    );
    return active?.label ? `Catching up · ${active.label}` : "Catching up";
  }
  if (pull.last_error) {
    return "Retrying after a drop";
  }
  if (pull.interval_ms) {
    return `every ${Math.round(pull.interval_ms / 1000)}s`;
  }
  return "off";
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
    return "Syncing older messages";
  }
  if (stream.phase === "error") {
    return "Sync interrupted · retrying";
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
