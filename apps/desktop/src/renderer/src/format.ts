import type { EngineChipState, PersonalEngineView } from "./types";

export function previewText(text: string | undefined, fallback: string): string {
  const value = text?.replace(/\s+/g, " ").trim();
  return value && value.length > 0 ? value : fallback;
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function engineChip(engine: PersonalEngineView | null): EngineChipState {
  if (!engine || engine.kernel === "stopped") {
    return "stopped";
  }
  if (engine.installations.some((item) => item.last_attempt?.status === "running")) {
    return "syncing";
  }
  return "running";
}

export function chipLabel(state: EngineChipState): string {
  if (state === "running") {
    return "运行中";
  }
  if (state === "syncing") {
    return "同步中";
  }
  return "已停止";
}

export function connectorLabel(type: string): string {
  if (type === "slack-channel") {
    return "Slack";
  }
  if (type === "dsh-session") {
    return "DSH";
  }
  return type;
}

export function installationStatusLabel(
  status: "enabled" | "disabled" | "needs_attention",
): string {
  if (status === "enabled") {
    return "已启用";
  }
  if (status === "disabled") {
    return "已停用";
  }
  return "需处理";
}

export function connectorActionError(message: string): string {
  if (message.includes("already syncing") || message.includes("already leased")) {
    return "这条连接器正在同步";
  }
  if (message.includes("is disabled")) {
    return "连接器已停用，先启用再同步";
  }
  if (message.includes("missing from")) {
    return `缺少渠道凭证。${message}`;
  }
  if (message.includes("not found")) {
    return "找不到这条连接器";
  }
  if (message.includes("requires channel_id")) {
    return "Slack 需要填写频道 ID";
  }
  if (message.includes("requires session_id")) {
    return "DSH Web 需要填写 Session ID";
  }
  return message;
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
    return "还没有同步记录";
  }
  const when = formatTime(attempt.finished_at ?? attempt.started_at);
  if (attempt.status === "running") {
    return `同步中 · ${when}`;
  }
  if (attempt.status === "failed") {
    return `失败${attempt.error_code ? ` · ${attempt.error_code}` : ""} · ${when}`;
  }
  return `成功 · 接受 ${attempt.accepted_count} · ${when}`;
}
