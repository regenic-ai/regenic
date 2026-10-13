export interface ContextMessageView {
  text: string;
  occurred_at?: string;
}

export interface ContextRecordSummary {
  id: string;
  kind: string;
  status: string;
  recorded_at: string;
  title: string;
  message_count: number;
  thread_id?: string;
}

export interface ContextRecordPage {
  messages: ContextMessageView[];
  message_offset: number;
  message_total: number;
  message_limit: number;
}

export function contextSummariesFromResponse(input: unknown): ContextRecordSummary[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const records: ContextRecordSummary[] = [];
  for (const item of input) {
    const record = contextSummaryFromRow(item);
    if (record) {
      records.push(record);
    }
  }
  records.sort((left, right) => compareNewest(left, right));
  return records;
}

export function contextRecordPageFromResponse(input: unknown): ContextRecordPage | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const row = input as Record<string, unknown>;
  const offset = countValue(row.message_offset);
  const total = countValue(row.message_total);
  const limit = countValue(row.message_limit);
  if (offset === undefined || total === undefined || limit === undefined || limit < 1) {
    return null;
  }
  return {
    messages: contextMessages(row.messages),
    message_offset: offset,
    message_total: total,
    message_limit: limit,
  };
}

function contextSummaryFromRow(input: unknown): ContextRecordSummary | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const row = input as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) {
    return null;
  }
  const threadId = typeof row.thread_id === "string" ? row.thread_id.trim() : "";
  const kind = typeof row.kind === "string" && row.kind.trim() ? row.kind : "context";
  const title = typeof row.title === "string" && row.title.trim() ? row.title.trim() : kind;
  return {
    id,
    kind,
    status: typeof row.status === "string" ? row.status : "",
    recorded_at: typeof row.recorded_at === "string" ? row.recorded_at : "",
    title,
    message_count: countValue(row.message_count) ?? 0,
    ...(threadId ? { thread_id: threadId } : {}),
  };
}

function contextMessages(input: unknown): ContextMessageView[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const messages: ContextMessageView[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const row = item as Record<string, unknown>;
    const text = typeof row.text === "string" ? row.text.trim() : "";
    if (!text) {
      continue;
    }
    const occurredAt = typeof row.occurred_at === "string" ? row.occurred_at : "";
    messages.push({
      text,
      ...(occurredAt ? { occurred_at: occurredAt } : {}),
    });
  }
  return messages;
}

function countValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function compareNewest(left: ContextRecordSummary, right: ContextRecordSummary): number {
  if (left.recorded_at !== right.recorded_at) {
    return left.recorded_at < right.recorded_at ? 1 : -1;
  }
  if (left.id !== right.id) {
    return left.id < right.id ? 1 : -1;
  }
  return 0;
}
