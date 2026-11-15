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
import Database from "better-sqlite3";
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
import {
  EventRow,
  toEvent,
} from "./events";

interface DispositionRow {
  event_id: string;
  org_id: string;
  version: number;
  disposition: ArrangementDecision["disposition"];
  layer: ArrangementDecision["layer"];
  reason_codes_json: string;
  score: number;
  decided_at: string;
}

interface InboxRow extends EventRow {
  event_id: string;
  disposition_org_id: string;
  version: number;
  disposition: ArrangementDecision["disposition"];
  layer: ArrangementDecision["layer"];
  reason_codes_json: string;
  score: number;
  decided_at: string;
}

interface PrefRow {
  org_id: string;
  thread_id: string;
  title: string | null;
  pinned: number;
  hidden: number;
  hidden_reason: string | null;
  visibility_version: number;
  last_read_at: string | null;
  last_read_external_id: string | null;
  updated_at: string;
}

const PREF_COLUMNS = `
  org_id, thread_id, title, pinned, hidden, hidden_reason, visibility_version,
  last_read_at, last_read_external_id, updated_at
`;

const INBOX_COLUMNS = `
  d.event_id, d.org_id AS disposition_org_id, d.version, d.disposition, d.layer,
  d.reason_codes_json, d.score, d.decided_at,
  e.id, e.source, e.external_id, e.operation, e.content_hash,
  e.parent_event_id, e.thread_id, e.actor_id, e.required_scope_ids_json,
  e.direction_tags_json, e.weight_hints_json, e.attrs_json,
  e.occurred_at, e.ingested_at
`;

export async function putDispositionIfAbsent(
  db: Database.Database,
  decision: ArrangementDecision,
): Promise<boolean> {
  return db.transaction(() => putDispositionIfAbsentWithinTransaction(db, decision)).immediate();
}

export function putDispositionIfAbsentWithinTransaction(
  db: Database.Database,
  decision: ArrangementDecision,
): boolean {
    const event = db.prepare(`SELECT org_id FROM events WHERE id = ?`)
      .get(decision.event_id) as { org_id: string } | undefined;
    if (event?.org_id !== decision.org_id) {
      throw new Error("Disposition event is not owned by the requested organization");
    }
    const result = db.prepare(`
      INSERT INTO message_dispositions (
        event_id, org_id, disposition, layer, reason_codes_json, score, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `).run(
      decision.event_id,
      decision.org_id,
      decision.disposition,
      decision.layer,
      JSON.stringify(decision.reason_codes),
      decision.score,
      decision.decided_at,
    );
    if (result.changes > 0) {
      const row = db.prepare(`SELECT thread_id, source, external_id FROM events WHERE id = ?`)
        .get(decision.event_id) as { thread_id: string | null; source: string; external_id: string };
      refreshThreadHeadWithinTransaction(db, decision.org_id, row?.thread_id);
      if (decision.disposition === "current_work") {
        unfoldCurrentWorkWithinTransaction(db, {
          org_id: decision.org_id, thread_id: row.thread_id ?? conversationId(row.source, row.external_id, decision.event_id),
          event_id: decision.event_id, cause: "current_work_disposition_restored",
          dedupe_id: decision.event_id, now: decision.decided_at,
        });
      }
      return true;
    }
    return false;
}

export async function transitionDisposition(
  db: Database.Database,
  input: InboxDispositionTransition,
): Promise<InboxDispositionTransitionResult> {
  assertInboxDispositionTransition(input);
  const { expected, decision, command } = input;
  return db.transaction(() => {
    const event = db.prepare(`SELECT thread_id, source, external_id FROM events
      WHERE id = ? AND org_id = ?`).get(command.event_id, command.org_id) as
      | { thread_id: string | null; source: string; external_id: string }
      | undefined;
    if (!event) return { outcome: "conflict" as const };
    const threadId = event.thread_id ?? conversationId(event.source, event.external_id, command.event_id);
    const existing = db.prepare(`SELECT thread_id, aggregate_type, event_type, payload_json
      FROM conversation_lifecycle_events WHERE org_id = ? AND command_id = ?`)
      .get(command.org_id, command.command_id) as
      | { thread_id: string; aggregate_type: string; event_type: string; payload_json: string }
      | undefined;
    if (existing) {
      const payload = JSON.parse(existing.payload_json) as {
        command?: unknown;
        result?: ArrangementDecision;
      };
      if (
        existing.thread_id !== threadId ||
        existing.aggregate_type !== "source_event" ||
        existing.event_type !== "current_work_changed" ||
        !sameInboxDispositionCommand(payload.command, command) ||
        !payload.result
      ) {
        return { outcome: "command_conflict" as const };
      }
      return { outcome: "replayed" as const, decision: payload.result };
    }
    const current = db.prepare(`SELECT event_id, org_id, version, disposition, layer,
      reason_codes_json, score, decided_at FROM message_dispositions WHERE event_id = ?`)
      .get(expected.event_id) as DispositionRow | undefined;
    if (!current || !isDeepStrictEqual(toDisposition(db, current), expected)) {
      return { outcome: "conflict" as const };
    }
    const aggregateVersion = (db.prepare(`SELECT COALESCE(MAX(aggregate_version), 0) + 1 AS version
      FROM conversation_lifecycle_events WHERE org_id = ? AND aggregate_type = 'source_event'
        AND aggregate_id = ?`).get(command.org_id, command.event_id) as { version: number }).version;
    putDispositionWithinTransaction(db, decision);
    const result = {
      ...decision,
      version: (expected.version ?? 0) +
        (sameDispositionContent(expected, decision) ? 0 : 1),
      reason_codes: [...decision.reason_codes],
    };
    if (result.disposition === "current_work") {
      unfoldCurrentWorkWithinTransaction(db, {
        org_id: command.org_id, thread_id: threadId, event_id: command.event_id,
        cause: "current_work_disposition_changed", dedupe_id: command.command_id, now: decision.decided_at,
      });
    }
    db.prepare(`INSERT INTO conversation_lifecycle_events (
      id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
      event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
    ) VALUES (?, ?, ?, 'source_event', ?, ?, 'current_work_changed', ?, ?, 1, ?, ?, ?)`)
      .run(
        randomUUID(),
        command.org_id,
        threadId,
        command.event_id,
        aggregateVersion,
        command.command_id,
        JSON.stringify(["source_event", command.event_id, aggregateVersion, "current_work_changed"]),
        JSON.stringify({ command, previous: expected, result }),
        command.issued_at,
        decision.decided_at,
      );
    return { outcome: "applied" as const, decision: result };
  }).immediate();
}

