import type { CopyRef, PluginLocaleTable } from "./copy";
import type { JsonValue } from "./ingestion";
import type { ConversationThread } from "./channel-driver";
import type {
  AttachMode,
  InferiorRef,
  Transcript,
  WaitStatus,
} from "./job-control";
import type { PromptAnswer, ThreadPrompt } from "./thread-surface";
import type { Recipe, ResultEnvelope, WorkItem, WorkRun, WorkRunStatus } from "./work";

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

export interface ExecutorStartInput {
  work_item: WorkItem;
  recipe: Recipe;
  evidence_text: string;
  conversation?: WorkConversationEvidence;
}

export interface ExecutorResumeInput {
  run: WorkRun;
  work_item: WorkItem;
  recipe: Recipe;
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

export interface ExecutorRegistry {
  register(executor: TaskExecutor): () => void;
  get(executorType: string): TaskExecutor | undefined;
  list(): TaskExecutor[];
  catalog(): ExecutorCatalogEntry[];
  clear(): void;
}

export class MemoryExecutorRegistry implements ExecutorRegistry {
  private readonly byType = new Map<string, TaskExecutor>();

  register(executor: TaskExecutor): () => void {
    if (this.byType.has(executor.executor_type)) {
      throw new Error(`Executor already registered: ${executor.executor_type}`);
    }
    this.byType.set(executor.executor_type, executor);
    return () => {
      this.byType.delete(executor.executor_type);
    };
  }

  get(executorType: string): TaskExecutor | undefined {
    return this.byType.get(executorType);
  }

  list(): TaskExecutor[] {
    return [...this.byType.values()];
  }

  catalog(): ExecutorCatalogEntry[] {
    return this.list().map((executor) => executor.catalog());
  }

  clear(): void {
    this.byType.clear();
  }
}

/**
 * Local L6 plugins keyed by `catalog().source`. The API registers public
 * plugins here (DSH today). `createRuntime` looks up by the pinned
 * connector's source and never names a channel.
 */
export class LocalExecutorPluginRegistry {
  private readonly plugins: TaskExecutor[] = [];

  register(plugin: TaskExecutor): this {
    const source = plugin.catalog().source?.trim();
    if (!source) {
      throw new Error("Local executor plugin must declare catalog.source");
    }
    if (this.forSource(source)) {
      throw new Error(`Local executor plugin already registered: ${source}`);
    }
    this.plugins.push(plugin);
    return this;
  }

  forSource(source: string): TaskExecutor | undefined {
    const key = source.trim();
    if (!key) {
      return undefined;
    }
    return this.plugins.find((plugin) => plugin.catalog().source === key);
  }

  default(): TaskExecutor | undefined {
    return this.plugins[0];
  }
}

export interface WorkEvidenceLine {
  speaker: string;
  text: string;
}

/** Visible lines packed into evidence. Never the whole thread. */
export const WORK_EVIDENCE_THREAD_LIMIT = 40;
/** Inbox rows to load (overscan for status / working / tombstones). */
export const WORK_EVIDENCE_FETCH_LIMIT = 80;
/** Formatted conversation budget. Oldest lines drop first. */
export const WORK_EVIDENCE_CHAR_LIMIT = 16_000;
export const WORK_EVIDENCE_OMITTED = "[Earlier messages omitted]";
/** Visible lines packed into a local workspace file. */
export const WORK_FILE_THREAD_LIMIT = 200;
/** Inbox rows to load when the executor can read a file. */
export const WORK_FILE_FETCH_LIMIT = 400;
/** File conversation budget. Oldest lines drop first. */
export const WORK_FILE_CHAR_LIMIT = 80_000;
export const WORK_CONVERSATION_FILENAME = "conversation.md";
export const WORK_AGENTS_FILENAME = "AGENTS.md";
/** Short history is inlined into AGENTS.md so DSH/Cursor/Codex load it. */
export const WORK_AGENTS_INLINE_LIMIT = 4_000;
/** DSH-style checkpoint: older turns are established context, not the task. */
export const WORK_EVIDENCE_BACKGROUND_OPEN = "<background>";
export const WORK_EVIDENCE_BACKGROUND_CLOSE = "</background>";
export const WORK_EVIDENCE_CURRENT_OPEN = "<current>";
export const WORK_EVIDENCE_CURRENT_CLOSE = "</current>";
export const WORK_EVIDENCE_SPLIT_HINT =
  "Treat <background> as established context. Act on <current>.";
export const WORK_WORKSPACE_PULL_HINT =
  "Review the conversation in this workspace and work from it.";

export function formatEvidenceLine(line: WorkEvidenceLine): string {
  const text = line.text.trim();
  const speaker = line.speaker.trim() || "user";
  return text ? `${speaker}: ${text}` : "";
}

export function formatThreadContext(lines: WorkEvidenceLine[]): string {
  return lines.map(formatEvidenceLine).filter(Boolean).join("\n\n");
}

export function selectThreadEvidenceLines(
  items: Array<{
    tombstone?: boolean;
    status?: boolean;
    working?: boolean;
    speaker?: string;
    text?: string;
  }>,
  limit = WORK_EVIDENCE_THREAD_LIMIT,
): WorkEvidenceLine[] {
  const lines: WorkEvidenceLine[] = [];
  for (const item of items) {
    if (item.tombstone || item.status || item.working) {
      continue;
    }
    const text = item.text?.trim() ?? "";
    if (!text) {
      continue;
    }
    lines.push({
      speaker: item.speaker?.trim() || "user",
      text,
    });
  }
  return lines.length > limit ? lines.slice(-limit) : lines;
}

export function budgetThreadEvidence(
  lines: WorkEvidenceLine[],
  charLimit = WORK_EVIDENCE_CHAR_LIMIT,
): { lines: WorkEvidenceLine[]; omitted: number } {
  const prepared = lines
    .map((line) => ({
      speaker: line.speaker.trim() || "user",
      text: line.text.trim(),
    }))
    .filter((line) => line.text);
  if (prepared.length === 0) {
    return { lines: [], omitted: 0 };
  }
  const kept: WorkEvidenceLine[] = [];
  let used = 0;
  for (let i = prepared.length - 1; i >= 0; i--) {
    const line = prepared[i];
    const formatted = formatEvidenceLine(line);
    const extra = kept.length > 0 ? 2 : 0;
    const cost = formatted.length + extra;
    if (kept.length === 0 && formatted.length > charLimit) {
      const prefix = `${line.speaker}: `;
      const room = Math.max(0, charLimit - prefix.length);
      kept.push({ speaker: line.speaker, text: line.text.slice(0, room) });
      return { lines: kept, omitted: i };
    }
    if (used + cost > charLimit) {
      return { lines: kept.reverse(), omitted: i + 1 };
    }
    kept.push(line);
    used += cost;
  }
  return { lines: kept.reverse(), omitted: 0 };
}

export function packThreadEvidence(input: {
  lines: WorkEvidenceLine[];
  overflow?: boolean;
  lineLimit?: number;
  charLimit?: number;
}): { text: string; omitted: boolean } {
  const lineLimit = input.lineLimit ?? WORK_EVIDENCE_THREAD_LIMIT;
  const sliced =
    input.lines.length > lineLimit ? input.lines.slice(-lineLimit) : input.lines;
  const budgeted = budgetThreadEvidence(sliced, input.charLimit);
  const omitted =
    Boolean(input.overflow) ||
    input.lines.length > lineLimit ||
    budgeted.omitted > 0;
  const body = formatThreadContext(budgeted.lines);
  if (!body) {
    return { text: "", omitted };
  }
  return {
    text: omitted ? `${WORK_EVIDENCE_OMITTED}\n\n${body}` : body,
    omitted,
  };
}

function splitCurrentFromHistory(
  lines: WorkEvidenceLine[],
  current?: string,
): { history: WorkEvidenceLine[]; currentSpeaker: string } {
  if (!current) {
    return { history: lines, currentSpeaker: "user" };
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].text.trim() === current) {
      return {
        history: [...lines.slice(0, i), ...lines.slice(i + 1)],
        currentSpeaker: lines[i].speaker.trim() || "user",
      };
    }
  }
  return { history: lines, currentSpeaker: "user" };
}

