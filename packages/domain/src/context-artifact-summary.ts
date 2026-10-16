import type { ContextArtifact } from "./context-artifact";

/** Stored beside an artifact so a list can skip the full transcript. */
export interface ContextArtifactPreview {
  thread_id?: string;
  utc_date?: string;
  last_text?: string;
  readable_count: number;
}

export interface ContextArtifactIndex {
  id: string;
  kind: string;
  status: string;
  recorded_at: string;
  preview: ContextArtifactPreview;
}

export interface ContextArtifactMessage {
  text: string;
  occurred_at?: string;
}

export function contextArtifactPreview(artifact: ContextArtifact): ContextArtifactPreview {
  const attrs = recordValue(artifact.attrs);
  const messages = readableContextMessages(artifact);
  const newest = messages[messages.length - 1];
  const preview: ContextArtifactPreview = {
    readable_count: messages.length,
  };
  const threadId = trimmed(attrs.thread_id);
  if (threadId) {
    preview.thread_id = threadId;
  }
  const utcDate = trimmed(attrs.utc_date);
  if (utcDate) {
    preview.utc_date = utcDate;
  }
  if (newest) {
    preview.last_text = newest.text;
  }
  return preview;
}

export function contextArtifactPreviewFromStored(input: unknown): ContextArtifactPreview {
  const row = recordValue(parseJson(input));
  const preview: ContextArtifactPreview = {
    readable_count: countValue(row.readable_count) ?? 0,
  };
  const threadId = trimmed(row.thread_id);
  if (threadId) {
    preview.thread_id = threadId;
  }
  const utcDate = trimmed(row.utc_date);
  if (utcDate) {
    preview.utc_date = utcDate;
  }
  const lastText = trimmed(row.last_text);
  if (lastText) {
    preview.last_text = lastText;
  }
  return preview;
}

/** Lines the settings record can show, oldest first. */
export function readableContextMessages(artifact: ContextArtifact): ContextArtifactMessage[] {
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
    const occurredAt = trimmed(row.occurred_at);
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

function parseJson(input: unknown): unknown {
  if (typeof input !== "string") {
    return input;
  }
  if (!input.trim()) {
    return {};
  }
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return {};
  }
}

function recordValue(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  return text || undefined;
}

function countValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
