import type { WorkItemStatus } from "./work";

export const ATTENTION_CLASSES = [
  "waiting_you",
  "needs_ack",
  "running",
  "unread",
  "quiet",
] as const;

export type AttentionClass = (typeof ATTENTION_CLASSES)[number];

const ATTENTION_RANK: Record<AttentionClass, number> = {
  waiting_you: 0,
  needs_ack: 1,
  running: 2,
  unread: 3,
  quiet: 4,
};

export function attentionOf(input: {
  prompts?: number;
  awaiting_user?: boolean;
  unread?: boolean;
  work_status?: WorkItemStatus;
  can_write_back?: boolean;
  has_result?: boolean;
  activity?: string;
}): AttentionClass {
  if (
    (input.prompts ?? 0) > 0 ||
    input.awaiting_user ||
    input.work_status === "waiting_human" ||
    input.work_status === "failed"
  ) {
    return "waiting_you";
  }
  if (
    input.work_status === "done" &&
    input.has_result &&
    input.can_write_back === false
  ) {
    return "needs_ack";
  }
  if (input.work_status === "running" || input.activity === "working") {
    return "running";
  }
  if (input.unread) {
    return "unread";
  }
  return "quiet";
}

export function compareAttention(
  left: AttentionClass,
  right: AttentionClass,
): number {
  return ATTENTION_RANK[left] - ATTENTION_RANK[right];
}
