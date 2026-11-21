import { conversationId, surfaceFromParts } from "@regenic/connector-contract";

/** A capped conversation-name lookup. It does not page message bodies. */
export interface ConversationDirectoryQuery {
  q?: string;
  /** Exact conversation. Ignores `q` and the shown/hidden filter. */
  thread_id?: string;
  /** Default `all`. */
  list?: "shown" | "hidden" | "all";
  limit?: number;
}

export interface ConversationDirectoryEntry {
  thread_id: string;
  source: string;
  pref_title: string | null;
  /** Name remembered from a message or a one-time label lookup. */
  display_name: string | null;
  catalog_label: string | null;
  hidden: boolean;
  pinned: boolean;
  has_current_work: boolean;
  face_occurred_at: string;
  face_event_id: string;
  face_content_hash: string | null;
}

/** A chat title may replace a stored name. A prompt excerpt only fills a blank. */
export type ConversationNameKind = "conversation" | "prompt";

export interface ConversationNameUpdate {
  thread_id: string;
  display_name: string;
  kind: ConversationNameKind;
}

export function collapsedConversationName(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

/** Ids the directory used to show in place of a missing title. */
export function opaqueConversationName(value: string, threadId?: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  if (threadId && (trimmed === threadId.trim() || threadId.endsWith(`:${trimmed}`))) {
    return true;
  }
  if (/^oc_[0-9a-f]+$/i.test(trimmed)) {
    return true;
  }
  return /^session-[0-9a-f-]{8,}$/i.test(trimmed);
}

export function usableConversationName(
  value: string | null | undefined,
  threadId?: string,
): string {
  const name = collapsedConversationName(value);
  if (!name || opaqueConversationName(name, threadId)) {
    return "";
  }
  return name;
}

export function conversationDirectoryLabel(row: {
  thread_id: string;
  pref_title?: string | null;
  display_name?: string | null;
  catalog_label?: string | null;
}): { label: string; conversation_name?: string } {
  const name =
    usableConversationName(row.pref_title, row.thread_id) ||
    usableConversationName(row.catalog_label, row.thread_id) ||
    usableConversationName(row.display_name, row.thread_id);
  return name
    ? { label: name, conversation_name: name }
    : { label: row.thread_id };
}

export function shouldRememberConversationName(
  current: string | null | undefined,
  update: Pick<ConversationNameUpdate, "display_name" | "kind">,
  threadId: string,
): boolean {
  const next = usableConversationName(update.display_name, threadId);
  if (!next) {
    return false;
  }
  const stored = usableConversationName(current, threadId);
  if (!stored) {
    return true;
  }
  if (update.kind === "prompt") {
    return false;
  }
  return stored !== next;
}

/** Chat titles already carried on the ingested records. Message text is not a title. */
export function conversationNamesFromRecords(
  records: readonly {
    source: string;
    external_id: string;
    occurred_at: string;
    content?: ReadonlyArray<{ role?: string; media_type?: string; text?: string }>;
  }[],
): ConversationNameUpdate[] {
  const byThread = new Map<string, ConversationNameUpdate & { at: string }>();
  for (const record of records) {
    const threadId = conversationId(record.source, record.external_id);
    const surface = surfaceFromParts([...(record.content ?? [])]);
    const conversation = usableConversationName(surface?.conversation_label, threadId);
    if (!conversation) {
      continue;
    }
    const current = byThread.get(threadId);
    if (!current || record.occurred_at >= current.at) {
      byThread.set(threadId, {
        thread_id: threadId,
        display_name: conversation,
        kind: "conversation",
        at: record.occurred_at,
      });
    }
  }
  return [...byThread.values()].map(({ at: _at, ...name }) => name);
}

export const CONVERSATION_DIRECTORY_DEFAULT_LIMIT = 40;
export const CONVERSATION_DIRECTORY_MAX_LIMIT = 50;

export function conversationDirectoryLimit(value: unknown): number {
  const limit = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(limit) || limit < 1) {
    return CONVERSATION_DIRECTORY_DEFAULT_LIMIT;
  }
  return Math.min(limit, CONVERSATION_DIRECTORY_MAX_LIMIT);
}

