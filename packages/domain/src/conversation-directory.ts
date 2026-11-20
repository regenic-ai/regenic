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
  catalog_label: string | null;
  hidden: boolean;
  has_current_work: boolean;
  face_occurred_at: string;
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
  return [row.pref_title, row.catalog_label, row.thread_id]
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
  hidden: { isHidden: string; isShown: string; column: string } = {
    isHidden: "p.hidden = 1",
    isShown: "(p.hidden IS NULL OR p.hidden = 0)",
    column: "COALESCE(p.hidden, 0)",
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
      OR lower(COALESCE(m.label, '')) LIKE ? ESCAPE '\\'
      OR lower(th.thread_id) LIKE ? ESCAPE '\\'
    )`);
    params.push(like.contains, like.contains, like.contains);
  }
  const order = like
    ? `ORDER BY MAX(CASE
        WHEN lower(COALESCE(p.title, '')) LIKE ? ESCAPE '\\'
          OR lower(COALESCE(m.label, '')) LIKE ? ESCAPE '\\'
          OR lower(th.thread_id) LIKE ? ESCAPE '\\'
        THEN 0 ELSE 1 END),
      th.face_occurred_at DESC,
      th.thread_id DESC`
    : "ORDER BY th.face_occurred_at DESC, th.thread_id DESC";
  if (like) {
    params.push(like.prefix, like.prefix, like.prefix);
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
        ${hidden.column} AS hidden,
        MAX(m.label) AS catalog_label
      FROM thread_heads th
      JOIN events e ON e.id = th.face_event_id
      LEFT JOIN conversation_prefs p
        ON p.org_id = th.org_id AND p.thread_id = th.thread_id
      LEFT JOIN connector_stream_members m
        ON m.thread_id = th.thread_id
        AND m.label IS NOT NULL
        AND m.label <> ''
      WHERE ${where.join(" AND ")}
      GROUP BY
        th.thread_id, e.source, th.face_occurred_at, th.has_current_work, p.title, ${hidden.column}
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
