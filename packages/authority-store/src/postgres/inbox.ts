import type {
  ArrangementDecision,
  InboxQuery,
  InboxItem,
  InboxSummary,
  ConversationPref,
  ConversationPrefPatch,
} from "@regenic/domain";
import type {
  PoolClient,
} from "pg";
import {
  formatInboxDigest,
  normalizeHiddenReason,
  normalizeInboxListView,
  headsScanQuery,
  threadExternalIdLike,
  normalizeInboxLimit,
} from "@regenic/domain";
import {
  EventRow,
  toEvent,
} from "./events";
import {
  PgSql,
  asBool,
  asJson,
  asNumber,
  jsonb,
  toIso,
  toIsoOrNull,
} from "./sql";

interface DispositionRow {
  event_id: string;
  org_id: string;
  disposition: ArrangementDecision["disposition"];
  layer: ArrangementDecision["layer"];
  reason_codes: unknown;
  score: unknown;
  decided_at: unknown;
}

interface InboxRow extends EventRow {
  event_id: string;
  disposition_org_id: string;
  disposition: ArrangementDecision["disposition"];
  layer: ArrangementDecision["layer"];
  reason_codes: unknown;
  score: unknown;
  decided_at: unknown;
}

interface PrefRow {
  org_id: string;
  thread_id: string;
  title: string | null;
  pinned: unknown;
  hidden: unknown;
  hidden_reason: string | null;
  last_read_at: unknown;
  last_read_external_id: string | null;
  updated_at: unknown;
}

const PREF_COLUMNS = `
  org_id, thread_id, title, pinned, hidden, hidden_reason,
  last_read_at, last_read_external_id, updated_at
`;

const INBOX_COLUMNS = `
  d.event_id, d.org_id AS disposition_org_id, d.disposition, d.layer,
  d.reason_codes, d.score, d.decided_at,
  e.id, e.source, e.external_id, e.operation, e.content_hash,
  e.parent_event_id, e.thread_id, e.actor_id, e.required_scope_ids,
  e.occurred_at, e.ingested_at
`;

export async function putDisposition(db: PgSql, decision: ArrangementDecision): Promise<void> {
    await putDispositionWithinTransaction(db, decision);
  }

export async function putDispositionWithinTransaction(db: PgSql, decision: ArrangementDecision, client?: PoolClient): Promise<void> {
    await db.execute(
      `
        INSERT INTO message_dispositions (
          event_id, org_id, disposition, layer, reason_codes, score, decided_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (event_id) DO UPDATE SET
          org_id = EXCLUDED.org_id,
          disposition = EXCLUDED.disposition,
          layer = EXCLUDED.layer,
          reason_codes = EXCLUDED.reason_codes,
          score = EXCLUDED.score,
          decided_at = EXCLUDED.decided_at
      `,
      [
        decision.event_id,
        decision.org_id,
        decision.disposition,
        decision.layer,
        jsonb(decision.reason_codes),
        decision.score,
        decision.decided_at,
      ],
      client,
    );
    const row = await db.queryOne<{ thread_id: string | null }>(
      `SELECT thread_id FROM events WHERE id = $1`,
      [decision.event_id],
      client,
    );
    await refreshThreadHeadWithinTransaction(db, 
      decision.org_id,
      row?.thread_id,
      client,
    );
  }

export async function getDisposition(db: PgSql, eventId: string): Promise<ArrangementDecision | null> {
    const row = await db.queryOne<DispositionRow>(
      `
        SELECT event_id, org_id, disposition, layer, reason_codes, score, decided_at
        FROM message_dispositions WHERE event_id = $1
      `,
      [eventId],
    );
    return row ? toDisposition(db, row) : null;
  }

export async function listInbox(db: PgSql, orgId: string, query?: InboxQuery): Promise<InboxItem[]> {
    if (query?.thread_ids && query.thread_ids.length === 0) {
      return [];
    }
    const { sql, params } = inboxSql(db, orgId, query);
    const rows = await db.query<InboxRow>(sql, params);
    const items = rows.map((row) => toInboxItem(db, row));
    if (inboxUsesNewestFirst(query)) {
      items.reverse();
    }
    return items;
  }