/** LIKE pattern with `\`, `%`, and `_` escaped for `ESCAPE '\'`. */
export function conversationDirectoryLike(text: string): { contains: string; prefix: string } {
  const escaped = text.trim().toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`);
  return { contains: `%${escaped}%`, prefix: `${escaped}%` };
}

export function rankConversationDirectory(
  rows: readonly ConversationDirectoryEntry[],
  query?: ConversationDirectoryQuery,
): ConversationDirectoryEntry[] {
  const exact = query?.thread_id?.trim();
  const needle = exact ? "" : query?.q?.trim().toLowerCase() ?? "";
  const matched = rows.filter((row) => {
    if (exact) {
      return row.thread_id === exact;
    }
    if (!needle) {
      return true;
    }
    return directoryFields(row).some((field) => field.includes(needle));
  });
  matched.sort((left, right) => {
    if (needle) {
      const byPrefix = Number(directoryPrefix(right, needle)) - Number(directoryPrefix(left, needle));
      if (byPrefix !== 0) {
        return byPrefix;
      }
    }
    if (left.face_occurred_at !== right.face_occurred_at) {
      return left.face_occurred_at < right.face_occurred_at ? 1 : -1;
    }
    return left.thread_id < right.thread_id ? 1 : -1;
  });
  return matched.slice(0, conversationDirectoryLimit(query?.limit));
}

function directoryFields(row: ConversationDirectoryEntry): string[] {
  return [row.pref_title, row.display_name, row.catalog_label, row.thread_id]
    .flatMap((field) => {
      const text = field?.trim().toLowerCase();
      return text ? [text] : [];
    });
}

function directoryPrefix(row: ConversationDirectoryEntry, needle: string): boolean {
  return directoryFields(row).some((field) => field.startsWith(needle));
}

/**
 * `userConversation` is the store's "not an agent session" predicate for `th`.
 * Placeholders are `?`. Callers that speak `$1` renumber them.
 */
export function conversationDirectoryStatement(
  orgId: string,
  query: ConversationDirectoryQuery | undefined,
  userConversation: string,
  hidden: { isHidden: string; isShown: string; column: string; pinned: string } = {
    isHidden: "p.hidden = 1",
    isShown: "(p.hidden IS NULL OR p.hidden = 0)",
    column: "COALESCE(p.hidden, 0)",
    pinned: "COALESCE(p.pinned, 0)",
  },
): { sql: string; params: unknown[] } {
  const params: unknown[] = [orgId];
  const where = ["th.org_id = ?", userConversation];
  const exact = query?.thread_id?.trim();
  const needle = exact ? "" : query?.q?.trim() ?? "";
  const like = needle ? conversationDirectoryLike(needle) : null;
  if (exact) {
    where.push("th.thread_id = ?");
    params.push(exact);
  } else if (query?.list === "hidden") {
    where.push(hidden.isHidden);
  } else if (query?.list === "shown") {
    where.push(hidden.isShown);
  }
  if (like) {
    where.push(`(
      lower(COALESCE(p.title, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(th.display_name, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(m.label, '')) LIKE ? ESCAPE '\\'
      OR lower(th.thread_id) LIKE ? ESCAPE '\\'
    )`);
    params.push(like.contains, like.contains, like.contains, like.contains);
  }
  const order = like
    ? `ORDER BY MAX(CASE
        WHEN lower(COALESCE(p.title, '')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(th.display_name, '')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(m.label, '')) LIKE ? ESCAPE '\\'
          OR lower(th.thread_id) LIKE ? ESCAPE '\\'
        THEN 0 ELSE 1 END),
      th.face_occurred_at DESC,
      th.thread_id DESC`
    : "ORDER BY th.face_occurred_at DESC, th.thread_id DESC";
  if (like) {
    params.push(like.prefix, like.prefix, like.prefix, like.prefix);
  }
  params.push(conversationDirectoryLimit(query?.limit));
  return {
    sql: `
      SELECT
        th.thread_id AS thread_id,
        e.source AS source,
        th.face_occurred_at AS face_occurred_at,
        th.has_current_work AS has_current_work,
        p.title AS pref_title,
        th.display_name AS display_name,
        th.face_event_id AS face_event_id,
        e.content_hash AS face_content_hash,
        ${hidden.column} AS hidden,
        ${hidden.pinned} AS pinned,
        MAX(m.label) AS catalog_label
      FROM thread_heads th
      JOIN events e ON e.id = th.face_event_id
      LEFT JOIN conversation_prefs p
        ON p.org_id = th.org_id AND p.thread_id = th.thread_id
      LEFT JOIN connector_stream_members m
        ON m.thread_id = th.thread_id
        AND m.label IS NOT NULL
        AND m.label <> ''
        AND EXISTS (
          SELECT 1 FROM connector_installations i
          WHERE i.id = m.installation_id
            AND i.org_id = th.org_id
        )
      WHERE ${where.join(" AND ")}
      GROUP BY
        th.thread_id, e.source, th.face_occurred_at, th.has_current_work, p.title,
        th.display_name, th.face_event_id, e.content_hash,
        ${hidden.column}, ${hidden.pinned}
      ${order}
      LIMIT ?
    `,
    params,
  };
}

export function numberConversationDirectorySql(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}