export function unfoldCurrentWorkWithinTransaction(
  db: Database.Database,
  input: {
    org_id: string; thread_id: string; event_id: string;
    cause: "current_work_ingested" | "current_work_disposition_changed" | "current_work_disposition_restored"
      | "current_work_visibility_reconciled";
    dedupe_id: string; now: string;
  },
): void {
  const unfolded = db.prepare(`UPDATE conversation_prefs
    SET hidden = 0, hidden_reason = NULL, updated_at = ?
    WHERE org_id = ? AND thread_id = ? AND hidden = 1 AND hidden_reason = 'policy'
      AND EXISTS (SELECT 1 FROM source_heads h JOIN events e ON e.id = h.current_event_id
        WHERE h.org_id = ? AND e.org_id = h.org_id AND e.id = ? AND e.operation <> 'tombstone')
    RETURNING visibility_version`).get(
    input.now, input.org_id, input.thread_id, input.org_id, input.event_id,
  ) as { visibility_version: number } | undefined;
  if (!unfolded) return;
  recordPolicyVisibilityChanged(db, {
    ...input, visibility_version: unfolded.visibility_version, hidden: false,
  });
}

function recordPolicyVisibilityChanged(
  db: Database.Database,
  input: {
    org_id: string; thread_id: string; visibility_version: number;
    hidden: boolean;
    dedupe_id: string; now: string;
  } & (
    | { cause: "policy_visibility_applied"; event_id?: never }
    | { cause: "current_work_ingested" | "current_work_disposition_changed" | "current_work_disposition_restored"
        | "current_work_visibility_reconciled" | "tombstone_visibility_reconciled"; event_id: string }
  ),
): void {
  db.prepare(`INSERT INTO conversation_lifecycle_events (
    id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
    event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
  ) VALUES (?, ?, ?, 'conversation', ?, ?, 'visibility_changed', NULL, ?, 1, ?, ?, ?)`)
    .run(
      randomUUID(), input.org_id, input.thread_id, input.thread_id, input.visibility_version,
      JSON.stringify(["conversation", input.thread_id, input.cause, input.dedupe_id]),
      JSON.stringify({ hidden: input.hidden, hidden_reason: input.hidden ? "policy" : null,
        cause: input.cause, ...(input.event_id !== undefined ? { event_id: input.event_id } : {}) }),
      input.now, input.now,
    );
}

export function putDispositionWithinTransaction(db: Database.Database, decision: ArrangementDecision): ArrangementDecision {
    const saved = db
      .prepare(
        `
          INSERT INTO message_dispositions (
            event_id, org_id, version, disposition, layer, reason_codes_json, score, decided_at
          ) VALUES (?, ?, 0, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO UPDATE SET
            org_id = excluded.org_id,
            version = message_dispositions.version + CASE WHEN
              message_dispositions.org_id IS NOT excluded.org_id OR
              message_dispositions.disposition IS NOT excluded.disposition OR
              message_dispositions.layer IS NOT excluded.layer OR
              message_dispositions.reason_codes_json IS NOT excluded.reason_codes_json OR
              message_dispositions.score IS NOT excluded.score OR
              message_dispositions.decided_at IS NOT excluded.decided_at
            THEN 1 ELSE 0 END,
            disposition = excluded.disposition,
            layer = excluded.layer,
            reason_codes_json = excluded.reason_codes_json,
            score = excluded.score,
            decided_at = excluded.decided_at
          RETURNING *
        `,
      )
      .get(
        decision.event_id,
        decision.org_id,
        decision.disposition,
        decision.layer,
        JSON.stringify(decision.reason_codes),
        decision.score,
        decision.decided_at,
      ) as DispositionRow | undefined;
    if (!saved) throw new Error("Disposition was not saved");
    const row = db
      .prepare(`SELECT thread_id FROM events WHERE id = ?`)
      .get(decision.event_id) as { thread_id: string | null } | undefined;
    refreshThreadHeadWithinTransaction(db, decision.org_id, row?.thread_id);
    return toDisposition(db, saved);
  }

