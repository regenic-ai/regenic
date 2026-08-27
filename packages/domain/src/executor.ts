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
}

/**
 * Invoke schema owned by one TaskExecutor. The kernel stores values in
 * Recipe.executor_config and never reads the keys. The desktop only renders
 * this catalog. DSH, Cursor, and a connector-mounted agent each declare
 * their own fields.
 */
export interface ExecutorCatalogField {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  default?: string;
  hint?: string;
  kind?: "text" | "textarea" | "select";
  options?: Array<{ value: string; label: string }>;
}

export interface ExecutorCatalogEntry {
  executor_type: string;
  label: string;
  description?: string;
  /** Section title above invoke fields. Desktop falls back to its own copy. */
  params_label?: string;
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
  spawnSysout(): Promise<ConversationThread>;
  writeStdin(thread: ConversationThread, text: string): Promise<void>;
  listPrompts(thread: ConversationThread): Promise<ThreadPrompt[]>;
  readTranscript(sysoutId: string): Promise<Transcript | null>;
}

export interface ExecutorStartInput {
  work_item: WorkItem;
  recipe: Recipe;
  evidence_text: string;
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

function evidenceHasText(lines: WorkEvidenceLine[], text: string): boolean {
  return lines.some((line) => line.text.trim() === text);
}

export function composeWorkEvidenceText(input: {
  include_context: boolean;
  trigger_text?: string;
  head_text?: string;
  thread_lines?: WorkEvidenceLine[];
  thread_overflow?: boolean;
}): string | undefined {
  const trigger = input.trigger_text?.trim() || undefined;
  const head = input.head_text?.trim() || undefined;
  if (input.include_context) {
    const lines = [...(input.thread_lines ?? [])];
    const tail = trigger || head;
    if (tail && !evidenceHasText(lines, tail)) {
      lines.push({ speaker: "user", text: tail });
    }
    const packed = packThreadEvidence({
      lines,
      overflow: input.thread_overflow,
    });
    return packed.text || trigger || head;
  }
  return trigger || head;
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
