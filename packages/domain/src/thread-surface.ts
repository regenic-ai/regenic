import type { ConversationPref, EventRecord } from "./ingestion";
import {
  isLocalOutboundId,
  type MessageDirection,
  type ThreadActivity,
} from "./message-contract";

export type PromptPresentation = "choice" | "approval" | "plan_review";

export interface PromptOption {
  label: string;
  description?: string;
  /** Presentation-only. `plan_review` points at the affirmative option. */
  emphasized?: boolean;
}

export interface PromptQuestion {
  id: string;
  prompt: string;
  options?: PromptOption[];
  multi_select?: boolean;
  allow_custom?: boolean;
}

export interface ThreadPrompt {
  prompt_id: string;
  presentation: PromptPresentation;
  title?: string;
  detail?: string;
  questions: PromptQuestion[];
}

export interface PromptAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

export interface PromptAnswer {
  prompt_id: string;
  answers: PromptAnswerItem[];
}

export interface ThreadAttention {
  unread: boolean;
  unread_count?: number;
  mentioned?: boolean;
}

/** Peer read of my outbound. Not the same as my unread of their inbound. */
export type ReceiptState = "sent" | "read";

export interface MessageReceipt {
  state: ReceiptState;
  read_at?: string;
  read_count?: number;
}

export function isReceiptState(value: unknown): value is ReceiptState {
  return value === "sent" || value === "read";
}

export function normalizeMessageReceipt(value: unknown): MessageReceipt | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as { state?: unknown; read_at?: unknown; read_count?: unknown };
  if (!isReceiptState(record.state)) {
    return undefined;
  }
  return {
    state: record.state,
    ...(typeof record.read_at === "string" && record.read_at.trim()
      ? { read_at: record.read_at.trim() }
      : {}),
    ...(typeof record.read_count === "number" && record.read_count > 0
      ? { read_count: record.read_count }
      : {}),
  };
}

export interface AttentionAck {
  last_read_at?: string;
  last_read_external_id?: string;
}

export interface ThreadInboundCursor {
  external_id: string;
  occurred_at: string;
}

export interface ThreadInboundScan {
  thread_id: string;
  external_id: string;
  occurred_at: string;
  operation?: EventRecord["operation"];
  direction?: MessageDirection;
  activity?: ThreadActivity;
}

export function isPromptPresentation(value: unknown): value is PromptPresentation {
  return value === "choice" || value === "approval" || value === "plan_review";
}

export function threadIdOf(thread: { source: string; target: string }): string {
  return `${thread.source}:${thread.target}`;
}

export function isVisibleInbound(input: {
  external_id: string;
  operation?: EventRecord["operation"];
  direction?: MessageDirection;
  activity?: ThreadActivity;
}): boolean {
  if (input.operation === "tombstone" || input.activity === "working") {
    return false;
  }
  if (input.direction === "outbound") {
    return false;
  }
  if (input.direction === "inbound") {
    return true;
  }
  return !isLocalOutboundId(input.external_id);
}

export function collectLatestInbound(
  items: readonly ThreadInboundScan[],
): Map<string, ThreadInboundCursor> {
  const latest = new Map<string, ThreadInboundCursor>();
  for (const item of items) {
    const threadId = item.thread_id.trim();
    if (!threadId || !isVisibleInbound(item)) {
      continue;
    }
    const current = latest.get(threadId);
    if (
      !current ||
      item.occurred_at > current.occurred_at ||
      (item.occurred_at === current.occurred_at &&
        item.external_id > current.external_id)
    ) {
      latest.set(threadId, {
        external_id: item.external_id,
        occurred_at: item.occurred_at,
      });
    }
  }
  return latest;
}

/**
 * Single-select: custom overrides selected (empty selected).
 * Multi-select may keep both. Presentation contract, not a channel rule.
 */
export function normalizePromptAnswers(
  questions: readonly PromptQuestion[],
  answers: readonly PromptAnswerItem[],
): PromptAnswerItem[] {
  return answers.map((item) => {
    const question = questions.find((entry) => entry.id === item.id);
    const custom = item.custom?.replace(/\s+/g, " ").trim();
    const selected = Array.isArray(item.selected)
      ? item.selected.filter((label) => typeof label === "string" && label.trim())
      : [];
    if (!question?.multi_select && custom) {
      return { id: item.id, selected: [], custom };
    }
    return {
      id: item.id,
      selected,
      ...(custom ? { custom } : {}),
    };
  });
}

export function computeThreadUnread(input: {
  source?: ThreadAttention;
  pref?: Pick<ConversationPref, "last_read_at" | "last_read_external_id"> | null;
  latestInbound?: ThreadInboundCursor;
  activity?: ThreadActivity;
  prompts?: ThreadPrompt[];
}): ThreadAttention {
  if ((input.prompts?.length ?? 0) > 0 || input.activity === "awaiting_user") {
    const count = Math.max(1, input.source?.unread_count ?? 1);
    return { unread: true, unread_count: count, mentioned: input.source?.mentioned };
  }
  if (input.latestInbound) {
    const local = unreadFromLocalCursor(input.pref, input.latestInbound);
    if (local.unread) {
      return {
        unread: true,
        unread_count: Math.max(1, input.source?.unread_count ?? 1),
        mentioned: input.source?.mentioned,
      };
    }
    return { unread: false, mentioned: input.source?.mentioned };
  }
  // Source overlays may only add unread. A Feishu "already read" must not
  // hide a never-opened thread just because the latest inbound is missing.
  if (input.source?.unread) {
    return {
      unread: true,
      unread_count: Math.max(1, input.source.unread_count ?? 1),
      mentioned: input.source.mentioned,
    };
  }
  return { unread: false, mentioned: input.source?.mentioned };
}

function unreadFromLocalCursor(
  pref: Pick<ConversationPref, "last_read_at" | "last_read_external_id"> | null | undefined,
  latestInbound: ThreadInboundCursor,
): ThreadAttention {
  const readId = pref?.last_read_external_id?.trim() ?? "";
  const readAt = pref?.last_read_at?.trim() ?? "";
  if (!readId && !readAt) {
    return { unread: true, unread_count: 1 };
  }
  if (readId && readId === latestInbound.external_id) {
    return { unread: false };
  }
  if (readAt && latestInbound.occurred_at <= readAt) {
    return { unread: false };
  }
  return { unread: true, unread_count: 1 };
}

export function formatSurfaceGeneration(parts: Array<string | number | undefined>): string {
  return parts
    .map((part) => String(part ?? "").replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0)
    .join(",");
}

export function withSurfaceGeneration(digest: string, generation: string): string {
  const trimmed = generation.replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return digest;
  }
  const marker = "&s=";
  const cut = digest.indexOf(marker);
  const base = cut >= 0 ? digest.slice(0, cut) : digest;
  return `${base}${marker}${trimmed}`;
}