export async function getDisposition(db: Database.Database, eventId: string): Promise<ArrangementDecision | null> {
    const row = db
      .prepare(
        `
          SELECT event_id, org_id, version, disposition, layer, reason_codes_json, score, decided_at
          FROM message_dispositions WHERE event_id = ?
        `,
      )
      .get(eventId) as DispositionRow | undefined;
    return row ? toDisposition(db, row) : null;
  }

export async function listInbox(db: Database.Database, orgId: string, query?: InboxQuery): Promise<InboxItem[]> {
    if (query?.thread_ids && query.thread_ids.length === 0) {
      return [];
    }
    const { sql, params } = inboxSql(db, orgId, query);
    const rows = db.prepare(sql).all(...params) as InboxRow[];
    const items = rows.map((row) => toInboxItem(db, row));
    if (inboxUsesNewestFirst(query)) {
      items.reverse();
    }
    return items;
  }

export async function summarizeInbox(db: Database.Database, orgId: string): Promise<InboxSummary> {
    const latest = db
      .prepare(
        `
          SELECT e.ingested_at AS latest_at, e.id AS latest_id
          FROM events e
          JOIN message_dispositions d ON d.event_id = e.id
          WHERE e.org_id = ?
            AND d.disposition = 'current_work'
            AND e.operation <> 'tombstone'
            AND ${isCurrentHeadSql("e")}
            AND ${notHiddenSql("e")}
          ORDER BY e.ingested_at DESC, e.id DESC
          LIMIT 1
        `,
      )
      .get(orgId, orgId) as { latest_at: string; latest_id: string } | undefined;
    const counted = db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM thread_heads th
          WHERE th.org_id = ?
            AND th.has_current_work = 1
            AND NOT EXISTS (
              SELECT 1 FROM conversation_prefs p
              WHERE p.org_id = th.org_id
                AND p.thread_id = th.thread_id
                AND p.hidden = 1
            )
        `,
      )
      .get(orgId) as { count: number };
    const hiddenCounted = db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM thread_heads th
          WHERE th.org_id = ?
            AND EXISTS (
              SELECT 1 FROM conversation_prefs p
              WHERE p.org_id = th.org_id
                AND p.thread_id = th.thread_id
                AND p.hidden = 1
            )
        `,
      )
      .get(orgId) as { count: number };
    const prefs = db
      .prepare(
        `
          SELECT COUNT(*) AS pref_count,
                 COALESCE(MAX(updated_at), '') AS pref_updated_at
          FROM conversation_prefs WHERE org_id = ?
        `,
      )
      .get(orgId) as { pref_count: number; pref_updated_at: string };
    const work = db
      .prepare(
        `
          SELECT COALESCE(MAX(updated_at), '') AS work_updated_at FROM (
            SELECT updated_at FROM work_items WHERE org_id = ?
            UNION ALL
            SELECT updated_at FROM work_deliveries WHERE org_id = ?
          )
        `,
      )
      .get(orgId, orgId) as { work_updated_at: string };
    return {
      count: counted.count,
      hidden_count: hiddenCounted.count,
      digest: formatInboxDigest({
        count: counted.count,
        latest_at: latest?.latest_at ?? "",
        latest_id: latest?.latest_id ?? "",
        pref_count: prefs.pref_count,
        pref_updated_at: prefs.pref_updated_at,
        work_updated_at: work.work_updated_at,
      }),
    };
  }

export async function listConversationPrefs(db: Database.Database, orgId: string): Promise<ConversationPref[]> {
    const rows = db
      .prepare(
        `
          SELECT ${PREF_COLUMNS}
          FROM conversation_prefs WHERE org_id = ?
          ORDER BY pinned DESC, updated_at DESC
        `,
      )
      .all(orgId) as PrefRow[];
    return rows.map((row) => toPref(db, row));
  }

export async function getConversationPref(db: Database.Database, orgId: string, threadId: string): Promise<ConversationPref | null> {
    const row = db
      .prepare(
        `
          SELECT ${PREF_COLUMNS}
          FROM conversation_prefs WHERE org_id = ? AND thread_id = ?
        `,
      )
      .get(orgId, threadId) as PrefRow | undefined;
    return row ? toPref(db, row) : null;
  }

export async function putConversationPref(db: Database.Database, input: ConversationPrefPatch): Promise<ConversationPref> {
    if ("hidden" in input || "hidden_reason" in input || "expected_visibility_version" in input) {
      throw new Error("Conversation visibility must use a visibility command");
    }
    const transaction = db.transaction(() =>
      putConversationPrefUnlocked(db, input),
    );
    return transaction.immediate();
  }

