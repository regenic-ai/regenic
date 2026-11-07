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
  start_state?: "pending" | "submitted" | "uncertain";
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
 * Executor-specific invoke schema. The shared task instruction is configured
 * separately and is not declared as a catalog field.
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
  /** Host-owned local binding, also used to pin spawnSysout. */
  installation_id?: string;
  kind?: "local_connector" | "http";
  fields: ExecutorCatalogField[];
}

export interface ExecutorContext {
  org_id: string;
  /**
   * Host-owned pinned connector installation for a local executor, not recipe
   * configuration. Absent for unpinned and HTTP executors. Direct runtimes must
   * require it and verify that an existing run belongs to this org/installation.
   */
  readonly installation_id?: string;
  env: NodeJS.ProcessEnv;
  /** Absentee sysout. Not a Session. */
  spawnSysout(options?: {
    cwd?: string;
    mcp_servers?: Record<string, WorkMcpServer>;
  }): Promise<ConversationThread>;
  writeStdin(thread: ConversationThread, text: string): Promise<void>;
  listPrompts(thread: ConversationThread): Promise<ThreadPrompt[]>;
  readTranscript(sysoutId: string): Promise<Transcript | null>;
  /**
   * Whether spawnSysout honors `mcp_servers`, i.e. the spawned agent can call
   * the context tools itself. Absent means no.
   */
  sysoutSupportsMcp?(): Promise<boolean>;
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
  /** Earlier runs on this work item, newest first (formatWorkRunHistory). */
  history?: string;
  /** Where the task came from, so a self-serving agent can read around it. */
  task?: WorkTaskRef;
  /** Context tools a local agent may call during this run. */
  access?: WorkContextAccess;
}

export interface WorkTaskRef {
  thread_id: string;
  event_id?: string;
  title?: string;
  channel?: string;
}

/** HTTP MCP server config, as Cursor, Claude Code and DSH accept it. */
export interface WorkMcpServer {
  url: string;
  headers?: Record<string, string>;
}

export interface WorkContextAccess {
  /** Streamable HTTP MCP endpoint on this machine. */
  url: string;
  run_id: string;
  /** Bearer valid only while this run is running or waiting on a human. */
  run_token: string;
  /**
   * Read-only key for agents whose MCP config outlives one run (DSH profile).
   * Every call made with it must name an active run_id.
   */
  agent_key?: string;
}

export const WORK_CONTEXT_MCP_SERVER = "regenic-context";
/**
 * Non-MCP method on the context endpoint. With the agent key it returns
 * `{ agent_connected_at }`: when an agent holding that key last listed tools.
 */
export const WORK_CONTEXT_AGENT_STATUS_METHOD = "regenic/agent_status";

export function workContextMcpServers(
  access: WorkContextAccess,
): Record<string, WorkMcpServer> {
  return {
    [WORK_CONTEXT_MCP_SERVER]: {
      url: access.url,
      headers: { Authorization: `Bearer ${access.run_token}` },
    },
  };
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
  /** Durable kernel run identity, allocated before any external side effect. */
  run_id?: string;
  work_item: ExecutorWorkRef;
  recipe: ExecutorRecipeRef;
  /** Shared rule instruction; falls back to executor_config.prompt/instruction for old callers. */
  task_instruction?: string;
  evidence_text: string;
  conversation?: WorkConversationEvidence;
}

