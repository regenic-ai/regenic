import { t } from "../../shared/i18n.ts";
import type { KernelReachability } from "../../shared/connection-state.ts";
import { hasConnectorFailure } from "./connector-alerts.ts";
import type { EngineChipState, PersonalEngineView, PullStatusView } from "./types.ts";

export function engineChip(
  engine: PersonalEngineView | null,
  reachability: KernelReachability = "live",
): EngineChipState {
  if (!engine || engine.kernel === "stopped") {
    return "stopped";
  }
  if (hasConnectorFailure(engine)) {
    return "error";
  }
  if (reachability === "degraded") {
    return "degraded";
  }
  // Connector attempts (live or history) must not paint the kernel as stuck.
  // Freshness/backfill copy lives in pullProgressChip / pullStatusLabel.
  return "running";
}

export function pullStatusLabel(
  pull?: PullStatusView | null,
  titles: ReadonlyArray<{ id: string; title: string }> = [],
): string {
  if (!pull) {
    return t("sync.off");
  }
  if (pull.phase === "pulling") {
    const historyStreams = pull.streams.filter(isHistoryWork);
    // The wave is not how many conversations remain. Name one chat that is
    // moving; the coverage row owns the remainder.
    if (historyStreams.length > 0) {
      return historyActivityLabel(historyStreams, titles);
    }
    const media = pullingMediaStream(pull);
    const mediaName = media ? titleForStream(media, titles) : null;
    if (mediaName) {
      return t("sync.attachmentsNamed", { label: mediaName });
    }
    if (media) {
      return t("sync.attachments");
    }
    return t("sync.pulling");
  }
  if (pull.catching_up_count > 0) {
    const active = pull.streams.filter(
      (stream) => stream.phase === "catching_up" || stream.phase === "error",
    );
    return historyActivityLabel(active, titles);
  }
  if (pull.last_error) {
    return t("sync.retry");
  }
  if (!pull.interval_ms) {
    return t("sync.off");
  }
  return t("sync.idle");
}

/** Titlebar chip, with the inbox title of the stream that is actually pulling. */
export function namedPullProgress(
  pull: PullStatusView | null | undefined,
  titles: ReadonlyArray<{ id: string; title: string }>,
): string | null {
  const chip = pullProgressChip(pull);
  if (!chip || !pull) {
    return chip;
  }
  const stream = pullingMediaStream(pull) ?? pullingHistoryStream(pull);
  const title = stream ? titleForStream(stream, titles) : null;
  if (stream && title) {
    return isMediaWork(stream)
      ? t("sync.attachmentsNamed", { label: title })
      : t("sync.historyNamed", { label: title });
  }
  return nameSyncLabel(chip, titles);
}

function pullingMediaStream(pull: PullStatusView) {
  return pull.streams.find(
    (stream) => stream.phase === "pulling" && isMediaWork(stream),
  );
}

function pullingHistoryStream(pull: PullStatusView) {
  return pull.streams.find(
    (stream) => isHistoryWork(stream) || stream.phase === "catching_up",
  );
}

function historyActivityLabel(
  streams: ReadonlyArray<{ thread_id: string | null; label: string | null }>,
  titles: ReadonlyArray<{ id: string; title: string }>,
): string {
  for (const stream of streams) {
    const name = titleForStream(stream, titles);
    if (name) {
      return t("sync.historyNamed", { label: name });
    }
  }
  return t("sync.history");
}

function titleForStream(
  stream: { thread_id: string | null; label: string | null },
  titles: ReadonlyArray<{ id: string; title: string }>,
): string | null {
  const key = chatKey(stream.thread_id);
  const hit = titles.find(
    (item) => item.id === stream.thread_id || (key != null && item.id.endsWith(key)),
  );
  const fromInbox = hit?.title?.trim();
  if (fromInbox && !opaqueChatLabel(fromInbox)) {
    return fromInbox;
  }
  const label = stream.label?.trim();
  if (label && !opaqueChatLabel(label)) {
    return label;
  }
  return null;
}

function opaqueChatLabel(value: string): boolean {
  return /^oc_[0-9a-f]+$/i.test(value.trim());
}

