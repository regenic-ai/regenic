import type {
  ArrangementDecision,
  InboxDispositionTransition,
  InboxDispositionTransitionResult,
  InboxQuery,
  InboxItem,
  InboxSummary,
  ConversationPref,
  ConversationPrefPatch,
  ConversationPrefWrite,
  ConversationPolicyFold,
  ConversationPolicyFoldResult,
  ConversationPolicyVisibility,
} from "@regenic/domain";
import type {
  PoolClient,
} from "pg";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  formatInboxDigest,
  normalizeHiddenReason,
  normalizeInboxListView,
  headsScanQuery,
  threadExternalIdLike,
  normalizeInboxLimit,
  TASK_INBOX_REASON,
  WORK_OBSERVE_AGAIN_STATUSES,
  assertConversationPolicyVisibility,
  assertInboxDispositionTransition,
  conversationId,
  conversationVisibilityCommand,
  sameInboxDispositionCommand,
  sameDispositionContent,
  sameConversationVisibilityCommand,
  mergeConversationReadCursor,
} from "@regenic/domain";
import { lockConversationThreads } from "./conversation-lock";
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
  version: number | string;
  disposition: ArrangementDecision["disposition"];
  layer: ArrangementDecision["layer"];
  reason_codes: unknown;
  score: unknown;
  decided_at: unknown;
}

interface InboxRow extends EventRow {
  event_id: string;
  disposition_org_id: string;
  version: number | string;
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
  visibility_version: number;
  last_read_at: unknown;
  last_read_external_id: string | null;
  updated_at: unknown;
}

const PREF_COLUMNS = `
  org_id, thread_id, title, pinned, hidden, hidden_reason, visibility_version,
  last_read_at, last_read_external_id, updated_at
`;

const INBOX_COLUMNS = `
  d.event_id, d.org_id AS disposition_org_id, d.version, d.disposition, d.layer,
  d.reason_codes, d.score, d.decided_at,
  e.id, e.source, e.external_id, e.operation, e.content_hash,
  e.parent_event_id, e.thread_id, e.actor_id, e.required_scope_ids,
  e.direction_tags, e.weight_hints, e.attrs,
  e.occurred_at, e.ingested_at
`;

export async function putDispositionIfAbsent(
  db: PgSql,
  decision: ArrangementDecision,
): Promise<boolean> {
  return db.withTx((client) => putDispositionIfAbsentOn(db, decision, client));
}

export async function putDispositionIfAbsentOn(
  db: PgSql,
  decision: ArrangementDecision,
  client: PoolClient,
): Promise<boolean> {
    const event = await db.queryOne<{
      org_id: string;
      source: string;
      external_id: string;
      thread_id: string | null;
    }>(
      `SELECT org_id, source, external_id, thread_id FROM events WHERE id = $1`,
      [decision.event_id],
      client,
    );
    if (event?.org_id !== decision.org_id) {
      throw new Error("Disposition event is not owned by the requested organization");
    }
    await lockConversationThreads(db, client, [{
      org_id: event.org_id,
      thread_id: event.thread_id ?? conversationId(
        event.source,
        event.external_id,
        decision.event_id,
      ),
    }]);
    const currentEvent = await db.queryOne<{ org_id: string }>(
      `SELECT org_id FROM events WHERE id = $1 FOR SHARE`,
      [decision.event_id],
      client,
    );
    if (currentEvent?.org_id !== decision.org_id) {
      throw new Error("Disposition event is not owned by the requested organization");
    }
    const inserted = await db.execute(`
      INSERT INTO message_dispositions (
        event_id, org_id, disposition, layer, reason_codes, score, decided_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (event_id) DO NOTHING
    `, [
      decision.event_id,
      decision.org_id,
      decision.disposition,
      decision.layer,
      jsonb(decision.reason_codes),
      decision.score,
      decision.decided_at,
    ], client);
    if (inserted === 0) {
      return false;
    }
    const row = await db.queryOne<{ thread_id: string | null }>(
      `SELECT thread_id FROM events WHERE id = $1 AND org_id = $2`,
      [decision.event_id, decision.org_id],
      client,
    );
    await refreshThreadHeadWithinTransaction(
      db,
      decision.org_id,
      row?.thread_id,
      client,
    );
    if (decision.disposition === "current_work") {
      await unfoldCurrentWorkWithinTransaction(db, client, {
        org_id: decision.org_id,
        thread_id: event.thread_id ?? conversationId(event.source, event.external_id, decision.event_id),
        event_id: decision.event_id, cause: "current_work_disposition_restored",
        dedupe_id: decision.event_id, now: decision.decided_at,
      });
    }
    return true;
}

