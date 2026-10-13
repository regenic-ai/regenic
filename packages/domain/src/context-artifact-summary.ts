import type { ContextArtifact } from "./context-artifact";

export const CONTEXT_RECORD_TITLE_LIMIT = 80;
export const CONTEXT_RECORD_PAGE_LIMIT = 40;
export const CONTEXT_RECORD_PAGE_MAX = 200;

export interface ContextArtifactPreview {
  thread_id?: string;
  utc_date?: string;
  last_text?: string;
  message_count?: number;
  item_count?: number;
  stored_message_length?: number;
}

export interface ContextArtifactSummary {
  id: string;
  kind: string;
  status: string;
  recorded_at: string;
  title: string;
  message_count: number;
  thread_id?: string;
}

export interface ContextArtifactMessage {
  text: string;
  occurred_at?: string;
}

export interface ContextArtifactRecord extends ContextArtifactSummary {
  messages: ContextArtifactMessage[];
  message_offset: number;
  message_total: number;
}

export function contextArtifactPreview(artifact: ContextArtifact): ContextArtifactPreview {
  const attrs = recordValue(artifact.attrs);
  const preview: ContextArtifactPreview = {};
  const threadId = textValue(attrs.thread_id);
  if (threadId) {
    preview.thread_id = threadId;
  }
  const utcDate = textValue(attrs.utc_date);
  if (utcDate) {
    preview.utc_date = utcDate;
  }
  const lastText = lastStoredText(attrs.messages);
  if (lastText) {
    preview.last_text = lastText;
  }
  const messageCount = countValue(attrs.message_count);
  if (messageCount !== undefined) {
    preview.message_count = messageCount;
  }
  const itemCount = countValue(attrs.item_count);
  if (itemCount !== undefined) {
    preview.item_count = itemCount;
  }
  if (Array.isArray(attrs.messages)) {
    preview.stored_message_length = attrs.messages.length;
  }
  return preview;
}

export function summarizeContextArtifact(artifact: ContextArtifact): ContextArtifactSummary {
  return contextArtifactSummaryFromPreview(
    {
      id: artifact.id,
      kind: artifact.kind,
      status: artifact.status,
      recorded_at: artifact.recorded_at,
    },
    contextArtifactPreview(artifact),
  );
}

export function contextArtifactSummaryFromPreview(
  identity: {
    id: string;
    kind: string;
    status: string;
    recorded_at: string;
  },
  preview: unknown,
): ContextArtifactSummary {
  const parsed = parsePreview(preview);
  const threadId = collapse(parsed.thread_id);
  const messageCount = parsed.message_count ?? parsed.item_count ?? parsed.stored_message_length ?? 0;
  return {
    id: identity.id,
    kind: identity.kind,
    status: identity.status,
    recorded_at: identity.recorded_at,
    title: contextArtifactTitle({
      lastText: parsed.last_text,
      utcDate: parsed.utc_date,
      threadId: parsed.thread_id,
      kind: identity.kind,
    }),
    message_count: messageCount,
    ...(threadId ? { thread_id: threadId } : {}),
  };
}

export function contextArtifactTitle(input: {
  lastText?: string;
  utcDate?: string;
  threadId?: string;
  kind: string;
}): string {
  const line = collapse(input.lastText);
  if (line) {
    return clip(line);
  }
  const date = collapse(input.utcDate);
  if (date) {
    return clip(date);
  }
  const threadId = collapse(input.threadId);
  if (threadId) {
    return clip(threadId);
  }
  return clip(input.kind.trim() || "context");
}

export function readContextArtifactRecord(
  artifact: ContextArtifact,
  options?: { offset?: number; limit?: number },
): ContextArtifactRecord {
  const messages = readableMessages(artifact);
  const limit = pageLimit(options?.limit);
  const offset = pageOffset(options?.offset, messages.length, limit);
  return {
    ...summarizeContextArtifact(artifact),
    messages: messages.slice(offset, offset + limit),
    message_offset: offset,
    message_total: messages.length,
  };
}

function readableMessages(artifact: ContextArtifact): ContextArtifactMessage[] {
  const attrs = recordValue(artifact.attrs);
  const fromMessages = textsFromMessages(attrs.messages);
  const messages = fromMessages.length > 0 ? fromMessages : textsFromDigest(attrs.directions);
  return messages.sort((left, right) =>
    (left.occurred_at ?? "").localeCompare(right.occurred_at ?? ""),
  );
}

function textsFromMessages(input: unknown): ContextArtifactMessage[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const messages: ContextArtifactMessage[] = [];
  for (const item of input) {
    const row = recordValue(item);
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text) {
      continue;
    }
    const occurredAt = textValue(row.occurred_at);
    messages.push({
      text,
      ...(occurredAt ? { occurred_at: occurredAt } : {}),
    });
  }
  return messages;
}

function textsFromDigest(input: unknown): ContextArtifactMessage[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const messages: ContextArtifactMessage[] = [];
  for (const direction of input) {
    const items = recordValue(direction).items;
    if (!Array.isArray(items)) {
      continue;
    }
    messages.push(...textsFromMessages(items));
  }
  return messages;
}

function lastStoredText(input: unknown): string | undefined {
  if (!Array.isArray(input) || input.length === 0) {
    return undefined;
  }
  const text = recordValue(input[input.length - 1]).text;
  return typeof text === "string" && text.length > 0 ? text : undefined;
}

function parsePreview(input: unknown): ContextArtifactPreview {
  let value = input;
  if (typeof value === "string") {
    if (!value.trim()) {
      return {};
    }
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return {};
    }
  }
  const row = recordValue(value);
  const preview: ContextArtifactPreview = {};
  const threadId = textValue(row.thread_id);
  if (threadId) {
    preview.thread_id = threadId;
  }
  const utcDate = textValue(row.utc_date);
  if (utcDate) {
    preview.utc_date = utcDate;
  }
  const lastText = textValue(row.last_text);
  if (lastText) {
    preview.last_text = lastText;
  }
  const messageCount = countValue(row.message_count);
  if (messageCount !== undefined) {
    preview.message_count = messageCount;
  }
  const itemCount = countValue(row.item_count);
  if (itemCount !== undefined) {
    preview.item_count = itemCount;
  }
  const storedLength = countValue(row.stored_message_length);
  if (storedLength !== undefined) {
    preview.stored_message_length = storedLength;
  }
  return preview;
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

function recordValue(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function countValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function collapse(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function clip(value: string): string {
  return value.length > CONTEXT_RECORD_TITLE_LIMIT
    ? `${value.slice(0, CONTEXT_RECORD_TITLE_LIMIT)}…`
    : value;
}