export async function summarizeInbox(db: PgSql, orgId: string): Promise<InboxSummary> {
    const latest = await db.queryOne<{ latest_at: unknown; latest_id: string }>(
      `
        SELECT e.ingested_at AS latest_at, e.id AS latest_id
        FROM events e
        JOIN message_dispositions d ON d.event_id = e.id
        WHERE e.org_id = $1
          AND d.disposition = 'current_work'
          AND ${isCurrentHeadSql("e")}
          AND ${notHiddenSql("$2", "e")}
        ORDER BY e.ingested_at DESC, e.id DESC
        LIMIT 1
      `,
      [orgId, orgId],
    );
    const counted = await db.queryOne<{ count: unknown }>(
      `
        SELECT COUNT(*)::int AS count
        FROM thread_heads th
        WHERE th.org_id = $1
          AND th.has_current_work = TRUE
          AND th.thread_id NOT IN (
            SELECT p.thread_id FROM conversation_prefs p
            WHERE p.org_id = $2 AND p.hidden = TRUE
          )
      `,
      [orgId, orgId],
    );
    const hiddenCounted = await db.queryOne<{ count: unknown }>(
      `
        SELECT COUNT(*)::int AS count
        FROM thread_heads th
        WHERE th.org_id = $1
          AND th.thread_id IN (
            SELECT p.thread_id FROM conversation_prefs p
            WHERE p.org_id = $2 AND p.hidden = TRUE
          )
      `,
      [orgId, orgId],
    );
    const prefs = await db.queryOne<{
      pref_count: unknown;
      pref_updated_at: unknown;
    }>(
      `
        SELECT COUNT(*)::int AS pref_count,
               MAX(updated_at) AS pref_updated_at
        FROM conversation_prefs WHERE org_id = $1
      `,
      [orgId],
    );
    const work = await db.queryOne<{ work_updated_at: unknown }>(
      `
        SELECT MAX(updated_at) AS work_updated_at FROM (
          SELECT updated_at FROM work_items WHERE org_id = $1
          UNION ALL
          SELECT updated_at FROM work_deliveries WHERE org_id = $2
        ) work_times
      `,
      [orgId, orgId],
    );
    const count = asNumber(counted?.count ?? 0);
    return {
      count,
      hidden_count: asNumber(hiddenCounted?.count ?? 0),
      digest: formatInboxDigest({
        count,
        latest_at: latest ? toIso(latest.latest_at) : "",
        latest_id: latest?.latest_id ?? "",
        pref_count: asNumber(prefs?.pref_count ?? 0),
        pref_updated_at: prefs?.pref_updated_at ? toIso(prefs.pref_updated_at) : "",
        work_updated_at: work?.work_updated_at ? toIso(work.work_updated_at) : "",
      }),
    };
  }

export async function listConversationPrefs(db: PgSql, orgId: string): Promise<ConversationPref[]> {
    const rows = await db.query<PrefRow>(
      `
        SELECT ${PREF_COLUMNS}
        FROM conversation_prefs WHERE org_id = $1
        ORDER BY pinned DESC, updated_at DESC
      `,
      [orgId],
    );
    return rows.map((row) => toPref(db, row));
  }

export async function getConversationPref(db: PgSql, orgId: string, threadId: string, client?: PoolClient): Promise<ConversationPref | null> {
    const row = await db.queryOne<PrefRow>(
      `
        SELECT ${PREF_COLUMNS}
        FROM conversation_prefs WHERE org_id = $1 AND thread_id = $2
      `,
      [orgId, threadId],
      client,
    );
    return row ? toPref(db, row) : null;
  }

export async function putConversationPref(db: PgSql, input: ConversationPrefPatch): Promise<ConversationPref> {
    return db.withTx((client) => putConversationPrefOn(db, client, input));
  }