export async function transitionDisposition(
  db: PgSql,
  input: InboxDispositionTransition,
): Promise<InboxDispositionTransitionResult> {
  assertInboxDispositionTransition(input);
  const { expected, decision, command } = input;
  return db.withTx(async (client) => {
    await db.queryOne(
      "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text, 'lifecycle-command', $2::text)::text, 0))",
      [command.org_id, command.command_id],
      client,
    );
    const event = await db.queryOne<{ org_id: string; thread_id: string | null; source: string; external_id: string }>(
      `SELECT org_id, thread_id, source, external_id FROM events WHERE id = $1 AND org_id = $2`,
      [command.event_id, command.org_id],
      client,
    );
    if (!event) return { outcome: "conflict" };
    const threadId = event.thread_id ?? conversationId(event.source, event.external_id, command.event_id);
    await lockConversationThreads(db, client, [{
      org_id: event.org_id,
      thread_id: threadId,
    }]);
    const existing = await db.queryOne<{
      thread_id: string;
      aggregate_type: string;
      event_type: string;
      payload_json: unknown;
    }>(`SELECT thread_id, aggregate_type, event_type, payload_json
      FROM conversation_lifecycle_events WHERE org_id = $1 AND command_id = $2`,
    [command.org_id, command.command_id], client);
    if (existing) {
      const payload = asJson<{
        command?: unknown;
        result?: ArrangementDecision;
      }>(existing.payload_json);
      if (
        existing.thread_id !== threadId ||
        existing.aggregate_type !== "source_event" ||
        existing.event_type !== "current_work_changed" ||
        !sameInboxDispositionCommand(payload.command, command) ||
        !payload.result
      ) {
        return { outcome: "command_conflict" };
      }
      return { outcome: "replayed", decision: payload.result };
    }
    const row = await db.queryOne<DispositionRow>(`SELECT event_id, org_id, version, disposition, layer,
      reason_codes, score, decided_at FROM message_dispositions WHERE event_id = $1 FOR UPDATE`,
    [expected.event_id], client);
    if (!row || !isDeepStrictEqual(toDisposition(db, row), expected)) {
      return { outcome: "conflict" };
    }
    const version = await db.queryOne<{ version: number }>(`SELECT COALESCE(MAX(aggregate_version), 0) + 1 AS version
      FROM conversation_lifecycle_events WHERE org_id = $1 AND aggregate_type = 'source_event'
        AND aggregate_id = $2`, [command.org_id, command.event_id], client);
    const result = {
      ...decision,
      version: (expected.version ?? 0) +
        (sameDispositionContent(expected, decision) ? 0 : 1),
      reason_codes: [...decision.reason_codes],
    };
    await putDispositionWithinTransaction(db, result, client);
    if (result.disposition === "current_work") {
      await unfoldCurrentWorkWithinTransaction(db, client, {
        org_id: command.org_id, thread_id: threadId, event_id: command.event_id,
        cause: "current_work_disposition_changed", dedupe_id: command.command_id, now: decision.decided_at,
      });
    }
    await db.execute(`INSERT INTO conversation_lifecycle_events (
      id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
      event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
    ) VALUES ($1, $2, $3, 'source_event', $4, $5, 'current_work_changed', $6, $7, 1, $8, $9, $10)`,
    [
      randomUUID(),
      command.org_id,
      threadId,
      command.event_id,
      asNumber(version?.version ?? 0),
      command.command_id,
      JSON.stringify(["source_event", command.event_id, version?.version ?? 0, "current_work_changed"]),
      jsonb({ command, previous: expected, result }),
      command.issued_at,
      decision.decided_at,
    ], client);
    return { outcome: "applied", decision: result };
  });
}

