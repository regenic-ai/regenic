import type { MessageKind, MessageTurn } from "./message-contract";
import type { ThreadPrompt } from "./thread-surface";
import {
  isActiveWorkStatus,
  type ResultEnvelope,
  type WorkItem,
  type WorkRunStatus,
} from "./work";

/** Plan 9 con vs rx; CTSS foreground vs absentee. */
export type AttachMode = "interactive" | "absentee";

export interface Transcript {
  kind: MessageKind;
  text?: string;
  activity?: string;
  turn?: MessageTurn;
}

/**
 * wait(2) / sd_notify.
 * The words in a bubble are not exit. Public DSH notify is turn/end, or a
 * dead session. An open turn or working bit stays running. Humans dismiss
 * a job; they do not fake exited.
 */
export type WaitStatus =
  | { state: "running"; transcript?: Transcript }
  | {
      state: "waiting_human";
      prompts: ThreadPrompt[];
      transcript?: Transcript;
    }
  | {
      state: "exited";
      ok: boolean;
      result?: ResultEnvelope;
      transcript?: Transcript;
    };

/** Sysout locator. Not a Session; absentee inferiors stay out of the inbox. */
export interface InferiorRef {
  external_run_id: string;
  sysout_id?: string;
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

/**
 * Public absentee wait. Speech is still not exit; DSH turn/end (or a gone
 * session) is notify. An open turn stays running even after an assistant face.
 */
export function waitFromAbsentee(input: {
  prompts: ThreadPrompt[];
  transcript: Transcript | null;
  alive?: boolean;
}): WaitStatus {
  const transcript = input.transcript ?? undefined;
  if (input.prompts.length > 0) {
    return {
      state: "waiting_human",
      prompts: input.prompts,
      transcript,
    };
  }
  if (transcript?.activity === "working" || transcript?.turn?.state === "open") {
    return { state: "running", transcript };
  }
  if (input.alive === false) {
    if (transcript?.turn?.state === "ended") {
      return exitedFromTranscript(transcript, transcript.turn.ok !== false);
    }
    return exitedFromTranscript(transcript, false);
  }
  if (transcript?.activity === "awaiting_user") {
    return {
      state: "waiting_human",
      prompts: [],
      transcript,
    };
  }
  if (transcript?.turn?.state === "ended") {
    return exitedFromTranscript(transcript, transcript.turn.ok !== false);
  }
  return { state: "running", transcript };
}

function exitedFromTranscript(
  transcript: Transcript | undefined,
  ok: boolean,
): WaitStatus {
  const summary = transcript?.text?.trim();
  return {
    state: "exited",
    ok,
    result: summary ? { summary } : undefined,
    transcript,
  };
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
  return [...pool].sort(byJobRecency)[0];
}

function byJobRecency(left: WorkItem, right: WorkItem): number {
  if (left.updated_at !== right.updated_at) {
    return left.updated_at < right.updated_at ? 1 : -1;
  }
  return left.id < right.id ? 1 : -1;
}
