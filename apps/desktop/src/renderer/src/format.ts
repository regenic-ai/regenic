import { activeLocale, t } from "../../shared/i18n.ts";
import { localeTag } from "../../shared/locale.ts";
import { firstLine } from "./message-view.ts";
import type { EngineChipState } from "./types.ts";

export {
  engineChip,
  pullStatusLabel,
  threadSyncLabel,
  threadSyncTone,
} from "./pull-copy.ts";

export {
  aggregateInstallationSync,
  syncProgressSummary,
  syncProgressTone,
} from "./sync-copy.ts";

export function previewText(text: string | undefined, fallback: string): string {
  return firstLine(text, 88) || fallback;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(localeTag(activeLocale()), {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function chatTimeFormatOptions(
  date: Date,
  now: Date,
): Intl.DateTimeFormatOptions {
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return { hour: "numeric", minute: "2-digit" };
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  if (sameYear) {
    return { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" };
  }
  return {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
}

export function formatNextRunWhen(
  iso: string | undefined,
  now = new Date(),
): "due" | string | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  if (date.getTime() <= now.getTime() + 30_000) {
    return "due";
  }
  return new Intl.DateTimeFormat(
    localeTag(activeLocale()),
    chatTimeFormatOptions(date, now),
  ).format(date);
}

export function formatChatTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat(
    localeTag(activeLocale()),
    chatTimeFormatOptions(date, now),
  ).format(date);
}

export function chipLabel(state: EngineChipState): string {
  if (state === "running") {
    return t("chip.running");
  }
  if (state === "syncing") {
    return t("chip.syncing");
  }
  if (state === "degraded") {
    return t("chip.degraded");
  }
  return t("chip.stopped");
}

export function installationStatusLabel(
  status: "enabled" | "disabled" | "needs_attention",
): string {
  if (status === "enabled") {
    return t("status.enabled");
  }
  if (status === "disabled") {
    return t("status.disabled");
  }
  return t("status.needsAttention");
}

export {
  connectorActionError,
  networkWatchHint,
} from "./connector-errors.ts";

export {
  diskWatchCopy,
  memoryWatchCopy,
} from "../../shared/host-watch.ts";

export function networkWatchLabel(kind: string | undefined): string {
  if (kind === "proxy") {
    return t("network.attention");
  }
  if (kind === "blocked") {
    return t("network.blocked");
  }
  return t("network.clear");
}

export function attemptSummary(
  attempt: {
    status: string;
    accepted_count: number;
    started_at: string;
    finished_at?: string;
    error_code?: string;
  } | null,
): string {
  if (!attempt) {
    return t("sync.none");
  }
  const when = formatTime(attempt.finished_at ?? attempt.started_at);
  if (attempt.status === "running") {
    return t("sync.syncingWhen", { when });
  }
  if (attempt.status === "failed") {
    return t("sync.failedWhen", {
      code: attempt.error_code ? ` · ${attempt.error_code}` : "",
      when,
    });
  }
  return t("sync.okWhen", { count: attempt.accepted_count, when });
}