export async function unfoldCurrentWorkWithinTransaction(
  db: PgSql,
  client: PoolClient,
  input: {
    org_id: string; thread_id: string; event_id: string;
    cause: "current_work_ingested" | "current_work_disposition_changed" | "current_work_disposition_restored"
      | "current_work_visibility_reconciled";
    dedupe_id: string; now: string;
  },
): Promise<void> {
  const unfolded = await db.queryOne<{ visibility_version: number }>(`UPDATE conversation_prefs
    SET hidden = FALSE, hidden_reason = NULL, updated_at = $1
    WHERE org_id = $2 AND thread_id = $3 AND hidden = TRUE AND hidden_reason = 'policy'
      AND EXISTS (SELECT 1 FROM source_heads h JOIN events e ON e.id = h.current_event_id
        WHERE h.org_id = $2 AND e.org_id = h.org_id AND e.id = $4 AND e.operation <> 'tombstone')
    RETURNING visibility_version`, [input.now, input.org_id, input.thread_id, input.event_id], client);
  if (!unfolded) return;
  await recordPolicyVisibilityChanged(db, client, {
    ...input, visibility_version: asNumber(unfolded.visibility_version), hidden: false,
  });
}

async function recordPolicyVisibilityChanged(
  db: PgSql,
  client: PoolClient,
  input: {
    org_id: string; thread_id: string; visibility_version: number;
    hidden: boolean;
    dedupe_id: string; now: string;
  } & (
    | { cause: "policy_visibility_applied"; event_id?: never }
    | { cause: "current_work_ingested" | "current_work_disposition_changed" | "current_work_disposition_restored"
        | "current_work_visibility_reconciled" | "tombstone_visibility_reconciled"; event_id: string }
  ),
): Promise<void> {
  await db.execute(`INSERT INTO conversation_lifecycle_events (
    id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
    event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
  ) VALUES ($1, $2, $3, 'conversation', $3, $4, 'visibility_changed', NULL, $5, 1, $6, $7, $7)`, [
    randomUUID(), input.org_id, input.thread_id, input.visibility_version,
    JSON.stringify(["conversation", input.thread_id, input.cause, input.dedupe_id]),
    jsonb({ hidden: input.hidden, hidden_reason: input.hidden ? "policy" : null,
      cause: input.cause, ...(input.event_id !== undefined ? { event_id: input.event_id } : {}) }),
    input.now,
  ], client);
}

