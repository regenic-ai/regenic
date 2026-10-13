import type {
  AttachMode,
  InferiorRef,
  Transcript,
  WaitStatus,
} from "@regenic/connector-contract";
import type { MessageKind, MessageTurn } from "./message-contract";
import type { ThreadPrompt } from "./thread-surface";
import {
  isActiveWorkStatus,
  type WorkItem,
  type WorkRunStatus,
} from "./work";

export type { AttachMode, InferiorRef, Transcript, WaitStatus };
export { waitFromAbsentee } from "@regenic/connector-contract";

/**
 * Live wait face is the latest thread_status, not the latest speech.
 * DSH often emits turn/end and an assistant row at the same stamp.
 */
export function pickAbsenteeInboxRows<
  T extends {
    event: { operation: string };
    decision: { reason_codes: readonly string[] };
  },
>(items: readonly T[]): { live?: T; visible?: T } {
  const newest = [...items]
    .reverse()
    .filter((row) => row.event.operation !== "tombstone");
  const live =
    newest.find((row) => row.decision.reason_codes.includes("thread_status")) ??
    newest[0];
  const visible = newest.find(
    (row) => !row.decision.reason_codes.includes("thread_status"),
  );
  return { live, visible };
}

/**
 * Latest sysout face for absentee wait. Speech is not exit. A leftover
 * `thread_status` row without an open turn or working bit is not invented
 * working — fall through to the visible body and stay running until
 * `turn/end` or dismiss.
 */
export function transcriptFromAbsenteeLive(input: {
  liveKind?: MessageKind;
  liveActivity?: string;
  liveTurn?: MessageTurn;
  visibleKind?: MessageKind;
  visibleText?: string;
  visibleActivity?: string;
}): Transcript {
  if (input.liveTurn?.state === "open" || input.liveActivity === "working") {
    return {
      kind: input.liveKind ?? "system",
      activity: "working",
      turn: { state: "open" },
    };
  }
  if (input.liveTurn?.state === "ended") {
    return {
      kind: input.visibleKind ?? "system",
      text: input.visibleText,
      turn: input.liveTurn,
    };
  }
  return {
    kind: input.visibleKind ?? "system",
    text: input.visibleText,
    activity: input.visibleActivity,
  };
}

export function waitFromTranscript(input: {
  prompts: ThreadPrompt[];
  transcript: Transcript | null;
}): WaitStatus {
  if (input.prompts.length > 0) {
    return {
      state: "waiting_human",
      prompts: input.prompts,
      transcript: input.transcript ?? undefined,
    };
  }
  return { state: "running", transcript: input.transcript ?? undefined };
}

export function runStatusFromWait(wait: WaitStatus): WorkRunStatus {
  if (wait.state === "waiting_human") {
    return "waiting_human";
  }
  if (wait.state === "exited") {
    return wait.ok ? "completed" : "failed";
  }
  return "running";
}

/**
 * Session face: one foreground job, like tcsetpgrp.
 * Identity stays on the job; the session only points at the current one.
 */
export function currentJobOnSession(
  items: readonly WorkItem[],
  threadId: string,
): WorkItem | undefined {
  const onSession = items.filter((item) => item.thread_id === threadId);
  const active = onSession.filter((item) => isActiveWorkStatus(item.status));
  const pool = active.length > 0 ? active : onSession;
  return [...pool].sort(byJobForeground)[0];
}

function byJobForeground(left: WorkItem, right: WorkItem): number {
  if (left.created_at !== right.created_at) {
    return left.created_at < right.created_at ? 1 : -1;
  }
  return left.id < right.id ? 1 : -1;
}
