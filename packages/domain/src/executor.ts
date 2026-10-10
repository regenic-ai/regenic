import {
  WORK_EVIDENCE_BACKGROUND_CLOSE,
  WORK_EVIDENCE_BACKGROUND_OPEN,
  WORK_EVIDENCE_CURRENT_CLOSE,
  WORK_EVIDENCE_CURRENT_OPEN,
  WORK_EVIDENCE_OMITTED,
  WORK_EVIDENCE_SPLIT_HINT,
  wrapEvidenceSection,
} from "@regenic/connector-contract";
import type {
  ExecutorCatalogEntry,
  TaskExecutor,
  WorkConversationEvidence,
} from "@regenic/connector-contract";

export type {
  ExecutorCapabilities,
  ExecutorCatalogEntry,
  ExecutorCatalogField,
  ExecutorContext,
  ExecutorRecipeRef,
  ExecutorResumeInput,
  ExecutorRunHandle,
  ExecutorStartInput,
  ExecutorWorkRef,
  TaskExecutor,
  WorkConversationEvidence,
} from "@regenic/connector-contract";
export {
  WORK_AGENTS_FILENAME,
  WORK_AGENTS_INLINE_LIMIT,
  WORK_CONVERSATION_FILENAME,
  WORK_EVIDENCE_BACKGROUND_CLOSE,
  WORK_EVIDENCE_BACKGROUND_OPEN,
  WORK_EVIDENCE_CURRENT_CLOSE,
  WORK_EVIDENCE_CURRENT_OPEN,
  WORK_EVIDENCE_OMITTED,
  WORK_EVIDENCE_SPLIT_HINT,
  WORK_WORKSPACE_PULL_HINT,
  composeWorkspaceInstructionFiles,
  composeWorkspacePointerEvidence,
  composeWorkspaceTaskEvidence,
  formatWorkEvidence,
  handleFromWait,
  stageConversationWorkspace,
} from "@regenic/connector-contract";

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
/** Visible lines packed into a local workspace file. */
export const WORK_FILE_THREAD_LIMIT = 200;
/** Inbox rows to load when the executor can read a file. */
export const WORK_FILE_FETCH_LIMIT = 400;
/** File conversation budget. Oldest lines drop first. */
export const WORK_FILE_CHAR_LIMIT = 80_000;

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

export function isExecutorSysoutBody(text: string | undefined): boolean {
  const value = text?.trim() ?? "";
  if (!value) {
    return false;
  }
  return /(^|\n)WORK\nWork item /.test(value) || /^Work item \S+:/.test(value);
}