export async function putDispositionWithinTransaction(db: PgSql, decision: ArrangementDecision, client?: PoolClient): Promise<ArrangementDecision> {
    const saved = await db.queryOne<DispositionRow>(
      `
        INSERT INTO message_dispositions (
          event_id, org_id, version, disposition, layer, reason_codes, score, decided_at
        ) VALUES ($1, $2, 0, $3, $4, $5, $6, $7)
        ON CONFLICT (event_id) DO UPDATE SET
          org_id = EXCLUDED.org_id,
          version = message_dispositions.version + CASE WHEN
            message_dispositions.org_id IS DISTINCT FROM EXCLUDED.org_id OR
            message_dispositions.disposition IS DISTINCT FROM EXCLUDED.disposition OR
            message_dispositions.layer IS DISTINCT FROM EXCLUDED.layer OR
            message_dispositions.reason_codes IS DISTINCT FROM EXCLUDED.reason_codes OR
            message_dispositions.score IS DISTINCT FROM EXCLUDED.score OR
            message_dispositions.decided_at IS DISTINCT FROM EXCLUDED.decided_at
          THEN 1 ELSE 0 END,
          disposition = EXCLUDED.disposition,
          layer = EXCLUDED.layer,
          reason_codes = EXCLUDED.reason_codes,
          score = EXCLUDED.score,
          decided_at = EXCLUDED.decided_at
        RETURNING *
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
    if (!saved) throw new Error("Disposition was not saved");
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
    return toDisposition(db, saved);
  }

export async function getDisposition(db: PgSql, eventId: string): Promise<ArrangementDecision | null> {
    const row = await db.queryOne<DispositionRow>(
      `
        SELECT event_id, org_id, version, disposition, layer, reason_codes, score, decided_at
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
          AND e.operation <> 'tombstone'
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
          AND NOT EXISTS (
            SELECT 1 FROM conversation_prefs p
            WHERE p.org_id = th.org_id
              AND p.thread_id = th.thread_id
              AND p.hidden = TRUE
          )
          AND ${userConversationSql("th")}
      `,
      [orgId],
    );
    const hiddenCounted = await db.queryOne<{ count: unknown }>(
      `
        SELECT COUNT(*)::int AS count
        FROM thread_heads th
        WHERE th.org_id = $1
          AND EXISTS (
            SELECT 1 FROM conversation_prefs p
            WHERE p.org_id = th.org_id
              AND p.thread_id = th.thread_id
              AND p.hidden = TRUE
          )
          AND ${userConversationSql("th")}
      `,
      [orgId],
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
    if ("hidden" in input || "hidden_reason" in input || "expected_visibility_version" in input) {
      throw new Error("Conversation visibility must use a visibility command");
    }
    return db.withTx((client) => putConversationPrefOn(db, client, input));
  }

export async function putConversationPrefOn(db: PgSql, client: PoolClient, input: ConversationPrefWrite): Promise<ConversationPref> {
    await lockConversationPref(db, client, input.org_id, input.thread_id);
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
    const readCursor = mergeConversationReadCursor(
      current ? toPref(db, current) : null,
      input,
    );
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
      visibility_version: current?.visibility_version ?? 0,
      ...readCursor,
      updated_at: input.updated_at,
    };
    await db.execute(
      `
        INSERT INTO conversation_prefs (
          org_id, thread_id, title, pinned, hidden, hidden_reason, visibility_version,
          last_read_at, last_read_external_id, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
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
        next.visibility_version,
        next.last_read_at,
        next.last_read_external_id,
        next.updated_at,
      ],
      client,
    );
    return next;
  }

export async function setConversationVisibility(
  db: PgSql,
  input: import("@regenic/domain").ConversationVisibilityUpdate,
): Promise<import("@regenic/domain").ConversationVisibilityUpdateResult> {
  return db.withTx(async (client) => {
    if (input.command_id !== undefined) {
      await db.queryOne(
        "SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array($1::text, 'lifecycle-command', $2::text)::text, 0))",
        [input.org_id, input.command_id],
        client,
      );
    }
    await lockConversationPref(db, client, input.org_id, input.thread_id);
    const command = conversationVisibilityCommand(input);
    if (input.command_id !== undefined) {
      const existing = await db.queryOne<{
        thread_id: string;
        aggregate_type: string;
        event_type: string;
        payload_json: unknown;
      }>(`SELECT thread_id, aggregate_type, event_type, payload_json
        FROM conversation_lifecycle_events WHERE org_id = $1 AND command_id = $2`,
      [input.org_id, input.command_id], client);
      if (existing) {
        const payload = asJson<{
          command?: unknown;
          result?: ConversationPref;
        }>(existing.payload_json);
        if (
          existing.thread_id !== input.thread_id ||
          existing.aggregate_type !== "conversation" ||
          existing.event_type !== "visibility_intent_changed" ||
          !sameConversationVisibilityCommand(payload.command, command) ||
          !payload.result
        ) {
          return { outcome: "command_conflict" };
        }
        return { outcome: "replayed", pref: payload.result };
      }
    }
    const current = await db.queryOne<PrefRow>(`SELECT ${PREF_COLUMNS} FROM conversation_prefs
      WHERE org_id = $1 AND thread_id = $2 FOR UPDATE`, [input.org_id, input.thread_id], client);
    const currentVersion = current?.visibility_version ?? 0;
    if (currentVersion !== input.expected_version) {
      return { outcome: "conflict", current_version: currentVersion };
    }
    const pref = await putConversationPrefOn(db, client, {
      org_id: input.org_id,
      thread_id: input.thread_id,
      hidden: input.hidden,
      hidden_reason: input.hidden ? "human" : null,
      title: input.title,
      pinned: input.pinned,
      updated_at: input.updated_at,
    });
    const visibilityVersion = currentVersion + 1;
    await db.execute(`UPDATE conversation_prefs SET visibility_version = $1
      WHERE org_id = $2 AND thread_id = $3`, [visibilityVersion, input.org_id, input.thread_id], client);
    const result = { ...pref, visibility_version: visibilityVersion };
    if (input.command_id !== undefined) {
      await db.execute(`INSERT INTO conversation_lifecycle_events (
        id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
        event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
      ) VALUES ($1, $2, $3, 'conversation', $4, $5, 'visibility_intent_changed', $6, $7, 1, $8, $9, $10)`,
      [
        randomUUID(),
        input.org_id,
        input.thread_id,
        input.thread_id,
        visibilityVersion,
        input.command_id,
        JSON.stringify([
          "conversation",
          input.thread_id,
          visibilityVersion,
          "visibility_intent_changed",
        ]),
        jsonb({
          command,
          previous_version: currentVersion,
          result,
        }),
        input.issued_at ?? input.updated_at,
        input.updated_at,
      ], client);
    }
    return { outcome: "applied", pref: result };
  });
}

