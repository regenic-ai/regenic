import type { PluginLocaleTable, CopyRef } from "./copy";
import type { PromptAnswer, ThreadPrompt } from "./attention";
import type { ConversationThread } from "./driver";
import type { ContentPart, JsonValue } from "./ingest";
import type { MessageKind, MessageTurn } from "./message";

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

export type WorkRunStatus =
  | "running"
  | "waiting_human"
  | "completed"
  | "failed"
  | "cancelled";

export interface ResultEnvelope {
  summary: string;
  content?: ContentPart[];
  evidence_event_ids?: string[];
}

export interface WorkRun {
  id: string;
  org_id: string;
  work_item_id: string;
  recipe_id: string;
  executor_type: string;
  external_run_id?: string;
  agent_thread_id?: string;
  status: WorkRunStatus;
  result?: ResultEnvelope;
  created_at: string;
  updated_at: string;
}

export interface ExecutorCapabilities {
  start: boolean;
  resume: boolean;
  status: boolean;
  prompts?: boolean;
  /**
   * Same-machine absentee agents can read a workspace file. The kernel may
   * pack a longer background and let the executor point at it instead of
   * stuffing the whole thread into stdin.
   */
  local_workspace?: boolean;
  /**
   * The inferior can notify instead of the kernel polling status.
   * After start, the kernel subscribes via ChannelDriver.waitThread.
   */
  wait?: boolean;
}

/**
 * Invoke schema owned by one TaskExecutor. The kernel stores values in
 * Recipe.executor_config and never reads the keys. The desktop only renders
 * this catalog. DSH, Cursor, and a connector-mounted agent each declare
 * their own fields.
 */
export interface ExecutorCatalogField {
  key: string;
  label: CopyRef;
  required?: boolean;
  placeholder?: CopyRef;
  default?: string;
  hint?: CopyRef;
  kind?: "text" | "textarea" | "select";
  options?: Array<{ value: string; label: CopyRef }>;
}

export interface ExecutorCatalogEntry {
  executor_type: string;
  label: CopyRef;
  description?: CopyRef;
  /** Section title above invoke fields. Desktop falls back to its own copy. */
  params_label?: CopyRef;
  source?: string;
  attach?: AttachMode;
  /** Local binding: pin spawnSysout to this connector installation. */
  installation_id?: string;
  kind?: "local_connector" | "http";
  fields: ExecutorCatalogField[];
}

export interface ExecutorContext {
  org_id: string;
  env: NodeJS.ProcessEnv;
  /** Absentee sysout. Not a Session. */
  spawnSysout(options?: { cwd?: string }): Promise<ConversationThread>;
  writeStdin(thread: ConversationThread, text: string): Promise<void>;
  listPrompts(thread: ConversationThread): Promise<ThreadPrompt[]>;
  readTranscript(sysoutId: string): Promise<Transcript | null>;
  /** Write files the local agent can read from cwd. Same machine only. */
  writeWorkFiles?(
    files: Record<string, string>,
    options?: { work_item_id?: string },
  ): Promise<{ cwd: string }>;
}

export interface WorkConversationEvidence {
  current?: string;
  current_line?: string;
  background?: string;
  omitted?: boolean;
}

/** Fields an executor may read. A full WorkItem remains assignable. */
export interface ExecutorWorkRef {
  id: string;
  thread_id: string;
  record_class: string;
  thread_facet: string;
}

/** Fields an executor may read. A full Recipe remains assignable. */
export interface ExecutorRecipeRef {
  id: string;
  executor_config: Record<string, JsonValue>;
}

export interface ExecutorStartInput {
  work_item: ExecutorWorkRef;
  recipe: ExecutorRecipeRef;
  evidence_text: string;
  conversation?: WorkConversationEvidence;
}

export interface ExecutorResumeInput {
  run: WorkRun;
  work_item: ExecutorWorkRef;
  recipe: ExecutorRecipeRef;
  answer?: PromptAnswer;
}

export interface ExecutorRunHandle {
  external_run_id: string;
  agent_thread_id?: string;
  status: WorkRunStatus;
  result?: ResultEnvelope;
  prompts?: ThreadPrompt[];
  transcript?: Transcript;
}

export function handleFromWait(
  wait: WaitStatus,
  ref: InferiorRef,
): ExecutorRunHandle {
  const transcript = wait.transcript;
  if (wait.state === "waiting_human") {
    return {
      external_run_id: ref.external_run_id,
      agent_thread_id: ref.sysout_id,
      status: "waiting_human",
      prompts: wait.prompts,
      transcript,
    };
  }
  if (wait.state === "exited") {
    return {
      external_run_id: ref.external_run_id,
      agent_thread_id: ref.sysout_id,
      status: wait.ok ? "completed" : "failed",
      result: wait.result,
      transcript,
    };
  }
  return {
    external_run_id: ref.external_run_id,
    agent_thread_id: ref.sysout_id,
    status: "running",
    transcript,
  };
}