export async function putConversationPrefOn(db: PgSql, client: PoolClient, input: ConversationPrefPatch): Promise<ConversationPref> {
    const current = await db.queryOne<PrefRow>(
      `
        SELECT ${PREF_COLUMNS}
        FROM conversation_prefs WHERE org_id = $1 AND thread_id = $2
      `,
      [input.org_id, input.thread_id],
      client,
    );
    const hidden =
      input.hidden !== undefined ? input.hidden : asBool(current?.hidden);
    const next: ConversationPref = {
      org_id: input.org_id,
      thread_id: input.thread_id,
      title: input.title !== undefined ? input.title : (current?.title ?? null),
      pinned:
        input.pinned !== undefined ? input.pinned : asBool(current?.pinned),
      hidden,
      hidden_reason: hidden
        ? input.hidden_reason !== undefined
          ? input.hidden_reason
          : normalizeHiddenReason(current?.hidden_reason) ??
            (input.hidden === true ? "human" : null)
        : null,
      last_read_at:
        input.last_read_at !== undefined
          ? input.last_read_at
          : toIsoOrNull(current?.last_read_at),
      last_read_external_id:
        input.last_read_external_id !== undefined
          ? input.last_read_external_id
          : (current?.last_read_external_id ?? null),
      updated_at: input.updated_at,
    };
    await db.execute(
      `
        INSERT INTO conversation_prefs (
          org_id, thread_id, title, pinned, hidden, hidden_reason,
          last_read_at, last_read_external_id, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (org_id, thread_id) DO UPDATE SET
          title = EXCLUDED.title,
          pinned = EXCLUDED.pinned,
          hidden = EXCLUDED.hidden,
          hidden_reason = EXCLUDED.hidden_reason,
          last_read_at = EXCLUDED.last_read_at,
          last_read_external_id = EXCLUDED.last_read_external_id,
          updated_at = EXCLUDED.updated_at
      `,
      [
        next.org_id,
        next.thread_id,
        next.title,
        next.pinned,
        next.hidden,
        next.hidden_reason,
        next.last_read_at,
        next.last_read_external_id,
        next.updated_at,
      ],
      client,
    );
    return next;
  }

export async function refreshThreadHeadWithinTransaction(db: PgSql, orgId: string, threadId: string | null | undefined, client?: PoolClient): Promise<void> {
    const id = threadId?.trim();
    if (!id) {
      return;
    }
    const face = await db.queryOne<{
      face_event_id: string;
      face_occurred_at: unknown;
    }>(
      `
        SELECT e.id AS face_event_id, e.occurred_at AS face_occurred_at
        FROM message_dispositions d
        JOIN events e ON e.id = d.event_id
        WHERE e.org_id = $1
          AND e.thread_id = $2
          AND e.operation != 'tombstone'
          AND NOT (d.reason_codes ? 'thread_status')
        ORDER BY
          CASE WHEN ${isCurrentHeadSql("e")} THEN 0 ELSE 1 END,
          e.occurred_at DESC,
          e.id DESC
        LIMIT 1
      `,
      [orgId, id],
      client,
    );
    if (!face) {
      await db.execute(
        `DELETE FROM thread_heads WHERE org_id = $1 AND thread_id = $2`,
        [orgId, id],
        client,
      );
      return;
    }
    const currentWork = await db.queryOne<{ ok: number }>(
      `
        SELECT 1 AS ok
        FROM message_dispositions d2
        JOIN events e2 ON e2.id = d2.event_id
        WHERE e2.org_id = $1
          AND e2.thread_id = $2
          AND d2.disposition = 'current_work'
          AND ${isCurrentHeadSql("e2", "h2")}
        LIMIT 1
      `,
      [orgId, id],
      client,
    );
    await db.execute(
      `
        INSERT INTO thread_heads (
          org_id, thread_id, face_event_id, face_occurred_at, has_current_work
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (org_id, thread_id) DO UPDATE SET
          face_event_id = EXCLUDED.face_event_id,
          face_occurred_at = EXCLUDED.face_occurred_at,
          has_current_work = EXCLUDED.has_current_work
      `,
      [
        orgId,
        id,
        face.face_event_id,
        face.face_occurred_at,
        Boolean(currentWork),
      ],
      client,
    );
  }