/** Replace a raw Feishu chat id in a status label with the inbox title. */
export function nameSyncLabel(
  label: string | null,
  titles: ReadonlyArray<{ id: string; title: string }>,
): string | null {
  if (!label) {
    return null;
  }
  const match = /oc_[0-9a-f]+/i.exec(label);
  if (!match) {
    return label;
  }
  const title = titles.find((item) => item.id.includes(match[0]))?.title?.trim();
  const named = title
    ? label.replace(match[0], title)
    : label.replace(match[0], "").replace(/[·\s]+$/u, "").trim();
  return named || null;
}

/** Compact titlebar chip: only while older messages or attachments are catching up. */
export function pullProgressChip(pull?: PullStatusView | null): string | null {
  if (!pull) {
    return null;
  }
  const historyActive =
    pull.catching_up_count > 0 ||
    pull.streams.some(
      (stream) => isHistoryWork(stream) || stream.phase === "catching_up",
    );
  const mediaActive = pull.streams.some(
    (stream) => stream.phase === "pulling" && isMediaWork(stream),
  );
  if (!historyActive && !mediaActive) {
    return null;
  }
  return pullStatusLabel(pull);
}

export function threadSyncLabel(
  threadId: string,
  pull?: PullStatusView | null,
): string | null {
  const stream = pullingStream(threadId, pull) ?? streamForThread(threadId, pull);
  if (!stream) {
    return null;
  }
  if (stream.phase === "error") {
    return t("thread.syncInterrupted");
  }
  if (isHistoryWork(stream)) {
    return t("thread.syncOlder");
  }
  if (isMediaWork(stream) && stream.phase === "pulling") {
    return t("thread.syncAttachments");
  }
  return null;
}

export function threadSyncTone(
  threadId: string,
  pull?: PullStatusView | null,
): "syncing" | "error" | null {
  const stream = pullingStream(threadId, pull) ?? streamForThread(threadId, pull);
  if (!stream) {
    return null;
  }
  if (stream.phase === "error") {
    return "error";
  }
  if (isHistoryWork(stream) || (isMediaWork(stream) && stream.phase === "pulling")) {
    return "syncing";
  }
  return null;
}

export function threadIsSyncing(
  threadId: string,
  pull?: PullStatusView | null,
): boolean {
  const stream = pullingStream(threadId, pull);
  return stream != null && (isHistoryWork(stream) || isMediaWork(stream));
}

/** Drop live pulling marks for every thread except the one just opened. */
export function releaseOtherLivePulls(
  pull: PullStatusView | null | undefined,
  threadId: string,
): PullStatusView | null | undefined {
  if (!pull) {
    return pull;
  }
  let changed = false;
  const streams = pull.streams.map((stream) => {
    if (
      stream.phase === "pulling" &&
      stream.work === "live" &&
      stream.thread_id &&
      stream.thread_id !== threadId
    ) {
      changed = true;
      return { ...stream, phase: "idle" as const, work: null };
    }
    return stream;
  });
  if (!changed) {
    return pull;
  }
  const stillPulling = streams.some((stream) => stream.phase === "pulling");
  return {
    ...pull,
    phase: stillPulling ? pull.phase : "idle",
    streams,
  };
}

function pullingStream(threadId: string, pull?: PullStatusView | null) {
  return pull?.streams.find(
    (stream) => stream.phase === "pulling" && streamMatchesThread(stream, threadId),
  );
}

function streamForThread(threadId: string, pull?: PullStatusView | null) {
  return pull?.streams.find((stream) => streamMatchesThread(stream, threadId));
}

function streamMatchesThread(
  stream: { thread_id: string | null; label: string | null },
  threadId: string,
): boolean {
  if (stream.thread_id === threadId) {
    return true;
  }
  const threadKey = chatKey(threadId);
  const streamKey = chatKey(stream.thread_id) ?? chatKey(stream.label);
  return Boolean(threadKey && streamKey && threadKey === streamKey);
}

function chatKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const bare = trimmed.includes(":") ? trimmed.slice(trimmed.lastIndexOf(":") + 1) : trimmed;
  return bare || null;
}

function isHistoryWork(stream: {
  work?: "live" | "history" | "media" | null;
}): boolean {
  return stream.work === "history";
}

function isMediaWork(stream: {
  work?: "live" | "history" | "media" | null;
}): boolean {
  return stream.work === "media";
}