export function putConversationPrefUnlocked(db: Database.Database, input: ConversationPrefWrite): ConversationPref {
    const current = db
      .prepare(
        `
          SELECT ${PREF_COLUMNS}
          FROM conversation_prefs WHERE org_id = ? AND thread_id = ?
        `,
      )
      .get(input.org_id, input.thread_id) as PrefRow | undefined;
    const hidden =
      input.hidden !== undefined ? input.hidden : Boolean(current?.hidden);
    const readCursor = mergeConversationReadCursor(
      current ? toPref(db, current) : null,
      input,
    );
    const next: ConversationPref = {
      org_id: input.org_id,
      thread_id: input.thread_id,
      title: input.title !== undefined ? input.title : (current?.title ?? null),
      pinned:
        input.pinned !== undefined ? input.pinned : Boolean(current?.pinned),
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
    db
      .prepare(
        `
          INSERT INTO conversation_prefs (
            org_id, thread_id, title, pinned, hidden, hidden_reason, visibility_version,
            last_read_at, last_read_external_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(org_id, thread_id) DO UPDATE SET
            title = excluded.title,
            pinned = excluded.pinned,
            hidden = excluded.hidden,
            hidden_reason = excluded.hidden_reason,
            last_read_at = excluded.last_read_at,
            last_read_external_id = excluded.last_read_external_id,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        next.org_id,
        next.thread_id,
        next.title,
        next.pinned ? 1 : 0,
        next.hidden ? 1 : 0,
        next.hidden_reason,
        next.visibility_version,
        next.last_read_at,
        next.last_read_external_id,
        next.updated_at,
      );
    return next;
  }

export async function setConversationVisibility(
  db: Database.Database,
  input: import("@regenic/domain").ConversationVisibilityUpdate,
): Promise<import("@regenic/domain").ConversationVisibilityUpdateResult> {
  return db.transaction(() => {
    const command = conversationVisibilityCommand(input);
    if (input.command_id !== undefined) {
      const existing = db.prepare(`SELECT thread_id, aggregate_type, event_type, payload_json
        FROM conversation_lifecycle_events WHERE org_id = ? AND command_id = ?`)
        .get(input.org_id, input.command_id) as
        | { thread_id: string; aggregate_type: string; event_type: string; payload_json: string }
        | undefined;
      if (existing) {
        const payload = JSON.parse(existing.payload_json) as {
          command?: unknown;
          result?: ConversationPref;
        };
        if (
          existing.thread_id !== input.thread_id ||
          existing.aggregate_type !== "conversation" ||
          existing.event_type !== "visibility_intent_changed" ||
          !sameConversationVisibilityCommand(payload.command, command) ||
          !payload.result
        ) {
          return { outcome: "command_conflict" as const };
        }
        return { outcome: "replayed" as const, pref: payload.result };
      }
    }
    const current = db.prepare(`SELECT ${PREF_COLUMNS} FROM conversation_prefs
      WHERE org_id = ? AND thread_id = ?`).get(input.org_id, input.thread_id) as PrefRow | undefined;
    const currentVersion = current?.visibility_version ?? 0;
    if (currentVersion !== input.expected_version) {
      return { outcome: "conflict" as const, current_version: currentVersion };
    }
    const pref = putConversationPrefUnlocked(db, {
      org_id: input.org_id,
      thread_id: input.thread_id,
      hidden: input.hidden,
      hidden_reason: input.hidden ? "human" : null,
      title: input.title,
      pinned: input.pinned,
      updated_at: input.updated_at,
    });
    const visibilityVersion = currentVersion + 1;
    db.prepare(`UPDATE conversation_prefs SET visibility_version = ?
      WHERE org_id = ? AND thread_id = ?`).run(visibilityVersion, input.org_id, input.thread_id);
    const result = { ...pref, visibility_version: visibilityVersion };
    if (input.command_id !== undefined) {
      db.prepare(`INSERT INTO conversation_lifecycle_events (
        id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
        event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
      ) VALUES (?, ?, ?, 'conversation', ?, ?, 'visibility_intent_changed', ?, ?, 1, ?, ?, ?)`)
        .run(
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
          JSON.stringify({
            command,
            previous_version: currentVersion,
            result,
          }),
          input.issued_at ?? input.updated_at,
          input.updated_at,
        );
    }
    return { outcome: "applied" as const, pref: result };
  }).immediate();
}

export async function setConversationPolicyHidden(
  db: Database.Database,
  input: ConversationPolicyFold,
): Promise<ConversationPolicyFoldResult> {
  return setConversationPolicyVisibility(db, { ...input, hidden: true });
}

export async function setConversationPolicyVisibility(
  db: Database.Database,
  input: ConversationPolicyVisibility,
): Promise<ConversationPolicyFoldResult> {
  return db.transaction(() =>
    setConversationPolicyVisibilityUnlocked(db, input),
  ).immediate();
}

export function hasCurrentWorkForThread(
  db: Database.Database, orgId: string, threadId: string, eventIds?: readonly string[],
  excludedEventIds?: readonly string[],
): boolean {
  return findCurrentWorkEventForThread(db, orgId, threadId, eventIds, excludedEventIds) !== undefined;
}

function findCurrentWorkEventForThread(
  db: Database.Database, orgId: string, threadId: string, eventIds?: readonly string[],
  excludedEventIds?: readonly string[],
): string | undefined {
  const rows = db.prepare(`SELECT e.id, e.source, e.external_id, e.thread_id
    FROM message_dispositions d
    JOIN events e ON e.id = d.event_id AND e.org_id = d.org_id
    WHERE d.org_id = ? AND (e.thread_id = ? OR e.thread_id IS NULL)
      AND e.operation <> 'tombstone'
      AND (? IS NULL OR e.id IN (SELECT value FROM json_each(?)))
      AND (? IS NULL OR e.id NOT IN (SELECT value FROM json_each(?)))
      AND d.disposition = 'current_work' AND EXISTS (
        SELECT 1 FROM source_heads h WHERE h.org_id = e.org_id AND h.current_event_id = e.id
      )`)
    .all(orgId, threadId, eventIds ? JSON.stringify(eventIds) : null,
      eventIds ? JSON.stringify(eventIds) : null,
      excludedEventIds ? JSON.stringify(excludedEventIds) : null,
      excludedEventIds ? JSON.stringify(excludedEventIds) : null) as
        { id: string; source: string; external_id: string; thread_id: string | null }[];
  const validIds = new Set(rows.filter((event) =>
    (event.thread_id ?? conversationId(event.source, event.external_id, event.id)) === threadId)
    .map((event) => event.id));
  return eventIds ? eventIds.find((id) => validIds.has(id)) : validIds.values().next().value;
}

function findCurrentTombstoneForThread(
  db: Database.Database, orgId: string, threadId: string, eventIds: readonly string[],
): string | undefined {
  const rows = db.prepare(`SELECT e.id, e.source, e.external_id, e.thread_id FROM events e
    WHERE e.org_id = ? AND (e.thread_id = ? OR e.thread_id IS NULL)
      AND e.operation = 'tombstone' AND e.id IN (SELECT value FROM json_each(?))
      AND EXISTS (SELECT 1 FROM source_heads h WHERE h.org_id = e.org_id AND h.current_event_id = e.id)`)
    .all(orgId, threadId, JSON.stringify(eventIds)) as
      { id: string; source: string; external_id: string; thread_id: string | null }[];
  const validIds = new Set(rows.filter((event) =>
    (event.thread_id ?? conversationId(event.source, event.external_id, event.id)) === threadId)
    .map((event) => event.id));
  return eventIds.find((id) => validIds.has(id));
}

export function hasUnfinishedWorkForThread(
  db: Database.Database, orgId: string, threadId: string,
): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM work_items w WHERE w.org_id = ? AND w.thread_id = ?
    AND (
      w.status IN ('open', 'running', 'waiting_human')
      OR (w.status = 'failed' AND (w.current_run_id IS NULL OR w.acknowledged_run_id IS NULL
        OR w.acknowledged_run_id <> w.current_run_id))
      OR (w.status = 'done' AND NOT EXISTS (
        SELECT 1 FROM work_runs r WHERE r.org_id = w.org_id AND r.work_item_id = w.id
          AND r.id = w.current_run_id AND r.status = 'completed' AND (
            w.acknowledged_run_id = r.id OR (
              r.completion_policy_version = 1 AND r.external_run_id IS NOT NULL
              AND w.head_event_id IS NOT NULL AND r.recipe_id = w.recipe_id
              AND (r.start_state IS NULL OR r.start_state = 'submitted')
              AND (r.write_back_required = 0 OR (
                r.write_back_required = 1 AND EXISTS (
                  SELECT 1 FROM work_deliveries d WHERE d.org_id = w.org_id AND d.work_item_id = w.id
                    AND d.run_id = r.id AND d.status = 'acked' AND d.write_back = 'sent'
                )
              ))
            )
          )
      ))
    ) LIMIT 1`).get(orgId, threadId));
}