export interface TaskExecutor {
  readonly executor_type: string;
  locales?(): readonly PluginLocaleTable[];
  capabilities(): ExecutorCapabilities;
  catalog(): ExecutorCatalogEntry;
  start(
    input: ExecutorStartInput,
    ctx: ExecutorContext,
  ): Promise<ExecutorRunHandle>;
  resume(
    input: ExecutorResumeInput,
    ctx: ExecutorContext,
  ): Promise<ExecutorRunHandle>;
  status(run: WorkRun, ctx: ExecutorContext): Promise<ExecutorRunHandle>;
  cancel?(run: WorkRun, ctx: ExecutorContext): Promise<void>;
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

export const WORK_EVIDENCE_OMITTED = "[Earlier messages omitted]";
export const WORK_CONVERSATION_FILENAME = "conversation.md";
export const WORK_AGENTS_FILENAME = "AGENTS.md";
export const WORK_AGENTS_INLINE_LIMIT = 4_000;
export const WORK_EVIDENCE_BACKGROUND_OPEN = "<background>";
export const WORK_EVIDENCE_BACKGROUND_CLOSE = "</background>";
export const WORK_EVIDENCE_CURRENT_OPEN = "<current>";
export const WORK_EVIDENCE_CURRENT_CLOSE = "</current>";
export const WORK_EVIDENCE_SPLIT_HINT =
  "Treat <background> as established context. Act on <current>.";
export const WORK_WORKSPACE_PULL_HINT =
  "Review the conversation in this workspace and work from it.";

export function wrapEvidenceSection(
  tagOpen: string,
  tagClose: string,
  body: string,
): string {
  return `${tagOpen}\n${body}\n${tagClose}`;
}

export function composeWorkspaceTaskEvidence(input: {
  current_line?: string;
}): string {
  const current = input.current_line?.trim();
  if (!current) {
    return WORK_WORKSPACE_PULL_HINT;
  }
  return wrapEvidenceSection(
    WORK_EVIDENCE_CURRENT_OPEN,
    WORK_EVIDENCE_CURRENT_CLOSE,
    current,
  );
}

/** @deprecated Use composeWorkspaceTaskEvidence. */
export function composeWorkspacePointerEvidence(input: {
  current_line?: string;
  omitted?: boolean;
}): string {
  void input.omitted;
  return composeWorkspaceTaskEvidence(input);
}

export function composeWorkspaceInstructionFiles(input: {
  background?: string;
  omitted?: boolean;
}): Record<string, string> {
  const background = input.background?.trim() ?? "";
  const omitted =
    input.omitted && !background.startsWith(WORK_EVIDENCE_OMITTED)
      ? `${WORK_EVIDENCE_OMITTED}\n\n`
      : "";
  const inline = Boolean(background) && background.length <= WORK_AGENTS_INLINE_LIMIT;
  const agents = [
    "This session handles one work item from a source chat.",
    "The user message is the task. Prior turns are established background.",
    inline
      ? "Prior turns follow. Use them as context. Do not restate them."
      : "Prior turns are in conversation.md. Read that file only if you need background. Do not restate it.",
    inline && background ? `\n## Prior turns\n\n${omitted}${background}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const files: Record<string, string> = { [WORK_AGENTS_FILENAME]: agents };
  if (background && !inline) {
    files[WORK_CONVERSATION_FILENAME] = `${omitted}${background}`.trim();
  }
  return files;
}

export async function stageConversationWorkspace(
  ctx: ExecutorContext,
  conversation: WorkConversationEvidence | undefined,
  workItemId?: string,
): Promise<{ cwd: string } | undefined> {
  const background = conversation?.background?.trim();
  if (!background || !ctx.writeWorkFiles) {
    return undefined;
  }
  return ctx.writeWorkFiles(
    composeWorkspaceInstructionFiles({
      background,
      omitted: conversation?.omitted,
    }),
    workItemId ? { work_item_id: workItemId } : undefined,
  );
}

export function formatWorkEvidence(input: {
  thread_id: string;
  record_class: string;
  thread_facet: string;
  source: string;
  text?: string;
  extra?: Record<string, JsonValue>;
}): string {
  const lines = [
    `Work item ${input.thread_id}`,
    `record_class=${input.record_class} thread_facet=${input.thread_facet} source=${input.source}`,
  ];
  if (input.text?.trim()) {
    lines.push("", input.text.trim());
  }
  if (input.extra && Object.keys(input.extra).length > 0) {
    lines.push("", JSON.stringify(input.extra));
  }
  return lines.join("\n");
}