export async function setConversationPolicyHidden(
  db: PgSql,
  input: ConversationPolicyFold,
): Promise<ConversationPolicyFoldResult> {
  return setConversationPolicyVisibility(db, { ...input, hidden: true });
}

export async function setConversationPolicyVisibility(
  db: PgSql,
  input: ConversationPolicyVisibility,
): Promise<ConversationPolicyFoldResult> {
  return db.withTx((client) =>
    setConversationPolicyVisibilityOn(db, client, input),
  );
}

export async function setConversationPolicyVisibilityOn(
  db: PgSql,
  client: PoolClient,
  input: ConversationPolicyVisibility,
): Promise<ConversationPolicyFoldResult> {
  assertConversationPolicyVisibility(input);
  await lockConversationPref(db, client, input.org_id, input.thread_id);
  const current = await db.queryOne<PrefRow>(`SELECT ${PREF_COLUMNS} FROM conversation_prefs
    WHERE org_id = $1 AND thread_id = $2 FOR UPDATE`,
  [input.org_id, input.thread_id], client);
  const currentVersion = asNumber(current?.visibility_version ?? 0);
  if (currentVersion !== input.expected_visibility_version) {
    return { outcome: "conflict", current_version: currentVersion };
  }
  const unfoldEventId = input.unfold_current_work_event_ids
    ? await findCurrentWorkEventForThread(db, client, input.org_id, input.thread_id, input.unfold_current_work_event_ids)
    : undefined;
  if (input.unfold_current_work_event_ids && !unfoldEventId) {
    return { outcome: "unchanged" };
  }
  const tombstoneId = input.fold_current_tombstone_event_ids
    ? await findCurrentTombstoneForThread(db, client, input.org_id, input.thread_id, input.fold_current_tombstone_event_ids)
    : undefined;
  if (input.fold_current_tombstone_event_ids && !tombstoneId) {
    return { outcome: "unchanged" };
  }
  const excludedCurrentWorkEventId = input.fold_excluded_current_work_event_id;
  if (excludedCurrentWorkEventId &&
    !await findCurrentWorkEventForThread(db, client, input.org_id, input.thread_id, [excludedCurrentWorkEventId])) {
    return { outcome: "unchanged" };
  }
  if (input.hidden && (await hasCurrentWorkForThread(
    db, client, input.org_id, input.thread_id, undefined,
    excludedCurrentWorkEventId ? [excludedCurrentWorkEventId] : undefined,
  )
    || await db.queryOne(`SELECT 1 WHERE EXISTS (
      SELECT 1 FROM work_items
      WHERE org_id = $1 AND thread_id = $2 AND (
        status IN ('open', 'running', 'waiting_human', 'failed')
        OR (status = 'done' AND (current_run_id IS NULL OR acknowledged_run_id IS NULL
          OR acknowledged_run_id <> current_run_id))
      )
    )
    OR EXISTS (
      SELECT 1 FROM work_deliveries
      WHERE org_id = $1 AND work_item_id IN (
        SELECT id FROM work_items WHERE org_id = $1 AND thread_id = $2
      ) AND status <> 'acked'
    )`, [input.org_id, input.thread_id], client))) {
    return { outcome: "unchanged" };
  }
  if (
    input.hidden
      ? asBool(current?.hidden) && current?.hidden_reason !== "policy"
      : !asBool(current?.hidden) || current?.hidden_reason !== "policy"
  ) {
    return { outcome: "unchanged" };
  }
  if (asBool(current?.hidden) === input.hidden) {
    return { outcome: "unchanged" };
  }
  if (unfoldEventId) {
    await unfoldCurrentWorkWithinTransaction(db, client, {
      org_id: input.org_id, thread_id: input.thread_id, event_id: unfoldEventId,
      cause: "current_work_visibility_reconciled", dedupe_id: randomUUID(), now: input.updated_at,
    });
    const saved = await getConversationPref(db, input.org_id, input.thread_id, client);
    if (!saved || saved.hidden) throw new Error("Current-work visibility reconciliation lost its target");
    return { outcome: "applied", pref: saved };
  }
  const pref = await putConversationPrefOn(db, client, {
    org_id: input.org_id,
    thread_id: input.thread_id,
    hidden: input.hidden,
    hidden_reason: input.hidden ? "policy" : null,
    updated_at: input.updated_at,
  });
  if (tombstoneId) {
    await recordPolicyVisibilityChanged(db, client, {
      org_id: input.org_id, thread_id: input.thread_id, event_id: tombstoneId,
      visibility_version: currentVersion, hidden: true, cause: "tombstone_visibility_reconciled",
      dedupe_id: randomUUID(), now: input.updated_at,
    });
  } else {
    await recordPolicyVisibilityChanged(db, client, {
      org_id: input.org_id, thread_id: input.thread_id, visibility_version: currentVersion,
      hidden: input.hidden, cause: "policy_visibility_applied", dedupe_id: randomUUID(), now: input.updated_at,
    });
  }
  return { outcome: "applied", pref };
}