export function setConversationPolicyVisibilityUnlocked(
  db: Database.Database,
  input: ConversationPolicyVisibility,
): ConversationPolicyFoldResult {
  assertConversationPolicyVisibility(input);
  const current = db.prepare(`SELECT ${PREF_COLUMNS} FROM conversation_prefs
    WHERE org_id = ? AND thread_id = ?`).get(input.org_id, input.thread_id) as PrefRow | undefined;
  const currentVersion = current?.visibility_version ?? 0;
  if (currentVersion !== input.expected_visibility_version) {
    return { outcome: "conflict", current_version: currentVersion };
  }
  const unfoldEventId = input.unfold_current_work_event_ids
    ? findCurrentWorkEventForThread(db, input.org_id, input.thread_id, input.unfold_current_work_event_ids)
    : undefined;
  if (input.unfold_current_work_event_ids && !unfoldEventId) {
    return { outcome: "unchanged" };
  }
  const tombstoneId = input.fold_current_tombstone_event_ids
    ? findCurrentTombstoneForThread(db, input.org_id, input.thread_id, input.fold_current_tombstone_event_ids)
    : undefined;
  if (input.fold_current_tombstone_event_ids && !tombstoneId) {
    return { outcome: "unchanged" };
  }
  const excludedCurrentWorkEventId = input.fold_excluded_current_work_event_id;
  if (excludedCurrentWorkEventId &&
    !findCurrentWorkEventForThread(db, input.org_id, input.thread_id, [excludedCurrentWorkEventId])) {
    return { outcome: "unchanged" };
  }
  if (input.hidden && (hasCurrentWorkForThread(
    db, input.org_id, input.thread_id, undefined,
    excludedCurrentWorkEventId ? [excludedCurrentWorkEventId] : undefined,
  )
    || hasUnfinishedWorkForThread(db, input.org_id, input.thread_id)
    || db.prepare(`SELECT 1 WHERE EXISTS (
      SELECT 1 FROM work_deliveries
      WHERE org_id = ? AND work_item_id IN (
        SELECT id FROM work_items WHERE org_id = ? AND thread_id = ?
      ) AND status <> 'acked'
    )`).get(
      input.org_id, input.org_id, input.thread_id,
    ))) {
    return { outcome: "unchanged" };
  }
  if (
    input.hidden
      ? Boolean(current?.hidden) && current?.hidden_reason !== "policy"
      : !Boolean(current?.hidden) || current?.hidden_reason !== "policy"
  ) {
    return { outcome: "unchanged" };
  }
  if (Boolean(current?.hidden) === input.hidden) {
    return { outcome: "unchanged" };
  }
  if (unfoldEventId) {
    unfoldCurrentWorkWithinTransaction(db, {
      org_id: input.org_id, thread_id: input.thread_id, event_id: unfoldEventId,
      cause: "current_work_visibility_reconciled", dedupe_id: randomUUID(), now: input.updated_at,
    });
    const saved = db.prepare(`SELECT ${PREF_COLUMNS} FROM conversation_prefs
      WHERE org_id = ? AND thread_id = ?`).get(input.org_id, input.thread_id) as PrefRow | undefined;
    if (!saved || Boolean(saved.hidden)) throw new Error("Current-work visibility reconciliation lost its target");
    return { outcome: "applied", pref: toPref(db, saved) };
  }
  const pref = putConversationPrefUnlocked(db, {
    org_id: input.org_id,
    thread_id: input.thread_id,
    hidden: input.hidden,
    hidden_reason: input.hidden ? "policy" : null,
    updated_at: input.updated_at,
  });
  if (tombstoneId) {
    recordPolicyVisibilityChanged(db, {
      org_id: input.org_id, thread_id: input.thread_id, event_id: tombstoneId,
      visibility_version: currentVersion, hidden: true, cause: "tombstone_visibility_reconciled",
      dedupe_id: randomUUID(), now: input.updated_at,
    });
  } else {
    recordPolicyVisibilityChanged(db, {
      org_id: input.org_id, thread_id: input.thread_id, visibility_version: currentVersion,
      hidden: input.hidden, cause: "policy_visibility_applied", dedupe_id: randomUUID(), now: input.updated_at,
    });
  }
  return { outcome: "applied", pref };
}

