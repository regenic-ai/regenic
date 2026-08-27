import { activeLocale, t } from "../../shared/i18n.ts";
import { localeTag } from "../../shared/locale.ts";
import { firstLine } from "./message-view";
import type { EngineChipState } from "./types";

export {
  engineChip,
  pullStatusLabel,
  threadSyncLabel,
  threadSyncTone,
} from "./pull-copy.ts";

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

export function formatChatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(
    localeTag(activeLocale()),
    sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" },
  ).format(date);
}

export function chipLabel(state: EngineChipState): string {
  if (state === "running") {
    return t("chip.running");
  }
  if (state === "syncing") {
    return t("chip.syncing");
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

export function connectorActionError(message: string): string {
  if (message.includes("already installed")) {
    return "This connector is already installed";
  }
  if (message.includes("already syncing") || message.includes("already leased")) {
    return "This connector is already syncing";
  }
  if (message.includes("is disabled")) {
    return "Connector is disabled. Enable it before syncing.";
  }
  if (message.includes("missing from")) {
    return `Missing channel credentials. ${message}`;
  }
  if (message.includes("not found")) {
    return "Connector not found";
  }
  if (message.includes("requires channel_id")) {
    return "Slack requires a channel ID";
  }
  if (message.includes("requires session_id")) {
    return "DSH web requires a session ID";
  }
  if (message.includes("requires chat_id") || message.includes("at least one group")) {
    return "Choose all groups or tick the ones to sync";
  }
  return message;
}

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
