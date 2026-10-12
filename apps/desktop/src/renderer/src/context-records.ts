export interface ContextMessageView {
  text: string;
  occurred_at?: string;
}

export interface ContextRecordView {
  id: string;
  kind: string;
  status: string;
  recorded_at: string;
  thread_id?: string;
  title: string;
  message_count: number;
  messages: ContextMessageView[];
}

const TITLE_LIMIT = 80;

export function contextRecordsFromArtifacts(input: unknown): ContextRecordView[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const records: ContextRecordView[] = [];
  for (const item of input) {
    const record = contextRecordFromArtifact(item);
    if (record) {
      records.push(record);
    }
  }
  records.sort((left, right) => right.recorded_at.localeCompare(left.recorded_at) || right.id.localeCompare(left.id));
  return records;
}

function contextRecordFromArtifact(input: unknown): ContextRecordView | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const row = input as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id) {
    return null;
  }
  const attrs =
    row.attrs && typeof row.attrs === "object" && !Array.isArray(row.attrs)
      ? (row.attrs as Record<string, unknown>)
      : {};
  const messages = contextMessages(attrs.messages);
  const threadId = typeof attrs.thread_id === "string" ? attrs.thread_id.trim() : "";
  const counted = attrs.message_count;
  const messageCount =
    typeof counted === "number" && Number.isFinite(counted)
      ? counted
      : messages.length;
  return {
    id,
    kind: typeof row.kind === "string" && row.kind.trim() ? row.kind : "context",
    status: typeof row.status === "string" ? row.status : "",
    recorded_at: typeof row.recorded_at === "string" ? row.recorded_at : "",
    ...(threadId ? { thread_id: threadId } : {}),
    title: contextRecordTitle(messages, threadId),
    message_count: messageCount,
    messages,
  };
}

function contextMessages(input: unknown): ContextMessageView[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const messages: ContextMessageView[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object") {
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
  messages.sort((left, right) =>
    (left.occurred_at ?? "").localeCompare(right.occurred_at ?? ""),
  );
  return messages;
}

function contextRecordTitle(
  messages: readonly ContextMessageView[],
  threadId: string,
): string {
  const newest = [...messages].reverse().find((message) => message.text);
  const line = newest?.text.replace(/\s+/g, " ").trim() ?? "";
  if (line) {
    return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT)}…` : line;
  }
  return threadId || "context";
}