/** Keep the list face in sync after ingest/disposition without a full-table scan. */
export function refreshThreadHeadWithinTransaction(db: Database.Database, orgId: string, threadId: string | null | undefined): void {
    const id = threadId?.trim();
    if (!id) {
      return;
    }
    const face = db
      .prepare(
        `
          SELECT e.id AS face_event_id, e.occurred_at AS face_occurred_at
          FROM message_dispositions d
          JOIN events e ON e.id = d.event_id
          WHERE e.org_id = ?
            AND e.thread_id = ?
            AND e.operation != 'tombstone'
            AND d.reason_codes_json NOT LIKE '%thread_status%'
          ORDER BY
            CASE WHEN ${isCurrentHeadSql("e")} THEN 0 ELSE 1 END,
            e.occurred_at DESC,
            e.id DESC
          LIMIT 1
        `,
      )
      .get(orgId, id) as
      | { face_event_id: string; face_occurred_at: string }
      | undefined;
    if (!face) {
      db
        .prepare(
          `DELETE FROM thread_heads WHERE org_id = ? AND thread_id = ?`,
        )
        .run(orgId, id);
      return;
    }
    const currentWork = db
      .prepare(
        `
          SELECT 1 AS ok
          FROM message_dispositions d2
          JOIN events e2 ON e2.id = d2.event_id
          WHERE e2.org_id = ?
            AND e2.thread_id = ?
            AND e2.operation <> 'tombstone'
            AND d2.disposition = 'current_work'
            AND ${isCurrentHeadSql("e2", "h2")}
          LIMIT 1
        `,
      )
      .get(orgId, id) as { ok: number } | undefined;
    db
      .prepare(
        `
          INSERT INTO thread_heads (
            org_id, thread_id, face_event_id, face_occurred_at, has_current_work
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(org_id, thread_id) DO UPDATE SET
            face_event_id = excluded.face_event_id,
            face_occurred_at = excluded.face_occurred_at,
            has_current_work = excluded.has_current_work
        `,
      )
      .run(
        orgId,
        id,
        face.face_event_id,
        face.face_occurred_at,
        currentWork ? 1 : 0,
      );
  }