function wrapEvidenceSection(tagOpen: string, tagClose: string, body: string): string {
  return `${tagOpen}\n${body}\n${tagClose}`;
}

export function composeWorkConversation(input: {
  include_context: boolean;
  trigger_text?: string;
  head_text?: string;
  thread_lines?: WorkEvidenceLine[];
  thread_overflow?: boolean;
  file_line_limit?: number;
  file_char_limit?: number;
}): WorkConversationEvidence & { inline_text?: string } {
  const current = input.trigger_text?.trim() || input.head_text?.trim() || undefined;
  if (!input.include_context) {
    return {
      current,
      current_line: current
        ? formatEvidenceLine({ speaker: "user", text: current })
        : undefined,
      omitted: false,
      inline_text: current,
    };
  }
  const split = splitCurrentFromHistory(input.thread_lines ?? [], current);
  const packed = packThreadEvidence({
    lines: split.history,
    overflow: input.thread_overflow,
  });
  const filePacked = packThreadEvidence({
    lines: split.history,
    overflow: input.thread_overflow,
    lineLimit: input.file_line_limit ?? WORK_FILE_THREAD_LIMIT,
    charLimit: input.file_char_limit ?? WORK_FILE_CHAR_LIMIT,
  });
  const currentLine = current
    ? formatEvidenceLine({
        speaker: split.currentSpeaker,
        text: current,
      })
    : undefined;
  let inline_text: string | undefined;
  if (!current) {
    inline_text = packed.text || undefined;
  } else if (!packed.text) {
    inline_text = currentLine || current;
  } else {
    inline_text = [
      WORK_EVIDENCE_SPLIT_HINT,
      wrapEvidenceSection(
        WORK_EVIDENCE_BACKGROUND_OPEN,
        WORK_EVIDENCE_BACKGROUND_CLOSE,
        packed.text,
      ),
      wrapEvidenceSection(
        WORK_EVIDENCE_CURRENT_OPEN,
        WORK_EVIDENCE_CURRENT_CLOSE,
        currentLine ?? current,
      ),
    ].join("\n\n");
  }
  return {
    current,
    current_line: currentLine,
    background: filePacked.text || undefined,
    omitted: filePacked.omitted,
    inline_text,
  };
}

export function composeWorkEvidenceText(input: {
  include_context: boolean;
  trigger_text?: string;
  head_text?: string;
  thread_lines?: WorkEvidenceLine[];
  thread_overflow?: boolean;
}): string | undefined {
  return composeWorkConversation(input).inline_text;
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

export function isExecutorSysoutBody(text: string | undefined): boolean {
  const value = text?.trim() ?? "";
  if (!value) {
    return false;
  }
  return /(^|\n)WORK\nWork item /.test(value) || /^Work item \S+:/.test(value);
}
