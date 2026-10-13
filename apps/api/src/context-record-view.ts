import type {
  ContextArtifact,
  ContextArtifactIndex,
  ContextArtifactMessage,
} from "@regenic/domain";
import { contextArtifactPreview, readableContextMessages } from "@regenic/domain";

const TITLE_LIMIT = 80;
export const CONTEXT_RECORD_PAGE_LIMIT = 40;
export const CONTEXT_RECORD_PAGE_MAX = 200;

export interface ContextRecordSummary {
  id: string;
  kind: string;
  status: string;
  recorded_at: string;
  title: string;
  message_count: number;
  thread_id?: string;
}

export interface ContextRecordPage extends ContextRecordSummary {
  messages: ContextArtifactMessage[];
  message_offset: number;
  message_total: number;
  message_limit: number;
}

export function contextRecordSummary(index: ContextArtifactIndex): ContextRecordSummary {
  const threadId = collapse(index.preview.thread_id);
  return {
    id: index.id,
    kind: index.kind,
    status: index.status,
    recorded_at: index.recorded_at,
    title: contextRecordTitle(index),
    message_count: index.preview.readable_count,
    ...(threadId ? { thread_id: threadId } : {}),
  };
}

export function contextRecordPage(
  artifact: ContextArtifact,
  options?: { offset?: number; limit?: number },
): ContextRecordPage {
  const messages = readableContextMessages(artifact);
  const limit = pageLimit(options?.limit);
  const offset = pageOffset(options?.offset, messages.length, limit);
  return {
    ...contextRecordSummary({
      id: artifact.id,
      kind: artifact.kind,
      status: artifact.status,
      recorded_at: artifact.recorded_at,
      preview: contextArtifactPreview(artifact),
    }),
    messages: messages.slice(offset, offset + limit),
    message_offset: offset,
    message_total: messages.length,
    message_limit: limit,
  };
}

function contextRecordTitle(index: ContextArtifactIndex): string {
  const line = collapse(index.preview.last_text);
  if (line) {
    return clip(line);
  }
  const date = collapse(index.preview.utc_date);
  if (date) {
    return clip(date);
  }
  const threadId = collapse(index.preview.thread_id);
  if (threadId) {
    return clip(threadId);
  }
  return clip(index.kind.trim() || "context");
}

function pageLimit(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return CONTEXT_RECORD_PAGE_LIMIT;
  }
  return Math.min(value, CONTEXT_RECORD_PAGE_MAX);
}

function pageOffset(value: number | undefined, total: number, limit: number): number {
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    return Math.max(0, total - limit);
  }
  return Math.min(value, total);
}

function collapse(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function clip(value: string): string {
  return value.length > TITLE_LIMIT ? `${value.slice(0, TITLE_LIMIT)}…` : value;
}