function inboxSql(db: Database.Database, orgId: string, query?: InboxQuery): { sql: string; params: unknown[] } {
    const hiddenList = normalizeInboxListView(query?.list) === "hidden";
    const scoped = inboxScoped(query);
    if (query?.heads) {
      const inner = headsScanQuery(query);
      if (hiddenList) {
        return hiddenHeadsSql(db, orgId, query, inner);
      }
      const visible = inboxClauses(db, orgId, inner, "any");
      if (!scoped) {
        visible.clauses.push(notHiddenSql("e"));
        visible.params.push(orgId);
      }
      if (query?.needs_work) {
        const marks = WORK_OBSERVE_AGAIN_STATUSES.map(() => "?").join(", ");
        visible.clauses.push(`NOT EXISTS (
          SELECT 1 FROM work_items w
          WHERE w.org_id = th.org_id
            AND w.thread_id = th.thread_id
            AND w.unit_key = e.id
            AND w.status NOT IN (${marks})
        )`);
        visible.params.push(...WORK_OBSERVE_AGAIN_STATUSES);
      }
      const page = materialHeadsPageTail(query);
      return {
        sql: `
          SELECT ${INBOX_COLUMNS}
          FROM thread_heads th
          JOIN events e ON e.id = th.face_event_id
          JOIN message_dispositions d ON d.event_id = e.id
          WHERE th.has_current_work = 1
            AND ${visible.clauses.join(" AND ")}
          ${page.whereSql}
          ${page.orderSql}
        `,
        params: [...visible.params, ...page.params],
      };
    }
    if (query?.siblings) {
      const { clauses, params } = inboxClauses(db, orgId, query, "any");
      if (!scoped) {
        if (hiddenList) {
          const hidden = hiddenThreadIdSql(orgId);
          clauses.push(`e.thread_id IN (${hidden.sql})`);
          params.push(...hidden.params);
        } else {
          clauses.push(`e.thread_id IN (
          SELECT e2.thread_id
          FROM message_dispositions d2
          JOIN events e2 ON e2.id = d2.event_id
          WHERE d2.org_id = ? AND d2.disposition = 'current_work'
            AND e2.operation <> 'tombstone'
            AND ${isCurrentHeadSql("e2", "h2")}
        )`);
          params.push(orgId);
          clauses.push(notHiddenSql("e"));
          params.push(orgId);
        }
      }
      const tail = inboxTail(query);
      return {
        sql: `
          SELECT ${INBOX_COLUMNS}
          FROM message_dispositions d
          JOIN events e ON e.id = d.event_id
          WHERE ${clauses.join(" AND ")}
            AND ${isCurrentHeadSql("e")}
          ${tail.orderSql}
        `,
        params: [...params, ...tail.orderParams],
      };
    }
    if (hiddenList) {
      const { clauses, params } = inboxClauses(db, orgId, query, "any");
      if (!scoped) {
        const hidden = hiddenThreadIdSql(orgId);
        clauses.push(`e.thread_id IN (${hidden.sql})`);
        params.push(...hidden.params);
      }
      const tail = inboxTail(query);
      return {
        sql: `
          SELECT ${INBOX_COLUMNS}
          FROM message_dispositions d
          JOIN events e ON e.id = d.event_id
          WHERE ${clauses.join(" AND ")}
            AND ${isCurrentHeadSql("e")}
          ${tail.orderSql}
        `,
        params: [...params, ...tail.orderParams],
      };
    }
    const { clauses, params } = inboxClauses(
      db,
      orgId,
      query,
      query?.disposition ?? "current_work",
    );
    if (!scoped) {
      clauses.push(notHiddenSql("e"));
      params.push(orgId);
    }
    if (query?.tasks) {
      clauses.push(
        `EXISTS (SELECT 1 FROM json_each(d.reason_codes_json) WHERE value = ?)`,
      );
      params.push(TASK_INBOX_REASON);
    }
    if (query?.needs_work) {
      const marks = WORK_OBSERVE_AGAIN_STATUSES.map(() => "?").join(", ");
      clauses.push(`NOT EXISTS (
          SELECT 1 FROM work_items w
          WHERE w.org_id = e.org_id
            AND w.thread_id = e.thread_id
            AND w.unit_key = e.id
            AND w.status NOT IN (${marks})
        )`);
      params.push(...WORK_OBSERVE_AGAIN_STATUSES);
    }
    const tail = inboxTail(query);
    return {
      sql: `
        SELECT ${INBOX_COLUMNS}
        FROM message_dispositions d
        JOIN events e ON e.id = d.event_id
        WHERE ${clauses.join(" AND ")}
          AND ${isCurrentHeadSql("e")}
        ${tail.orderSql}
      `,
      params: [...params, ...tail.orderParams],
    };
  }

function hiddenHeadsSql(db: Database.Database, orgId: string, query?: InboxQuery, inner: InboxQuery | undefined = headsScanQuery(query)): { sql: string; params: unknown[] } {
    const visible = inboxClauses(db, orgId, inner, "any");
    const hidden = hiddenThreadIdSql(orgId);
    const page = materialHeadsPageTail(query);
    return {
      sql: `
        SELECT ${INBOX_COLUMNS}
        FROM thread_heads th
        JOIN events e ON e.id = th.face_event_id
        JOIN message_dispositions d ON d.event_id = e.id
        WHERE ${visible.clauses.join(" AND ")}
          AND e.thread_id IN (${hidden.sql})
        ${page.whereSql}
        ${page.orderSql}
      `,
      params: [...visible.params, ...hidden.params, ...page.params],
    };
  }

function inboxClauses(db: Database.Database, orgId: string, query: InboxQuery | undefined, disposition: "current_work" | "pending" | "any", tables: { event?: string; disposition?: string } = {}): { clauses: string[]; params: unknown[] } {
    const event = tables.event ?? "e";
    const decision = tables.disposition ?? "d";
    const clauses = [`${event}.org_id = ?`];
    const params: unknown[] = [orgId];
    if (disposition !== "any") {
      clauses.push(`${decision}.disposition = ?`);
      params.push(disposition);
      if (disposition === "current_work") {
        clauses.push(`${event}.operation <> 'tombstone'`);
      }
    }
    if (query?.source) {
      clauses.push(`${event}.source = ?`);
      params.push(query.source);
    }
    if (query?.target) {
      clauses.push(
        `(${event}.external_id = ? OR ${event}.external_id LIKE ? ESCAPE '\\')`,
      );
      params.push(query.target, threadExternalIdLike(query.target));
    }
    if (query?.thread_ids && query.thread_ids.length > 0) {
      clauses.push(
        `${event}.thread_id IN (${query.thread_ids.map(() => "?").join(", ")})`,
      );
      params.push(...query.thread_ids);
    }
    if (query?.since) {
      clauses.push(
        `(${event}.ingested_at > ? OR (${event}.ingested_at = ? AND ${event}.id > ?))`,
      );
      params.push(query.since, query.since, query.since_id ?? "");
    }
    if (query?.before) {
      clauses.push(
        `(${event}.occurred_at < ? OR (${event}.occurred_at = ? AND ${event}.id < ?))`,
      );
      params.push(query.before, query.before, query.before_id ?? "");
    }
    return { clauses, params };
  }