function inboxSql(db: PgSql, orgId: string, query?: InboxQuery): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const p = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const hiddenList = normalizeInboxListView(query?.list) === "hidden";
    const scoped = inboxScoped(query);
    if (query?.heads) {
      const inner = headsScanQuery(query);
      if (hiddenList) {
        return hiddenHeadsSql(db, orgId, query, inner, p, params);
      }
      const visible = inboxClauses(db, orgId, inner, "any", {}, p);
      if (!scoped) {
        visible.push(notHiddenSql(p(orgId), "e"));
      }
      const page = materialHeadsPageTail(query, p);
      return {
        sql: `
          SELECT ${INBOX_COLUMNS}
          FROM thread_heads th
          JOIN events e ON e.id = th.face_event_id
          JOIN message_dispositions d ON d.event_id = e.id
          WHERE th.has_current_work = TRUE
            AND ${visible.join(" AND ")}
          ${page.whereSql}
          ${page.orderSql}
        `,
        params,
      };
    }
    if (query?.siblings) {
      const clauses = inboxClauses(db, orgId, query, "any", {}, p);
      if (!scoped) {
        if (hiddenList) {
          clauses.push(`e.thread_id IN (${hiddenThreadIdSql(p(orgId))})`);
        } else {
          clauses.push(`e.thread_id IN (
          SELECT e2.thread_id
          FROM message_dispositions d2
          JOIN events e2 ON e2.id = d2.event_id
          WHERE d2.org_id = ${p(orgId)} AND d2.disposition = 'current_work'
            AND ${isCurrentHeadSql("e2", "h2")}
        )`);
          clauses.push(notHiddenSql(p(orgId), "e"));
        }
      }
      const tail = inboxTail(query, p);
      return {
        sql: `
          SELECT ${INBOX_COLUMNS}
          FROM message_dispositions d
          JOIN events e ON e.id = d.event_id
          WHERE ${clauses.join(" AND ")}
            AND ${isCurrentHeadSql("e")}
          ${tail.orderSql}
        `,
        params,
      };
    }
    if (hiddenList) {
      const clauses = inboxClauses(db, orgId, query, "any", {}, p);
      if (!scoped) {
        clauses.push(`e.thread_id IN (${hiddenThreadIdSql(p(orgId))})`);
      }
      const tail = inboxTail(query, p);
      return {
        sql: `
          SELECT ${INBOX_COLUMNS}
          FROM message_dispositions d
          JOIN events e ON e.id = d.event_id
          WHERE ${clauses.join(" AND ")}
            AND ${isCurrentHeadSql("e")}
          ${tail.orderSql}
        `,
        params,
      };
    }
    const clauses = inboxClauses(db, orgId, query, "current_work", {}, p);
    if (!scoped) {
      clauses.push(notHiddenSql(p(orgId), "e"));
    }
    const tail = inboxTail(query, p);
    return {
      sql: `
        SELECT ${INBOX_COLUMNS}
        FROM message_dispositions d
        JOIN events e ON e.id = d.event_id
        WHERE ${clauses.join(" AND ")}
          AND ${isCurrentHeadSql("e")}
        ${tail.orderSql}
      `,
      params,
    };
  }

function hiddenHeadsSql(db: PgSql, orgId: string, query: InboxQuery | undefined, inner: InboxQuery | undefined, p: (value: unknown) => string, params: unknown[]): { sql: string; params: unknown[] } {
    const visible = inboxClauses(db, orgId, inner, "any", {}, p);
    const hidden = hiddenThreadIdSql(p(orgId));
    const page = materialHeadsPageTail(query, p);
    return {
      sql: `
        SELECT ${INBOX_COLUMNS}
        FROM thread_heads th
        JOIN events e ON e.id = th.face_event_id
        JOIN message_dispositions d ON d.event_id = e.id
        WHERE ${visible.join(" AND ")}
          AND e.thread_id IN (${hidden})
        ${page.whereSql}
        ${page.orderSql}
      `,
      params,
    };
  }

function inboxClauses(db: PgSql, orgId: string, query: InboxQuery | undefined, disposition: "current_work" | "any", tables: { event?: string; disposition?: string }, p: (value: unknown) => string): string[] {
    const event = tables.event ?? "e";
    const decision = tables.disposition ?? "d";
    const clauses = [`${event}.org_id = ${p(orgId)}`];
    if (disposition === "current_work") {
      clauses.push(`${decision}.disposition = 'current_work'`);
    }
    if (query?.source) {
      clauses.push(`${event}.source = ${p(query.source)}`);
    }
    if (query?.target) {
      clauses.push(
        `(${event}.external_id = ${p(query.target)} OR ${event}.external_id LIKE ${p(threadExternalIdLike(query.target))} ESCAPE E'\\\\')`,
      );
    }
    if (query?.thread_ids && query.thread_ids.length > 0) {
      clauses.push(
        `${event}.thread_id IN (${query.thread_ids.map((id) => p(id)).join(", ")})`,
      );
    }
    if (query?.since) {
      clauses.push(
        `(${event}.ingested_at > ${p(query.since)} OR (${event}.ingested_at = ${p(query.since)} AND ${event}.id > ${p(query.since_id ?? "")}))`,
      );
    }
    if (query?.before) {
      clauses.push(
        `(${event}.occurred_at < ${p(query.before)} OR (${event}.occurred_at = ${p(query.before)} AND ${event}.id < ${p(query.before_id ?? "")}))`,
      );
    }
    return clauses;
  }