export function taskInstructionOf(
  config: Record<string, JsonValue> | undefined,
): string | undefined {
  for (const key of ["prompt", "instruction"]) {
    const value = config?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
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
  /** Whether the agent can look up chat context itself (Mode 1) when a recipe includes context. */
  contextSelfServe?(ctx: ExecutorContext): Promise<boolean>;
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
export const WORK_EVIDENCE_GAP = "[Messages omitted]";
export const WORK_EVIDENCE_AFTER_CURRENT = "[Sent after the current message]";
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

export const WORK_HISTORY_FILENAME = "history.md";

/** How a self-serving agent reaches the context tools for this run. */
export interface WorkSelfServe {
  /** Set when the agent's key spans runs: every tool call must pass it. */
  run_id?: string;
}

export function composeWorkspaceInstructionFiles(input: {
  background?: string;
  omitted?: boolean;
  history?: string;
  task?: WorkTaskRef;
  /** The agent can call the context tools; nothing from the chat is pushed. */
  self_serve?: WorkSelfServe;
}): Record<string, string> {
  const history = input.history?.trim() ?? "";
  const historyLine = history
    ? `Earlier runs on this work item and their results are in ${WORK_HISTORY_FILENAME}. Do not redo finished work.`
    : "";
  if (input.self_serve && input.task) {
    const files: Record<string, string> = {
      [WORK_AGENTS_FILENAME]: selfServeAgents(input.task, input.self_serve, historyLine),
    };
    if (history) files[WORK_HISTORY_FILENAME] = history;
    return files;
  }
  const background = input.background?.trim() ?? "";
  const omitted =
    input.omitted && !background.startsWith(WORK_EVIDENCE_OMITTED)
      ? `${WORK_EVIDENCE_OMITTED}\n\n`
      : "";
  const inline = Boolean(background) && background.length <= WORK_AGENTS_INLINE_LIMIT;
  const agents = [
    "This session handles one work item from a source chat.",
    "The user message is the task. Prior turns are established background.",
    !background
      ? ""
      : inline
        ? "Prior turns follow. Use them as context. Do not restate them."
        : `Prior turns are in ${WORK_CONVERSATION_FILENAME}. Read that file only if you need background. Do not restate it.`,
    background && input.omitted
      ? "Older messages in this chat were left out. Ask before acting on anything that depends on them."
      : "",
    historyLine,
    inline && background ? `\n## Prior turns\n\n${omitted}${background}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const files: Record<string, string> = { [WORK_AGENTS_FILENAME]: agents };
  if (background && !inline) {
    files[WORK_CONVERSATION_FILENAME] = `${omitted}${background}`.trim();
  }
  if (history) files[WORK_HISTORY_FILENAME] = history;
  return files;
}

function selfServeAgents(
  task: WorkTaskRef,
  selfServe: WorkSelfServe,
  historyLine: string,
): string {
  const where = [task.channel, task.title]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" · ");
  const ids = [
    `thread_id: ${task.thread_id}`,
    task.event_id ? `current event_id: ${task.event_id}` : "",
    selfServe.run_id ? `run_id: ${selfServe.run_id}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const tool = (name: string) => `${WORK_CONTEXT_MCP_SERVER} ${name}`;
  return [
    "This session handles one work item from a source chat.",
    "The user message is the task. Only the current message is included; the rest of the chat is not.",
    `Source: ${where ? `${where} (${ids})` : ids}.`,
    "",
    "## Before you act",
    "",
    `1. Read the chat with ${tool("read_task_conversation")}. It returns the messages around the current one, including what it replies to.`,
    `2. If the task depends on something earlier, page back with ${tool("read_conversation_window")} using the returned boundary and read_epoch.`,
    `3. Use ${tool("search_conversations")} only when the task needs other chats (for example the same customer's earlier orders). Hits may be about someone else; check before you rely on them.`,
    selfServe.run_id
      ? `\nPass run_id "${selfServe.run_id}" on every ${WORK_CONTEXT_MCP_SERVER} call.`
      : "",
    "Do not restate the chat. Do not guess facts the chat would tell you; read it.",
    historyLine,
  ]
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n")
    .trim();
}

export async function stageConversationWorkspace(
  ctx: ExecutorContext,
  conversation: WorkConversationEvidence | undefined,
  workItemId?: string,
  options?: { self_serve?: WorkSelfServe },
): Promise<{ cwd: string } | undefined> {
  if (!ctx.writeWorkFiles || !conversation) {
    return undefined;
  }
  const selfServe = options?.self_serve && conversation.task
    ? options.self_serve
    : undefined;
  const background = conversation.background?.trim();
  const history = conversation.history?.trim();
  if (!selfServe && !background && !history) {
    return undefined;
  }
  return ctx.writeWorkFiles(
    composeWorkspaceInstructionFiles({
      background: selfServe ? undefined : background,
      omitted: conversation.omitted,
      history,
      task: conversation.task,
      self_serve: selfServe,
    }),
    workItemId ? { work_item_id: workItemId } : undefined,
  );
}

/**
 * Stages the workspace for a local agent spawned through spawnSysout. When the
 * agent can call the context tools itself, only the task is staged and the
 * tools ride along on the spawn; otherwise the chat is pushed as files.
 */
export async function prepareLocalAgentStart(
  input: ExecutorStartInput,
  ctx: ExecutorContext,
): Promise<{
  spawn: { cwd?: string; mcp_servers?: Record<string, WorkMcpServer> };
  evidence_text: string;
  self_serve: boolean;
}> {
  const conversation = input.conversation;
  const access = conversation?.access;
  const selfServe = Boolean(
    access &&
      conversation?.task &&
      ctx.writeWorkFiles &&
      (await ctx.sysoutSupportsMcp?.().catch(() => false)),
  );
  const staged = await stageConversationWorkspace(
    ctx,
    conversation,
    input.work_item.id,
    selfServe ? { self_serve: {} } : undefined,
  );
  const evidence_text = staged?.cwd
    ? formatWorkEvidence({
        thread_id: input.work_item.thread_id,
        record_class: input.work_item.record_class,
        thread_facet: input.work_item.thread_facet,
        source: input.work_item.thread_id.split(":")[0] ?? "",
        text: composeWorkspaceTaskEvidence({
          current_line: conversation?.current_line,
        }),
      })
    : input.evidence_text;
  return {
    spawn: {
      ...(staged?.cwd ? { cwd: staged.cwd } : {}),
      ...(selfServe && staged?.cwd && access
        ? { mcp_servers: workContextMcpServers(access) }
        : {}),
    },
    evidence_text,
    self_serve: selfServe && Boolean(staged?.cwd),
  };
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