function toInboxItem(db: Database.Database, row: InboxRow): InboxItem {
    return {
      decision: toDisposition(db, {
        event_id: row.event_id,
        org_id: row.disposition_org_id,
        version: row.version,
        disposition: row.disposition,
        layer: row.layer,
        reason_codes_json: row.reason_codes_json,
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
        required_scope_ids_json: row.required_scope_ids_json,
        direction_tags_json: row.direction_tags_json,
        weight_hints_json: row.weight_hints_json,
        attrs_json: row.attrs_json,
        occurred_at: row.occurred_at,
        ingested_at: row.ingested_at,
      }),
    };
  }

function toPref(db: Database.Database, row: PrefRow): ConversationPref {
    const hidden = row.hidden === 1;
    return {
      org_id: row.org_id,
      thread_id: row.thread_id,
      title: row.title,
      pinned: row.pinned === 1,
      hidden,
      hidden_reason: hidden ? normalizeHiddenReason(row.hidden_reason) : null,
      visibility_version: row.visibility_version,
      last_read_at: row.last_read_at,
      last_read_external_id: row.last_read_external_id,
      updated_at: row.updated_at,
    };
  }

function toDisposition(db: Database.Database, row: DispositionRow): ArrangementDecision {
    return {
      event_id: row.event_id,
      org_id: row.org_id,
      version: row.version,
      disposition: row.disposition,
      layer: row.layer,
      reason_codes: JSON.parse(row.reason_codes_json) as string[],
      score: row.score,
      decided_at: row.decided_at,
    };
  }

function inboxUsesNewestFirst(query?: InboxQuery): boolean {
  return Boolean(normalizeInboxLimit(query?.limit));
}

function headsPageTail(query?: InboxQuery): {
  whereSql: string;
  orderSql: string;
  params: unknown[];
} {
  const params: unknown[] = [];
  let whereSql = "WHERE rn = 1";
  if (query?.before) {
    whereSql +=
      " AND (occurred_at < ? OR (occurred_at = ? AND id < ?))";
    params.push(query.before, query.before, query.before_id ?? "");
  }
  const limit = normalizeInboxLimit(query?.limit);
  if (limit !== undefined) {
    return {
      whereSql,
      orderSql: "ORDER BY occurred_at DESC, id DESC LIMIT ?",
      params: [...params, limit],
    };
  }
  return {
    whereSql,
    orderSql: "ORDER BY occurred_at ASC, id ASC",
    params,
  };
}

/** Page materialized thread faces without a ROW_NUMBER window. */
function materialHeadsPageTail(query?: InboxQuery): {
  whereSql: string;
  orderSql: string;
  params: unknown[];
} {
  const params: unknown[] = [];
  let whereSql = "";
  if (query?.before) {
    whereSql =
      "AND (e.occurred_at < ? OR (e.occurred_at = ? AND e.id < ?))";
    params.push(query.before, query.before, query.before_id ?? "");
  }
  const limit = normalizeInboxLimit(query?.limit);
  if (limit !== undefined) {
    return {
      whereSql,
      orderSql: "ORDER BY e.occurred_at DESC, e.id DESC LIMIT ?",
      params: [...params, limit],
    };
  }
  return {
    whereSql,
    orderSql: "ORDER BY e.occurred_at ASC, e.id ASC",
    params,
  };
}

function isCurrentHeadSql(event = "e", heads = "h"): string {
  return `EXISTS (
    SELECT 1 FROM source_heads ${heads}
    WHERE ${heads}.current_event_id = ${event}.id
  )`;
}

function hiddenThreadIdSql(orgId: string): { sql: string; params: unknown[] } {
  return {
    sql: `SELECT thread_id FROM conversation_prefs WHERE org_id = ? AND hidden = 1`,
    params: [orgId],
  };
}

function notHiddenSql(event = "e"): string {
  return `${event}.thread_id NOT IN (SELECT p.thread_id FROM conversation_prefs p WHERE p.org_id = ? AND p.hidden = 1)`;
}

function inboxScoped(query?: InboxQuery): boolean {
  return Boolean(query?.source || query?.target || query?.thread_ids);
}

function inboxTail(query?: InboxQuery): {
  orderSql: string;
  orderParams: unknown[];
} {
  const limit = query?.heads ? undefined : normalizeInboxLimit(query?.limit);
  if (limit !== undefined) {
    return {
      orderSql: "ORDER BY e.occurred_at DESC, e.id DESC LIMIT ?",
      orderParams: [limit],
    };
  }
  return {
    orderSql: "ORDER BY e.occurred_at ASC, e.id ASC",
    orderParams: [],
  };
}