function toInboxItem(db: PgSql, row: InboxRow): InboxItem {
    return {
      decision: toDisposition(db, {
        event_id: row.event_id,
        org_id: row.disposition_org_id,
        disposition: row.disposition,
        layer: row.layer,
        reason_codes: row.reason_codes,
        score: row.score,
        decided_at: row.decided_at,
      }),
      event: toEvent(db, {
        id: row.id,
        org_id: row.disposition_org_id,
        source: row.source,
        external_id: row.external_id,
        operation: row.operation,
        content_hash: row.content_hash,
        parent_event_id: row.parent_event_id,
        thread_id: row.thread_id,
        actor_id: row.actor_id,
        required_scope_ids: row.required_scope_ids,
        direction_tags: row.direction_tags,
        weight_hints: row.weight_hints,
        attrs: row.attrs,
        occurred_at: row.occurred_at,
        ingested_at: row.ingested_at,
      }),
    };
  }

function toPref(db: PgSql, row: PrefRow): ConversationPref {
    const hidden = asBool(row.hidden);
    return {
      org_id: row.org_id,
      thread_id: row.thread_id,
      title: row.title,
      pinned: asBool(row.pinned),
      hidden,
      hidden_reason: hidden ? normalizeHiddenReason(row.hidden_reason) : null,
      last_read_at: toIsoOrNull(row.last_read_at),
      last_read_external_id: row.last_read_external_id,
      updated_at: toIso(row.updated_at),
    };
  }

function toDisposition(db: PgSql, row: DispositionRow): ArrangementDecision {
    return {
      event_id: row.event_id,
      org_id: row.org_id,
      disposition: row.disposition,
      layer: row.layer,
      reason_codes: asJson<string[]>(row.reason_codes),
      score: asNumber(row.score),
      decided_at: toIso(row.decided_at),
    };
  }

function inboxUsesNewestFirst(query?: InboxQuery): boolean {
  return Boolean(normalizeInboxLimit(query?.limit));
}

function headsPageTail(
  query: InboxQuery | undefined,
  p: (value: unknown) => string,
): {
  whereSql: string;
  orderSql: string;
} {
  let whereSql = "WHERE rn = 1";
  if (query?.before) {
    whereSql +=
      ` AND (occurred_at < ${p(query.before)} OR (occurred_at = ${p(query.before)} AND id < ${p(query.before_id ?? "")}))`;
  }
  const limit = normalizeInboxLimit(query?.limit);
  if (limit !== undefined) {
    return {
      whereSql,
      orderSql: `ORDER BY occurred_at DESC, id DESC LIMIT ${p(limit)}`,
    };
  }
  return {
    whereSql,
    orderSql: "ORDER BY occurred_at ASC, id ASC",
  };
}

function materialHeadsPageTail(
  query: InboxQuery | undefined,
  p: (value: unknown) => string,
): {
  whereSql: string;
  orderSql: string;
} {
  let whereSql = "";
  if (query?.before) {
    whereSql =
      `AND (e.occurred_at < ${p(query.before)} OR (e.occurred_at = ${p(query.before)} AND e.id < ${p(query.before_id ?? "")}))`;
  }
  const limit = normalizeInboxLimit(query?.limit);
  if (limit !== undefined) {
    return {
      whereSql,
      orderSql: `ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${p(limit)}`,
    };
  }
  return {
    whereSql,
    orderSql: "ORDER BY e.occurred_at ASC, e.id ASC",
  };
}

function isCurrentHeadSql(event = "e", heads = "h"): string {
  return `EXISTS (
    SELECT 1 FROM source_heads ${heads}
    WHERE ${heads}.current_event_id = ${event}.id
  )`;
}

function hiddenThreadIdSql(orgPlaceholder: string): string {
  return `SELECT thread_id FROM conversation_prefs WHERE org_id = ${orgPlaceholder} AND hidden = TRUE`;
}

function notHiddenSql(orgPlaceholder: string, event = "e"): string {
  return `${event}.thread_id NOT IN (SELECT pref.thread_id FROM conversation_prefs pref WHERE pref.org_id = ${orgPlaceholder} AND pref.hidden = TRUE)`;
}

function inboxScoped(query?: InboxQuery): boolean {
  return Boolean(query?.source || query?.target || query?.thread_ids);
}

function inboxTail(
  query: InboxQuery | undefined,
  p: (value: unknown) => string,
): {
  orderSql: string;
} {
  const limit = query?.heads ? undefined : normalizeInboxLimit(query?.limit);
  if (limit !== undefined) {
    return {
      orderSql: `ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${p(limit)}`,
    };
  }
  return {
    orderSql: "ORDER BY e.occurred_at ASC, e.id ASC",
  };
}
