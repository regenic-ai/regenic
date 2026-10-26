import {
  WORK_EVIDENCE_AFTER_CURRENT,
  WORK_EVIDENCE_BACKGROUND_CLOSE,
  WORK_EVIDENCE_BACKGROUND_OPEN,
  WORK_EVIDENCE_CURRENT_CLOSE,
  WORK_EVIDENCE_CURRENT_OPEN,
  WORK_EVIDENCE_GAP,
  WORK_EVIDENCE_OMITTED,
  WORK_EVIDENCE_SPLIT_HINT,
  wrapEvidenceSection,
} from "@regenic/connector-contract";
import { selectContextIndexes } from "./context-selection";
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
  WORK_EVIDENCE_AFTER_CURRENT,
  WORK_EVIDENCE_GAP,
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
  event_id?: string;
  occurred_at?: string;
  /** Speaker of the message this line replies to. */
  reply_to?: string;
  /** Lower ranks survive budgets first. Unranked lines keep the newest first. */
  rank?: number;
  /** Source messages between this line and the previous one were not loaded. */
  gap_before?: boolean;
  /** Sent after the message the work item acts on. */
  after_current?: boolean;
}

export interface ThreadEvidenceCandidate {
  event_id: string;
  source: string;
  external_id: string;
  parent_external_id?: string;
  occurred_at?: string;
  tombstone?: boolean;
  status?: boolean;
  working?: boolean;
  speaker?: string;
  text?: string;
  gap_before?: boolean;
}

/** Reply chains a work item keeps even when they fall outside the recent window. */
export const WORK_EVIDENCE_REPLY_DEPTH = 8;
/** Messages loaded just before an anchor that is older than the recent tail. */
export const WORK_EVIDENCE_ANCHOR_WINDOW = 20;

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
  const time = line.occurred_at ? evidenceTime(line.occurred_at) : undefined;
  const meta = [time, line.reply_to?.trim() ? `reply to ${line.reply_to.trim()}` : undefined]
    .filter(Boolean)
    .join(", ");
  return text ? `${speaker}${meta ? ` [${meta}]` : ""}: ${text}` : "";
}

