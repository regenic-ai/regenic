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
  return new Intl.DateTimeFormat("en-US", {
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
    "en-US",
    sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" },
  ).format(date);
}

export function chipLabel(state: EngineChipState): string {
  if (state === "running") {
    return "Running";
  }
  if (state === "syncing") {
    return "Syncing";
  }
  return "Stopped";
}

export function connectorLabel(type: string): string {
  if (type === "slack-channel") {
    return "Slack";
  }
  if (type === "dsh-session") {
    return "DSH";
  }
  if (type === "feishu-chat") {
    return "Feishu";
  }
  return type;
}

export function installationStatusLabel(
  status: "enabled" | "disabled" | "needs_attention",
): string {
  if (status === "enabled") {
    return "Enabled";
  }
  if (status === "disabled") {
    return "Disabled";
  }
  return "Needs attention";
}

export function connectorActionError(message: string): string {
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
    return "Attention";
  }
  if (kind === "blocked") {
    return "Blocked";
  }
  return "Clear";
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
    return "No sync yet";
  }
  const when = formatTime(attempt.finished_at ?? attempt.started_at);
  if (attempt.status === "running") {
    return `Syncing · ${when}`;
  }
  if (attempt.status === "failed") {
    return `Failed${attempt.error_code ? ` · ${attempt.error_code}` : ""} · ${when}`;
  }
  return `OK · accepted ${attempt.accepted_count} · ${when}`;
}