export async function hasCurrentWorkForThread(
  db: PgSql, client: PoolClient, orgId: string, threadId: string, eventIds?: readonly string[],
  excludedEventIds?: readonly string[],
): Promise<boolean> {
  return (await findCurrentWorkEventForThread(db, client, orgId, threadId, eventIds, excludedEventIds)) !== undefined;
}

async function findCurrentWorkEventForThread(
  db: PgSql, client: PoolClient, orgId: string, threadId: string, eventIds?: readonly string[],
  excludedEventIds?: readonly string[],
): Promise<string | undefined> {
  const rows = await db.query<{ id: string; source: string; external_id: string; thread_id: string | null }>(
    `SELECT e.id, e.source, e.external_id, e.thread_id
     FROM message_dispositions d
     JOIN events e ON e.id = d.event_id AND e.org_id = d.org_id
     WHERE d.org_id = $1 AND (e.thread_id = $2 OR e.thread_id IS NULL)
       AND e.operation <> 'tombstone'
       AND ($3::text[] IS NULL OR e.id = ANY($3::text[]))
       AND ($4::text[] IS NULL OR NOT e.id = ANY($4::text[]))
       AND d.disposition = 'current_work' AND EXISTS (
         SELECT 1 FROM source_heads h WHERE h.org_id = e.org_id AND h.current_event_id = e.id
       )`,
    [orgId, threadId, eventIds ?? null, excludedEventIds ?? null], client,
  );
  const validIds = new Set(rows.filter((event) =>
    (event.thread_id ?? conversationId(event.source, event.external_id, event.id)) === threadId)
    .map((event) => event.id));
  return eventIds ? eventIds.find((id) => validIds.has(id)) : validIds.values().next().value;
}

async function findCurrentTombstoneForThread(
  db: PgSql, client: PoolClient, orgId: string, threadId: string, eventIds: readonly string[],
): Promise<string | undefined> {
  const rows = await db.query<{ id: string; source: string; external_id: string; thread_id: string | null }>(
    `SELECT e.id, e.source, e.external_id, e.thread_id FROM events e
     WHERE e.org_id = $1 AND (e.thread_id = $2 OR e.thread_id IS NULL)
       AND e.operation = 'tombstone' AND e.id = ANY($3::text[])
       AND EXISTS (SELECT 1 FROM source_heads h WHERE h.org_id = e.org_id AND h.current_event_id = e.id)`,
    [orgId, threadId, eventIds], client,
  );
  const validIds = new Set(rows.filter((event) =>
    (event.thread_id ?? conversationId(event.source, event.external_id, event.id)) === threadId)
    .map((event) => event.id));
  return eventIds.find((id) => validIds.has(id));
}