function evidenceTime(value: string): string | undefined {
  const time = Date.parse(value);
  return Number.isNaN(time)
    ? undefined
    : `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
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

/**
 * Rank visible thread messages around the message a work item acts on:
 * the anchor, its reply chain, then neighbors by distance. Without an anchor
 * the newest visible message is the anchor.
 */
export function rankThreadEvidenceLines(
  items: ThreadEvidenceCandidate[],
  anchorEventId?: string,
): WorkEvidenceLine[] {
  const visible: ThreadEvidenceCandidate[] = [];
  let pendingGap = false;
  for (const item of items) {
    pendingGap ||= Boolean(item.gap_before);
    const text = item.text?.trim() ?? "";
    if (item.tombstone || item.status || item.working || !text) {
      continue;
    }
    visible.push({ ...item, text, gap_before: pendingGap && visible.length > 0 });
    pendingGap = false;
  }
  if (visible.length === 0) {
    return [];
  }
  const anchor = visible.some((item) => item.event_id === anchorEventId)
    ? anchorEventId!
    : visible[visible.length - 1].event_id;
  const selection = selectContextIndexes(
    visible.map((item) => ({
      id: item.event_id,
      source: item.source,
      external_id: item.external_id,
      parent_external_id: item.parent_external_id,
    })),
    [anchor],
    {
      before: visible.length,
      after: visible.length,
      replyDepth: WORK_EVIDENCE_REPLY_DEPTH,
      maxMessages: visible.length,
    },
  );
  const rank = new Map(selection.ranked.map((index, position) => [index, position]));
  const speakerOf = (item: ThreadEvidenceCandidate) => item.speaker?.trim() || "user";
  return visible.map((item, index) => {
    const parent = item.parent_external_id
      ? visible.find((candidate) =>
        candidate.source === item.source && candidate.external_id === item.parent_external_id)
      : undefined;
    return {
      speaker: speakerOf(item),
      text: item.text!,
      event_id: item.event_id,
      ...(item.occurred_at ? { occurred_at: item.occurred_at } : {}),
      ...(parent ? { reply_to: speakerOf(parent) } : {}),
      rank: rank.get(index) ?? visible.length + index,
      ...(item.gap_before ? { gap_before: true } : {}),
    };
  });
}

function keepRankedEvidence(
  lines: WorkEvidenceLine[],
  lineLimit: number,
  charLimit: number,
): { kept: Array<{ line: WorkEvidenceLine; index: number }>; total: number } {
  const prepared = lines
    .map((line, index) => ({
      line: { ...line, speaker: line.speaker.trim() || "user", text: line.text.trim() },
      index,
    }))
    .filter((entry) => entry.line.text);
  const ranked = [...prepared].sort((left, right) =>
    (left.line.rank ?? lines.length - 1 - left.index)
      - (right.line.rank ?? lines.length - 1 - right.index)
    || right.index - left.index);
  const kept: Array<{ line: WorkEvidenceLine; index: number }> = [];
  let used = 0;
  for (const entry of ranked) {
    if (kept.length >= lineLimit) {
      break;
    }
    const formatted = formatEvidenceLine(entry.line);
    if (kept.length === 0 && formatted.length > charLimit) {
      const prefix = formatted.slice(0, formatted.length - entry.line.text.length);
      const room = Math.max(0, charLimit - prefix.length);
      kept.push({ line: { ...entry.line, text: entry.line.text.slice(0, room) }, index: entry.index });
      break;
    }
    const cost = formatted.length + (kept.length > 0 ? 2 : 0);
    if (used + cost > charLimit) {
      break;
    }
    kept.push(entry);
    used += cost;
  }
  return { kept: kept.sort((left, right) => left.index - right.index), total: prepared.length };
}

export function budgetThreadEvidence(
  lines: WorkEvidenceLine[],
  charLimit = WORK_EVIDENCE_CHAR_LIMIT,
): { lines: WorkEvidenceLine[]; omitted: number } {
  const { kept, total } = keepRankedEvidence(lines, Number.POSITIVE_INFINITY, charLimit);
  return {
    lines: kept.map(({ line }) => ({ speaker: line.speaker, text: line.text })),
    omitted: total - kept.length,
  };
}

export function packThreadEvidence(input: {
  lines: WorkEvidenceLine[];
  overflow?: boolean;
  lineLimit?: number;
  charLimit?: number;
}): { text: string; omitted: boolean } {
  const { kept, total } = keepRankedEvidence(
    input.lines,
    input.lineLimit ?? WORK_EVIDENCE_THREAD_LIMIT,
    input.charLimit ?? WORK_EVIDENCE_CHAR_LIMIT,
  );
  const first = kept[0];
  const earlierOmitted =
    Boolean(input.overflow) || (first !== undefined && (first.index > 0 || first.line.gap_before));
  const omitted =
    Boolean(input.overflow) ||
    kept.length < total ||
    kept.some(({ line }) => line.gap_before);
  const parts: string[] = [];
  let afterCurrent = false;
  kept.forEach(({ line, index }, position) => {
    const previous = kept[position - 1];
    if (previous && (index !== previous.index + 1 || line.gap_before)) {
      parts.push(WORK_EVIDENCE_GAP);
    }
    if (line.after_current && !afterCurrent) {
      parts.push(WORK_EVIDENCE_AFTER_CURRENT);
      afterCurrent = true;
    }
    parts.push(formatEvidenceLine(line));
  });
  const last = kept[kept.length - 1];
  if (last && last.index < input.lines.length - 1) {
    parts.push(WORK_EVIDENCE_GAP);
  }
  const body = parts.filter(Boolean).join("\n\n");
  if (!kept.length) {
    return { text: "", omitted };
  }
  return {
    text: earlierOmitted ? `${WORK_EVIDENCE_OMITTED}\n\n${body}` : body,
    omitted,
  };
}

function splitCurrentFromHistory(
  lines: WorkEvidenceLine[],
  current?: string,
  currentEventId?: string,
): { history: WorkEvidenceLine[]; currentLine?: WorkEvidenceLine } {
  let at = currentEventId
    ? lines.findIndex((line) => line.event_id === currentEventId)
    : -1;
  if (at < 0 && current) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].text.trim() === current) {
        at = i;
        break;
      }
    }
  }
  if (at < 0) {
    return { history: lines };
  }
  return {
    history: [
      ...lines.slice(0, at),
      ...lines.slice(at + 1).map((line) => ({ ...line, after_current: true })),
    ],
    currentLine: lines[at],
  };
}


export function composeWorkConversation(input: {
  include_context: boolean;
  trigger_text?: string;
  head_text?: string;
  /** Event the work item acts on. Matched before falling back to text. */
  current_event_id?: string;
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
  const split = splitCurrentFromHistory(
    input.thread_lines ?? [],
    current,
    input.current_event_id,
  );
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
        speaker: split.currentLine?.speaker ?? "user",
        text: current,
        occurred_at: split.currentLine?.occurred_at,
        reply_to: split.currentLine?.reply_to,
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
  current_event_id?: string;
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