async function lockConversationPref(db: PgSql, client: PoolClient, orgId: string, threadId: string): Promise<void> {
  await lockConversationThreads(db, client, [{ org_id: orgId, thread_id: threadId }]);
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
          AND e2.operation <> 'tombstone'
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
      if (query?.needs_work) {
        const marks = WORK_OBSERVE_AGAIN_STATUSES.map((status) => p(status)).join(", ");
        visible.push(`NOT EXISTS (
          SELECT 1 FROM work_items w
          WHERE w.org_id = th.org_id
            AND w.thread_id = th.thread_id
            AND w.unit_key = e.id
            AND w.status NOT IN (${marks})
        )`);
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
            AND e2.operation <> 'tombstone'
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
    const clauses = inboxClauses(
      db,
      orgId,
      query,
      query?.disposition ?? "current_work",
      {},
      p,
    );
    if (!scoped || query?.push_candidates) {
      clauses.push(notHiddenSql(p(orgId), "e", query?.push_candidates));
    }
    if (query?.tasks !== undefined) {
      clauses.push(`${query.tasks ? "" : "NOT "}(d.reason_codes ? ${p(TASK_INBOX_REASON)})`);
    }
    if (query?.needs_work) {
      const marks = WORK_OBSERVE_AGAIN_STATUSES.map((status) => p(status)).join(", ");
      clauses.push(`NOT EXISTS (
          SELECT 1 FROM work_items w
          WHERE w.org_id = e.org_id
            AND w.thread_id = e.thread_id
            AND w.unit_key = e.id
            AND w.status NOT IN (${marks})
        )`);
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

function inboxClauses(db: PgSql, orgId: string, query: InboxQuery | undefined, disposition: "current_work" | "pending" | "any", tables: { event?: string; disposition?: string }, p: (value: unknown) => string): string[] {
    const event = tables.event ?? "e";
    const decision = tables.disposition ?? "d";
    const clauses = [`${event}.org_id = ${p(orgId)}`];
    if (disposition === "current_work" && query?.push_candidates) {
      clauses.push(`(${decision}.disposition = 'current_work' OR (
        ${decision}.disposition = 'pending'
        AND NOT (${decision}.reason_codes ? 'human_triage')
      ))`);
    } else if (disposition !== "any") {
      clauses.push(`${decision}.disposition = ${p(disposition)}`);
      if (disposition === "current_work") {
        clauses.push(`${event}.operation <> 'tombstone'`);
      }
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
        version: asNumber(row.version),
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
      visibility_version: asNumber(row.visibility_version),
      last_read_at: toIsoOrNull(row.last_read_at),
      last_read_external_id: row.last_read_external_id,
      updated_at: toIso(row.updated_at),
    };
  }

function toDisposition(db: PgSql, row: DispositionRow): ArrangementDecision {
    return {
      event_id: row.event_id,
      org_id: row.org_id,
      version: asNumber(row.version),
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

/** A session an Agent opened to do work is not one of the user's conversations. */
function userConversationSql(head: string): string {
  return `NOT EXISTS (
    SELECT 1 FROM work_runs r
    WHERE r.org_id = ${head}.org_id
      AND r.agent_thread_id = ${head}.thread_id
      AND NOT EXISTS (
        SELECT 1 FROM work_items i
        WHERE i.org_id = r.org_id AND i.thread_id = r.agent_thread_id
      )
  )`;
}

function notHiddenSql(orgPlaceholder: string, event = "e", allowPolicyFold = false): string {
  return `${event}.thread_id NOT IN (SELECT pref.thread_id FROM conversation_prefs pref WHERE pref.org_id = ${orgPlaceholder} AND pref.hidden = TRUE${
    allowPolicyFold ? " AND COALESCE(pref.hidden_reason, 'human') <> 'policy'" : ""
  })`;
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
