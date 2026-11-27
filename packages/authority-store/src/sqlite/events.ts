import type {
  ArrangementDecision,
  IngestOperation,
  SourceIdentity,
  NewEvent,
  EventRecord,
  SourceIdentityAliasBind,
  OutboundAttemptRecord,
  OutboundAttemptPut,
  NewOutboundAttempt,
  EventListQuery,
  ContextAuthorityRead,
  ContextAuthorityReadQuery,
  ContextEventPage,
  ContextEventPageQuery,
  BlobReservation,
  BlobRecord,
  BlobInventoryRecord,
  BlobInventoryPage,
  BlobInventoryPageQuery,
  EventAttachmentReferenceBackfill,
  RepointContentInput,
  ReserveBlobWritesInput,
  IngestCommitRequest,
  EventRevision,
  TombstoneEvent,
} from "@regenic/domain";
import Database from "better-sqlite3";
import {
  threadExternalIdLike,
  hashCanonicalContext,
  conversationId,
  assertBlobInventoryPageQuery,
  AuthorityConflictError,
  BlobReservationConflictError,
  assertEventDispositionBinding,
  assertIngestDispositionBindings,
} from "@regenic/domain";
import {
  randomUUID,
} from "node:crypto";
import {
  putDispositionWithinTransaction,
  refreshThreadHeadWithinTransaction,
  unfoldCurrentWorkWithinTransaction,
} from "./inbox";
import { contextReadScope } from "../context-read-scope";

export interface EventRow {
  id: string;
  org_id: string;
  source: string;
  external_id: string;
  operation: IngestOperation;
  content_hash: string | null;
  parent_event_id: string | null;
  thread_id: string | null;
  actor_id: string | null;
  required_scope_ids_json: string | null;
  direction_tags_json?: string | null;
  weight_hints_json?: string | null;
  attrs_json?: string | null;
  occurred_at: string;
  ingested_at: string;
}

interface ContextEventRow extends EventRow {
  content_media_type: string | null;
}

interface BlobRow {
  content_hash: string;
  media_type: string;
  byte_size: number;
  created_at: string;
}

interface BlobInventoryRow extends BlobRow {
  state: BlobInventoryRecord["state"];
  generation: number;
  unreferenced_at: string | null;
  write_lease_expires_at: string | null;
  reference_count: number;
}

interface InsertEventInput extends SourceIdentity {
  id?: string;
  operation: IngestOperation;
  content_hash?: string;
  content_media_type?: string;
  content_byte_size?: number;
  extra_blobs?: NewEvent["extra_blobs"];
  parent_event_id?: string;
  revision_id?: string;
  thread_id?: string;
  actor_id?: string;
  required_scope_ids?: string[];
  direction_tags?: string[];
  weight_hints?: NewEvent["weight_hints"];
  attrs?: NewEvent["attrs"];
  occurred_at: string;
  expected_head_id: string | null;
}

export async function findBySourceIdentity(db: Database.Database, identity: SourceIdentity): Promise<EventRecord | null> {
    return findCurrent(db, identity);
  }

export async function bindSourceIdentityAliases(db: Database.Database, input: SourceIdentityAliasBind): Promise<void> {
    const insert = db.prepare(
      `
        INSERT OR IGNORE INTO source_heads (
          org_id, source, external_id, current_event_id
        ) VALUES (?, ?, ?, ?)
      `,
    );
    const run = db.transaction(() => {
      if (!db.prepare("SELECT 1 FROM events WHERE org_id = ? AND id = ?").get(input.org_id, input.event_id)) {
        throw new Error(`Unknown event for identity alias: ${input.event_id}`);
      }
      const isCurrent = Boolean(db.prepare(
        "SELECT 1 FROM source_heads WHERE org_id = ? AND current_event_id = ? LIMIT 1",
      ).get(input.org_id, input.event_id));
      const findAlias = db.prepare(
        "SELECT 1 FROM source_heads WHERE org_id = ? AND source = ? AND external_id = ?",
      );
      for (const alias of input.aliases) {
        const externalId = alias.external_id.trim();
        if (!alias.source.trim() || !externalId) {
          continue;
        }
        if (!isCurrent && !findAlias.get(input.org_id, alias.source, externalId)) {
          throw new AuthorityConflictError();
        }
        insert.run(input.org_id, alias.source, externalId, input.event_id);
      }
    });
    run.immediate();
  }

export async function getOutboundAttempt(db: Database.Database, orgId: string, clientRequestId: string): Promise<OutboundAttemptRecord | null> {
    return getOutboundAttemptSync(db, orgId, clientRequestId);
  }

export async function claimOutboundAttempt(db: Database.Database, input: NewOutboundAttempt): Promise<boolean> {
  return db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO outbound_attempts (
        org_id, client_request_id, thread_id, status, recovery_hash, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(org_id, client_request_id) DO UPDATE SET
        status = 'pending',
        recovery_hash = excluded.recovery_hash,
        updated_at = excluded.updated_at
      WHERE outbound_attempts.status = 'rejected'
        AND outbound_attempts.thread_id = excluded.thread_id
        AND outbound_attempts.event_id IS NULL
        AND outbound_attempts.receipt_json IS NULL
        AND outbound_attempts.channel_message_ids_json IS NULL
    `).run(
      input.org_id, input.client_request_id, input.thread_id,
      input.recovery_hash ?? null, input.now, input.now,
    );
    if (result.changes !== 1) return false;
    syncOutboundRecoveryBlobReference(db, input);
    return true;
  }).immediate();
}

export async function putOutboundAttempt(db: Database.Database, input: OutboundAttemptPut): Promise<OutboundAttemptRecord> {
  return db.transaction(() => {
    const previous = getOutboundAttemptSync(db, input.org_id, input.client_request_id);
    const createdAt = previous?.created_at ?? input.now;
    db
      .prepare(
        `
          INSERT INTO outbound_attempts (
            org_id, client_request_id, thread_id, event_id, status,
            channel_message_ids_json, recovery_hash, receipt_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(org_id, client_request_id) DO UPDATE SET
            thread_id = excluded.thread_id,
            event_id = excluded.event_id,
            status = excluded.status,
            channel_message_ids_json = excluded.channel_message_ids_json,
            recovery_hash = COALESCE(excluded.recovery_hash, outbound_attempts.recovery_hash),
            receipt_json = COALESCE(excluded.receipt_json, outbound_attempts.receipt_json),
            updated_at = excluded.updated_at
        `,
      )
      .run(
        input.org_id,
        input.client_request_id,
        input.thread_id,
        input.event_id ?? null,
        input.status,
        input.channel_message_ids
          ? JSON.stringify(input.channel_message_ids)
          : null,
        input.recovery_hash ?? null,
        input.receipt ? JSON.stringify(input.receipt) : null,
        createdAt,
        input.now,
      );
    syncOutboundRecoveryBlobReference(db, {
      ...input,
      recovery_hash: input.recovery_hash ?? previous?.recovery_hash,
    });
    return {
      org_id: input.org_id,
      client_request_id: input.client_request_id,
      thread_id: input.thread_id,
      ...(input.event_id ? { event_id: input.event_id } : {}),
      status: input.status,
      recovery_hash: input.recovery_hash ?? previous?.recovery_hash,
      receipt: input.receipt ?? previous?.receipt,
      ...(input.channel_message_ids
        ? { channel_message_ids: [...input.channel_message_ids] }
        : {}),
      created_at: createdAt,
      updated_at: input.now,
    };
  }).immediate();
}

function getOutboundAttemptSync(
  db: Database.Database,
  orgId: string,
  clientRequestId: string,
): OutboundAttemptRecord | null {
  const row = db.prepare(`
    SELECT org_id, client_request_id, thread_id, event_id, status,
           channel_message_ids_json, recovery_hash, receipt_json, created_at, updated_at
    FROM outbound_attempts WHERE org_id = ? AND client_request_id = ?
  `).get(orgId, clientRequestId) as {
    org_id: string;
    client_request_id: string;
    thread_id: string;
    event_id: string | null;
    status: OutboundAttemptRecord["status"];
    channel_message_ids_json: string | null;
    recovery_hash: string | null;
    receipt_json: string | null;
    created_at: string;
    updated_at: string;
  } | undefined;
  return row ? {
    org_id: row.org_id,
    client_request_id: row.client_request_id,
    thread_id: row.thread_id,
    ...(row.event_id ? { event_id: row.event_id } : {}),
    status: row.status,
    ...(row.recovery_hash ? { recovery_hash: row.recovery_hash } : {}),
    ...(row.receipt_json
      ? { receipt: JSON.parse(row.receipt_json) as OutboundAttemptRecord["receipt"] }
      : {}),
    ...(row.channel_message_ids_json
      ? { channel_message_ids: JSON.parse(row.channel_message_ids_json) as string[] }
      : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  } : null;
}

function syncOutboundRecoveryBlobReference(
  db: Database.Database,
  input: NewOutboundAttempt | OutboundAttemptPut,
): void {
  const expected = new Set(input.recovery_hash ? [input.recovery_hash] : []);
  const reservations = input.blob_reservations;
  const oldHashes = db.prepare(`
    SELECT content_hash FROM blob_references
    WHERE owner_org_id = ? AND owner_type = 'outbound_attempt'
      AND owner_id = ? AND reference_kind = 'reply_recovery'
  `).all(input.org_id, input.client_request_id) as Array<{ content_hash: string }>;
  if (reservations !== undefined) {
    const hashes = new Set(reservations.map((reservation) => reservation.content_hash));
    if (hashes.size !== reservations.length || hashes.size !== expected.size
      || [...expected].some((hash) => !hashes.has(hash))) {
      throw new Error("Outbound recovery reservations must exactly match the stored recovery hash");
    }
    completeBlobReservations(db, reservations, expected);
  } else if (input.recovery_hash && !oldHashes.some((row) => row.content_hash === input.recovery_hash)) {
    insertBlobRow(
      db,
      input.recovery_hash,
      "application/vnd.regenic.reply-recovery+json",
      0,
      input.now,
    );
    const protectedBlob = db.prepare(`
      UPDATE blobs SET state = 'protected', unreferenced_at = NULL
      WHERE content_hash = ? AND state IN ('available', 'protected') AND write_claim_token IS NULL
    `).run(input.recovery_hash);
    if (protectedBlob.changes !== 1) {
      throw new BlobReservationConflictError(input.recovery_hash);
    }
  }

  db.prepare(`
    DELETE FROM blob_references WHERE owner_org_id = ? AND owner_type = 'outbound_attempt'
      AND owner_id = ? AND reference_kind = 'reply_recovery'
  `).run(input.org_id, input.client_request_id);
  if (input.recovery_hash) {
    const eligible = db.prepare(`
      UPDATE blobs SET unreferenced_at = NULL
      WHERE content_hash = ? AND state IN ('available', 'protected') AND write_claim_token IS NULL
    `).run(input.recovery_hash);
    if (eligible.changes !== 1) {
      throw new BlobReservationConflictError(input.recovery_hash);
    }
    db.prepare(`
      INSERT INTO blob_references (
        owner_org_id, owner_type, owner_id, reference_kind, content_hash, created_at
      ) VALUES (?, 'outbound_attempt', ?, 'reply_recovery', ?, ?)
    `).run(input.org_id, input.client_request_id, input.recovery_hash, input.now);
  }
  const markUnreferenced = db.prepare(`
    UPDATE blobs SET unreferenced_at = ?
    WHERE content_hash = ? AND NOT EXISTS (
      SELECT 1 FROM blob_references r WHERE r.content_hash = blobs.content_hash
    )
  `);
  for (const { content_hash } of oldHashes) {
    if (content_hash !== input.recovery_hash) markUnreferenced.run(input.now, content_hash);
  }
}

export async function getEvent(db: Database.Database, orgId: string, eventId: string): Promise<EventRecord | null> {
    const row = db
      .prepare(
        `
          SELECT id, org_id, source, external_id, operation, content_hash,
               parent_event_id, thread_id, actor_id, required_scope_ids_json,
               direction_tags_json, weight_hints_json, attrs_json,
               occurred_at, ingested_at
          FROM events WHERE org_id = ? AND id = ?
        `,
      )
      .get(orgId, eventId) as EventRow | undefined;
    return row ? toEvent(db, row) : null;
  }

export async function listEvents(db: Database.Database, orgId: string, query?: EventListQuery): Promise<EventRecord[]> {
    const clauses = ["org_id = ?"];
    const params: unknown[] = [orgId];
    if (query?.source) {
      clauses.push("source = ?");
      params.push(query.source);
    }
    if (query?.target) {
      clauses.push("(external_id = ? OR external_id LIKE ? ESCAPE '\\')");
      params.push(query.target, threadExternalIdLike(query.target));
    }
    if (query?.thread_ids) {
      if (query.thread_ids.length === 0) {
        return [];
      }
      clauses.push(
        `thread_id IN (${query.thread_ids.map(() => "?").join(", ")})`,
      );
      params.push(...query.thread_ids);
    }
    if (query?.since) {
      clauses.push("(ingested_at > ? OR (ingested_at = ? AND id > ?))");
      params.push(query.since, query.since, query.since_id ?? "");
    }
    if (query?.occurred_since) {
      clauses.push("occurred_at >= ?");
      params.push(query.occurred_since);
    }
    const limit =
      typeof query?.limit === "number" &&
      Number.isInteger(query.limit) &&
      query.limit > 0
        ? query.limit
        : undefined;
    const order = query?.order === "recent" ? "DESC" : "ASC";
    const orderBy = query?.order === "ingested"
      ? "ingested_at ASC, id ASC"
      : `sequence ${order}`;
    const rows = db
      .prepare(
        `
          SELECT id, org_id, source, external_id, operation, content_hash,
               parent_event_id, thread_id, actor_id, required_scope_ids_json,
               direction_tags_json, weight_hints_json, attrs_json,
               occurred_at, ingested_at
          FROM events WHERE ${clauses.join(" AND ")} ORDER BY ${orderBy}
          ${limit === undefined ? "" : "LIMIT ?"}
        `,
      )
      .all(...(limit === undefined ? params : [...params, limit])) as EventRow[];
    return rows.map((row) => toEvent(db, row));
  }

export async function openContextRead(db: Database.Database, orgId: string, query?: ContextAuthorityReadQuery): Promise<ContextAuthorityRead> {
    return openContextReadInternal(db, orgId, query);
  }

export async function openContextReadEpoch(
  db: Database.Database,
  orgId: string,
  query?: ContextAuthorityReadQuery,
): Promise<string> {
  const read = db.transaction(() => {
    const boundary = readAuthorityBoundary(db, orgId, query);
    return authorityReadEpoch(orgId, boundary.events, boundary.lifecycleHeads);
  });
  return read.deferred();
}

export function contextMutationStamp(db: Database.Database): string {
  // data_version moves when another connection commits. total_changes moves
  // when this connection commits. Either one means the cached read is stale.
  const dataVersion = db.pragma("data_version", { simple: true });
  const changes = db.prepare("SELECT total_changes() AS n").get() as { n: number };
  return `${dataVersion}:${changes.n}`;
}

export function readCurrentHeadsByIds(
  db: Database.Database,
  orgId: string,
  eventIds: string[],
): ContextAuthorityRead["events"] {
  const ids = [...new Set(eventIds.filter((id) => id.trim()))];
  if (!orgId.trim() || ids.length === 0) return [];
  const rows = db.prepare(`
    SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
      e.content_hash, e.parent_event_id, e.thread_id, e.actor_id,
      e.required_scope_ids_json, e.direction_tags_json, e.weight_hints_json, e.attrs_json,
      e.occurred_at, e.ingested_at,
      b.media_type AS content_media_type
    FROM source_heads h
    JOIN events e ON e.id = h.current_event_id AND e.org_id = h.org_id
    LEFT JOIN blobs b ON b.content_hash = e.content_hash
    WHERE e.org_id = ? AND e.id IN (SELECT value FROM json_each(?))
  `).all(orgId, JSON.stringify(ids)) as ContextEventRow[];
  return rows.map((row) => ({
    ...toEvent(db, row),
    ...(row.content_media_type ? { content_media_type: row.content_media_type } : {}),
  }));
}

export async function openContextReadForThread(db: Database.Database, orgId: string, threadId: string): Promise<ContextAuthorityRead> {
    const scopedThreadId = threadId.trim();
    if (!scopedThreadId) {
      throw new Error("Context thread read requires a thread id");
    }
    return openContextReadInternal(db, orgId, { filters: { thread_ids: [scopedThreadId] } });
  }

export async function openContextEventPage(
  db: Database.Database,
  orgId: string,
  query: ContextEventPageQuery,
): Promise<ContextEventPage> {
  assertEventPage(orgId, query);
  const after = query.after_event_id?.trim() || null;
  const read = db.transaction(() => {
    const afterSequence = after
      ? (db.prepare(
        `SELECT sequence FROM events WHERE org_id = ? AND id = ?`,
      ).get(orgId, after) as { sequence: number } | undefined)?.sequence
      : undefined;
    const rows = db.prepare(
      `
        SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
          e.content_hash, e.parent_event_id, e.thread_id, e.actor_id,
          e.required_scope_ids_json, e.direction_tags_json, e.weight_hints_json, e.attrs_json,
          e.occurred_at, e.ingested_at,
          b.media_type AS content_media_type
        FROM events e
        LEFT JOIN blobs b ON b.content_hash = e.content_hash
        WHERE e.org_id = ? AND e.sequence > ?
        ORDER BY e.sequence ASC, e.id ASC
        LIMIT ?
      `,
    ).all(orgId, afterSequence ?? -1, query.limit + 1) as ContextEventRow[];
    const done = rows.length <= query.limit;
    return {
      events: rows.slice(0, query.limit).map((row) => ({
        ...toEvent(db, row),
        ...(row.content_media_type ? { content_media_type: row.content_media_type } : {}),
      })),
      done,
    };
  });
  return read.deferred();
}

function assertEventPage(orgId: string, query: ContextEventPageQuery): void {
  if (!orgId.trim()) {
    throw new Error("Context event page organization is required");
  }
  if (!Number.isInteger(query?.limit) || query.limit < 1 || query.limit > 1_000) {
    throw new Error("Context event page limit is invalid");
  }
}

function authorityReadEpoch(
  orgId: string,
  events: ContextAuthorityRead["events"],
  lifecycleHeads: ContextAuthorityRead["lifecycle_heads"],
): string {
  return `authority:${hashCanonicalContext({
    org_id: orgId,
    events,
    lifecycle_heads: lifecycleHeads,
  })}`;
}

function readAuthorityBoundary(
  db: Database.Database,
  orgId: string,
  query: ContextAuthorityReadQuery | undefined,
): {
  recordedAt: string;
  events: ContextAuthorityRead["events"];
  lifecycleHeads: ContextAuthorityRead["lifecycle_heads"];
} {
  const scope = contextReadScope(orgId, query, "sqlite");
  const rows = db
    .prepare(
      `${scope.sql}
           SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
             e.content_hash, e.parent_event_id, e.thread_id, e.actor_id,
             e.required_scope_ids_json, e.direction_tags_json, e.weight_hints_json, e.attrs_json,
             e.occurred_at, e.ingested_at,
             b.media_type AS content_media_type
           FROM events e
           JOIN selected_identities s
             ON s.org_id = e.org_id AND s.source = e.source AND s.external_id = e.external_id
           LEFT JOIN blobs b ON b.content_hash = e.content_hash
           ORDER BY e.sequence ASC
    `,
    )
    .all(...scope.params) as ContextEventRow[];
  const lifecycleHeads = db
    .prepare(
      `${scope.sql}
            SELECT sh.source, sh.external_id, sh.current_event_id AS head_event_id
            FROM source_heads sh
            JOIN selected_identities s
              ON s.org_id = sh.org_id AND s.source = sh.source AND s.external_id = sh.external_id
            ORDER BY sh.source ASC, sh.external_id ASC
          `,
    )
    .all(...scope.params) as ContextAuthorityRead["lifecycle_heads"];
  return {
    recordedAt: new Date().toISOString(),
    events: rows.map((row) => ({
      ...toEvent(db, row),
      ...(row.content_media_type
        ? { content_media_type: row.content_media_type }
        : {}),
    })),
    lifecycleHeads,
  };
}

async function openContextReadInternal(db: Database.Database, orgId: string, query?: ContextAuthorityReadQuery): Promise<ContextAuthorityRead> {
    const read = db.transaction(() => {
      const boundary = readAuthorityBoundary(db, orgId, query);
      return {
        read_epoch: authorityReadEpoch(orgId, boundary.events, boundary.lifecycleHeads),
        recorded_at: boundary.recordedAt,
        events: boundary.events,
        lifecycle_heads: boundary.lifecycleHeads,
      } satisfies ContextAuthorityRead;
    });
    return read.deferred();
  }

export async function findBlob(db: Database.Database, contentHash: string): Promise<BlobRecord | null> {
    return (await findBlobs(db, [contentHash])).get(contentHash) ?? null;
  }

export async function findBlobs(db: Database.Database, contentHashes: readonly string[]): Promise<Map<string, BlobRecord>> {
    const unique = [
      ...new Set(contentHashes.filter((hash) => hash.length > 0)),
    ];
    const found = new Map<string, BlobRecord>();
    const chunkSize = 400;
    for (let offset = 0; offset < unique.length; offset += chunkSize) {
      const chunk = unique.slice(offset, offset + chunkSize);
      const rows = db
        .prepare(
          `SELECT content_hash, media_type, byte_size, created_at
           FROM blobs WHERE content_hash IN (${chunk.map(() => "?").join(", ")})`,
        )
        .all(...chunk) as BlobRow[];
      for (const row of rows) {
        found.set(row.content_hash, row);
      }
    }
    return found;
  }

  export function inspectBlobInventory(
    db: Database.Database,
    contentHashes: readonly string[],
  ): Map<string, BlobInventoryRecord> {
    const unique = [...new Set(contentHashes.filter((hash) => hash.length > 0))];
    const found = new Map<string, BlobInventoryRecord>();
    const chunkSize = 400;
    for (let offset = 0; offset < unique.length; offset += chunkSize) {
      const chunk = unique.slice(offset, offset + chunkSize);
      const rows = db.prepare(`
        SELECT b.content_hash, b.media_type, b.byte_size, b.created_at, b.state,
               b.generation, b.unreferenced_at, b.write_lease_expires_at,
               COUNT(r.content_hash) AS reference_count
        FROM blobs b
        LEFT JOIN blob_references r ON r.content_hash = b.content_hash
        WHERE b.content_hash IN (${chunk.map(() => "?").join(", ")})
        GROUP BY b.content_hash
      `).all(...chunk) as BlobInventoryRow[];
      for (const row of rows) {
        found.set(row.content_hash, {
          content_hash: row.content_hash,
          media_type: row.media_type,
          byte_size: row.byte_size,
          created_at: row.created_at,
          state: row.state,
          generation: row.generation,
          unreferenced_at: row.unreferenced_at,
          write_lease_expires_at: row.write_lease_expires_at,
          reference_count: row.reference_count,
        });
      }
    }
    return found;
  }

  export function listBlobInventoryPage(
    db: Database.Database,
    query: BlobInventoryPageQuery,
  ): BlobInventoryPage {
    assertBlobInventoryPageQuery(query);
    const rows = db.prepare(`
      SELECT b.content_hash, b.media_type, b.byte_size, b.created_at, b.state,
             b.generation, b.unreferenced_at, b.write_lease_expires_at,
             COUNT(r.content_hash) AS reference_count
      FROM blobs b
      LEFT JOIN blob_references r ON r.content_hash = b.content_hash
      WHERE (? IS NULL OR b.content_hash > ?)
      GROUP BY b.content_hash
      ORDER BY b.content_hash
      LIMIT ?
    `).all(query.after_hash ?? null, query.after_hash ?? null, query.limit + 1) as BlobInventoryRow[];
    const hasMore = rows.length > query.limit;
    const entries = rows.slice(0, query.limit).map((row) => ({
      content_hash: row.content_hash,
      media_type: row.media_type,
      byte_size: row.byte_size,
      created_at: row.created_at,
      state: row.state,
      generation: row.generation,
      unreferenced_at: row.unreferenced_at,
      write_lease_expires_at: row.write_lease_expires_at,
      reference_count: row.reference_count,
    }));
    return {
      entries,
      next_after_hash: hasMore ? entries.at(-1)?.content_hash ?? null : null,
    };
  }

export function backfillEventAttachmentReferences(
  db: Database.Database,
  input: EventAttachmentReferenceBackfill,
): void {
  if (!/^[a-f0-9]{64}$/.test(input.expected_content_hash) ||
    input.attachment_hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("Invalid Event attachment reference hash");
  }
  db.transaction(() => {
    const event = db.prepare(
      `SELECT content_hash, ingested_at FROM events WHERE org_id = ? AND id = ?`,
    ).get(input.org_id, input.event_id) as
      | { content_hash: string | null; ingested_at: string }
      | undefined;
    if (!event || event.content_hash !== input.expected_content_hash) {
      throw new Error("Event changed during attachment reference backfill");
    }
    for (const hash of [...new Set(input.attachment_hashes)].sort()) {
      insertBlobRow(db, hash, "application/octet-stream", 0, event.ingested_at);
      const protectedBlob = db.prepare(
        `UPDATE blobs SET state = 'protected', unreferenced_at = NULL,
           gc_claim_token = NULL, gc_started_at = NULL
         WHERE content_hash = ? AND state IN ('available', 'protected')
           AND write_claim_token IS NULL`,
      ).run(hash);
      if (protectedBlob.changes !== 1) throw new BlobReservationConflictError(hash);
      insertBlobReference(db, input.org_id, input.event_id, "attachment", hash, event.ingested_at);
    }
  }).immediate();
}

export async function append(db: Database.Database, input: NewEvent): Promise<EventRecord> {
    
    return insert(db, { ...input, operation: "create" });
  }

export async function repointContentHash(db: Database.Database, input: RepointContentInput): Promise<number> {
    
    return db.transaction(() => {
      const now = new Date().toISOString();
      const affectedEvents = db.prepare(
        `SELECT id, org_id FROM events WHERE content_hash = ? ORDER BY sequence`,
      ).all(input.old_content_hash) as Array<{ id: string; org_id: string }>;
      if (affectedEvents.length === 0) return 0;
      insertBlobRow(db, 
        input.new_content_hash,
        input.content_media_type,
        input.content_byte_size,
        now,
      );
      for (const blob of input.extra_blobs ?? []) {
        insertBlobRow(db, 
          blob.content_hash,
          blob.media_type,
          blob.byte_size,
          now,
        );
      }
      const updated = db
        .prepare(`UPDATE events SET content_hash = ? WHERE content_hash = ?`)
        .run(input.new_content_hash, input.old_content_hash);
      if (updated.changes > 0) {
        const referencedHashes = new Set([
          input.new_content_hash,
          ...(input.extra_blobs ?? []).map((blob) => blob.content_hash),
        ]);
        if (input.blob_reservations) {
          assertCompleteRepointReservations(referencedHashes, input.blob_reservations);
          completeBlobReservations(db, input.blob_reservations, referencedHashes);
        } else {
          protectRepointBlobs(db, referencedHashes);
        }
        const eventIds = affectedEvents.map((event) => event.id);
        const placeholders = eventIds.map(() => "?").join(", ");
        db.prepare(
          `DELETE FROM blob_references
           WHERE owner_type = 'event' AND owner_id IN (${placeholders})`,
        ).run(...eventIds);
        for (const event of affectedEvents) {
          insertBlobReference(
            db,
            event.org_id,
            event.id,
            "body",
            input.new_content_hash,
            now,
          );
          for (const blob of input.extra_blobs ?? []) {
            insertBlobReference(
              db,
              event.org_id,
              event.id,
              "attachment",
              blob.content_hash,
              now,
            );
          }
        }
      }
      for (const event of affectedEvents) {
        enqueueContextProjection(db, event.id, event.org_id, now);
      }
      if (input.old_content_hash !== input.new_content_hash) {
        db
          .prepare(
            `
              UPDATE blobs SET unreferenced_at = ?
              WHERE content_hash = ?
                AND NOT EXISTS (
                  SELECT 1 FROM blob_references r
                  WHERE r.content_hash = blobs.content_hash
                )
            `,
          )
          .run(now, input.old_content_hash);
      }
      return updated.changes;
    }).immediate();
  }

function assertCompleteRepointReservations(
  referencedHashes: ReadonlySet<string>,
  reservations: readonly BlobReservation[],
): void {
  const hashes = new Set(reservations.map((reservation) => reservation.content_hash));
  if (hashes.size !== reservations.length || hashes.size !== referencedHashes.size
    || [...referencedHashes].some((hash) => !hashes.has(hash))) {
    throw new Error("Content repoint reservations must exactly match its Blob references");
  }
}

function protectRepointBlobs(db: Database.Database, referencedHashes: ReadonlySet<string>): void {
  const protect = db.prepare(`
    UPDATE blobs SET state = 'protected', unreferenced_at = NULL
    WHERE content_hash = ? AND state IN ('available', 'protected') AND write_claim_token IS NULL
  `);
  for (const hash of referencedHashes) {
    if (protect.run(hash).changes !== 1) {
      throw new BlobReservationConflictError(hash);
    }
  }
}

export function reserveBlobWrites(
    db: Database.Database,
    input: ReserveBlobWritesInput,
): BlobReservation[] {
    const blobs = [...new Map(input.blobs.map((blob) => [blob.content_hash, blob])).values()]
      .sort((left, right) => left.content_hash.localeCompare(right.content_hash));
    const forceWrite = new Set(input.force_write_hashes ?? []);
    if (!input.owner_id.trim() ||
      !Number.isSafeInteger(input.lease_duration_ms) ||
      input.lease_duration_ms < 1 ||
      blobs.some((blob) =>
        !/^[a-f0-9]{64}$/.test(blob.content_hash) ||
        !blob.media_type.trim() ||
        !Number.isSafeInteger(blob.byte_size) ||
        blob.byte_size < 0) ||
      [...forceWrite].some((hash) => !blobs.some((blob) => blob.content_hash === hash))) {
      throw new Error("Invalid Blob reservation request");
    }

    return db.transaction(() => {
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + input.lease_duration_ms).toISOString();
      const select = db.prepare(`
        SELECT state, generation, write_claim_token, write_lease_expires_at
        FROM blobs WHERE content_hash = ?
      `);
      const insert = db.prepare(`
        INSERT INTO blobs (
          content_hash, media_type, byte_size, created_at, state, generation,
          write_lease_owner, write_claim_token, write_lease_expires_at, unreferenced_at
        ) VALUES (?, ?, ?, ?, 'reserved', 1, ?, ?, ?, ?)
      `);
      const update = db.prepare(`
        UPDATE blobs SET state = ?, generation = ?, write_lease_owner = ?,
          write_claim_token = ?, write_lease_expires_at = ?, unreferenced_at = ?
        WHERE content_hash = ?
      `);
      const clearExpiredLease = db.prepare(`
        UPDATE blobs SET write_lease_owner = NULL, write_claim_token = NULL,
          write_lease_expires_at = NULL
        WHERE content_hash = ? AND write_claim_token IS NOT NULL
      `);
      const plans: BlobReservation[] = [];

      for (const blob of blobs) {
        const current = select.get(blob.content_hash) as {
          state: "reserved" | "available" | "deleting" | "protected";
          generation: number;
          write_claim_token: string | null;
          write_lease_expires_at: string | null;
        } | undefined;
        if (!current) {
          const token = randomUUID();
          insert.run(
            blob.content_hash,
            blob.media_type,
            blob.byte_size,
            now,
            input.owner_id,
            token,
            expiresAt,
            now,
          );
          plans.push({
            content_hash: blob.content_hash,
            generation: 1,
            mode: "write",
            claim_token: token,
          });
          continue;
        }

        const leaseActive = current.write_claim_token !== null &&
          current.write_lease_expires_at !== null &&
          Date.parse(current.write_lease_expires_at) > Date.now();
        if (current.state === "deleting" || leaseActive) {
          throw new BlobReservationConflictError(blob.content_hash);
        }

        const needsWrite = current.state === "reserved" || forceWrite.has(blob.content_hash);
        if (needsWrite) {
          const generation = current.generation + 1;
          const token = randomUUID();
          const state = current.state === "protected" ? "protected" : "reserved";
          update.run(
            state,
            generation,
            input.owner_id,
            token,
            expiresAt,
            current.state === "protected" ? null : now,
            blob.content_hash,
          );
          plans.push({
            content_hash: blob.content_hash,
            generation,
            mode: "write",
            claim_token: token,
          });
        } else {
          if (current.write_claim_token !== null) clearExpiredLease.run(blob.content_hash);
          plans.push({
            content_hash: blob.content_hash,
            generation: current.generation,
            mode: "reuse",
          });
        }
      }
      return plans;
    }).immediate();
}

export function releaseBlobReservations(
    db: Database.Database,
    reservations: readonly BlobReservation[],
): void {
    db.transaction(() => {
      const release = db.prepare(`
        UPDATE blobs SET write_lease_owner = NULL, write_claim_token = NULL,
          write_lease_expires_at = NULL,
          unreferenced_at = CASE
            WHEN state = 'protected' THEN unreferenced_at
            WHEN EXISTS (
              SELECT 1 FROM blob_references r WHERE r.content_hash = blobs.content_hash
            ) THEN NULL
            ELSE COALESCE(unreferenced_at, ?)
          END
        WHERE content_hash = ? AND generation = ? AND write_claim_token = ?
      `);
      const now = new Date().toISOString();
      for (const reservation of reservations) {
        if (reservation.mode === "write") {
          release.run(
            now,
            reservation.content_hash,
            reservation.generation,
            reservation.claim_token,
          );
        }
      }
    }).immediate();
}

export function completeBlobReservations(
    db: Database.Database,
    reservations: readonly BlobReservation[] | undefined,
    referencedHashes: ReadonlySet<string>,
): void {
    const completeWrite = db.prepare(`
      UPDATE blobs SET state = CASE WHEN state = 'protected' THEN 'protected' ELSE 'available' END,
        write_lease_owner = NULL, write_claim_token = NULL, write_lease_expires_at = NULL,
        unreferenced_at = NULL
      WHERE content_hash = ? AND generation = ? AND write_claim_token = ?
        AND state IN ('reserved', 'protected')
        AND write_lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    `);
    const validateReuse = db.prepare(`
      UPDATE blobs SET unreferenced_at = NULL
      WHERE content_hash = ? AND generation = ? AND state IN ('available', 'protected')
        AND write_claim_token IS NULL
    `);
    const seen = new Set<string>();
    for (const reservation of reservations ?? []) {
      if (seen.has(reservation.content_hash)) {
        throw new Error("Blob reservations must contain unique hashes");
      }
      seen.add(reservation.content_hash);
      if (reservation.mode === "write") {
        if (!referencedHashes.has(reservation.content_hash) ||
          completeWrite.run(
            reservation.content_hash,
            reservation.generation,
            reservation.claim_token,
          ).changes !== 1) {
          throw new BlobReservationConflictError(reservation.content_hash);
        }
      } else if (validateReuse.run(
        reservation.content_hash,
        reservation.generation,
      ).changes !== 1) {
        throw new BlobReservationConflictError(reservation.content_hash);
      }
    }
}

function insertBlobRow(db: Database.Database, contentHash: string, mediaType: string | undefined, byteSize: number | undefined, createdAt: string): void {
    db
      .prepare(
        `
          INSERT OR IGNORE INTO blobs (
            content_hash, media_type, byte_size, created_at, state
          ) VALUES (?, ?, ?, ?, 'protected')
        `,
      )
      .run(contentHash, mediaType ?? "application/octet-stream", byteSize ?? 0, createdAt);
  }

function insertBlobReference(
  db: Database.Database,
  orgId: string,
  eventId: string,
  kind: "body" | "attachment",
  contentHash: string,
  createdAt: string,
): void {
  const eligible = db.prepare(
    `UPDATE blobs SET unreferenced_at = NULL
     WHERE content_hash = ? AND state IN ('available', 'protected')
       AND write_claim_token IS NULL`,
  ).run(contentHash);
  if (eligible.changes !== 1) throw new BlobReservationConflictError(contentHash);
  db.prepare(
    `INSERT OR IGNORE INTO blob_references (
       owner_org_id, owner_type, owner_id, reference_kind, content_hash, created_at
     ) VALUES (?, 'event', ?, ?, ?, ?)`,
  ).run(orgId, eventId, kind, contentHash, createdAt);
}

export function commitIngestUnlocked(db: Database.Database, request: IngestCommitRequest): EventRecord[] {
    assertIngestDispositionBindings(request);
    if (request.appends.length === 0 && request.dispositions.length === 0) {
      return [];
    }
    completeBlobReservations(
      db,
      request.blob_reservations,
      new Set(request.appends.flatMap((append) => [
        ...(append.content_hash ? [append.content_hash] : []),
        ...(append.extra_blobs ?? []).map((blob) => blob.content_hash),
      ])),
    );
    const events = request.appends.map((input) => {
      const operation = input.operation ?? "create";
      if (operation === "tombstone") {
        const current = findCurrent(db, input);
        if ((current?.id ?? null) !== input.expected_head_id) {
          throw new AuthorityConflictError();
        }
        return insertWithinTransaction(db, {
          ...input,
          operation,
          content_hash: current?.content_hash ?? input.content_hash,
          parent_event_id: current?.id,
        });
      }
      return insertWithinTransaction(db, {
        ...input,
        operation,
        ...(operation === "revise" && input.parent_event_id
          ? { parent_event_id: input.parent_event_id }
          : {}),
      });
    });
    const eventsById = new Map(events.map((event) => [event.id, event]));
    const appendsByEventId = new Map(
      events.map((event, index) => [event.id, request.appends[index]]),
    );
    for (const decision of request.dispositions) {
      const event = eventsById.get(decision.event_id);
      if (!event) {
        throw new Error("Ingest disposition event was not created");
      }
      const append = appendsByEventId.get(event.id);
      persistIngestionDisposition(
        db,
        event,
        decision,
        append?.parent_event_id,
      );
    }
    return events;
  }

export async function appendRevision(db: Database.Database, input: EventRevision): Promise<EventRecord> {
    assertEventDispositionBinding(input);
    return db.transaction(() => {
      completeBlobReservations(
        db,
        input.blob_reservations,
        new Set([
          input.content_hash,
          ...(input.extra_blobs ?? []).map((blob) => blob.content_hash),
        ]),
      );
      const event = insertWithinTransaction(db, { ...input, operation: "revise" });
      if (input.disposition) {
        persistIngestionDisposition(db, event, input.disposition, input.parent_event_id);
      }
      return event;
    }).immediate();
  }

export async function markTombstone(db: Database.Database, input: TombstoneEvent): Promise<EventRecord> {
    assertEventDispositionBinding(input);
    const transaction = db.transaction(() => {
      const current = findCurrent(db, input);
      if ((current?.id ?? null) !== input.expected_head_id) {
        throw new AuthorityConflictError();
      }
      const event = insertWithinTransaction(db, {
        ...input,
        operation: "tombstone",
        content_hash: current?.content_hash,
        parent_event_id: current?.id,
      });
      if (input.disposition) {
        persistIngestionDisposition(db, event, input.disposition, current?.id);
      }
      return event;
    });
    return transaction.immediate();
  }

function findCurrent(db: Database.Database, identity: SourceIdentity): EventRecord | null {
    const row = db
      .prepare(
        `
          SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
               e.content_hash, e.parent_event_id, e.thread_id, e.actor_id,
               e.required_scope_ids_json, e.direction_tags_json, e.weight_hints_json, e.attrs_json,
               e.occurred_at, e.ingested_at
          FROM source_heads h
          JOIN events e ON e.id = h.current_event_id
          WHERE h.org_id = ? AND h.source = ? AND h.external_id = ?
        `,
      )
      .get(identity.org_id, identity.source, identity.external_id) as
      | EventRow
      | undefined;
    return row ? toEvent(db, row) : null;
  }

function insert(db: Database.Database, input: InsertEventInput): EventRecord {
    return db.transaction(() =>
      insertWithinTransaction(db, input),
    ).immediate();
  }

function insertWithinTransaction(db: Database.Database, input: InsertEventInput): EventRecord {
    const event: EventRecord = {
      id: input.id ?? randomUUID(),
      org_id: input.org_id,
      source: input.source,
      external_id: input.external_id,
      operation: input.operation,
      content_hash: input.content_hash,
      parent_event_id: input.parent_event_id,
      thread_id: input.thread_id,
      actor_id: input.actor_id,
      required_scope_ids: input.required_scope_ids
        ? [...input.required_scope_ids]
        : undefined,
      direction_tags: input.direction_tags ? [...input.direction_tags] : undefined,
      weight_hints: input.weight_hints ? structuredClone(input.weight_hints) : undefined,
      attrs: input.attrs ? structuredClone(input.attrs) : undefined,
      occurred_at: input.occurred_at,
      ingested_at: new Date().toISOString(),
    };

    if (input.content_hash) {
      insertBlobRow(db, 
        input.content_hash,
        input.content_media_type,
        input.content_byte_size,
        event.ingested_at,
      );
    }
    for (const blob of input.extra_blobs ?? []) {
      insertBlobRow(db, 
        blob.content_hash,
        blob.media_type,
        blob.byte_size,
        event.ingested_at,
      );
    }

    db
      .prepare(
        `
          INSERT INTO events (
            id, org_id, source, external_id, operation, content_hash,
            parent_event_id, revision_id, occurred_at, ingested_at, thread_id,
            actor_id, required_scope_ids_json, direction_tags_json, weight_hints_json, attrs_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        event.id,
        event.org_id,
        event.source,
        event.external_id,
        event.operation,
        event.content_hash ?? null,
        event.parent_event_id ?? null,
        input.revision_id ?? null,
        event.occurred_at,
        event.ingested_at,
        event.thread_id ?? conversationId(event.source, event.external_id, event.id),
        event.actor_id ?? null,
        event.required_scope_ids
          ? JSON.stringify(event.required_scope_ids)
          : null,
        input.direction_tags ? JSON.stringify(input.direction_tags) : null,
        input.weight_hints ? JSON.stringify(input.weight_hints) : null,
        input.attrs ? JSON.stringify(input.attrs) : null,
      );
    const headUpdate =
      input.expected_head_id === null
        ? db
            .prepare(
              `
                INSERT OR IGNORE INTO source_heads (
                  org_id, source, external_id, current_event_id
                ) VALUES (?, ?, ?, ?)
              `,
            )
            .run(event.org_id, event.source, event.external_id, event.id)
        : db
            .prepare(
              `
                UPDATE source_heads SET current_event_id = ?
                WHERE org_id = ? AND source = ? AND external_id = ?
                  AND current_event_id = ?
              `,
            )
            .run(
              event.id,
              event.org_id,
              event.source,
              event.external_id,
              input.expected_head_id,
            );
    if (headUpdate.changes !== 1) {
      throw new AuthorityConflictError();
    }
    if (event.content_hash) {
      insertBlobReference(db, event.org_id, event.id, "body", event.content_hash, event.ingested_at);
    }
    for (const blob of input.extra_blobs ?? []) {
      insertBlobReference(db, event.org_id, event.id, "attachment", blob.content_hash, event.ingested_at);
    }
    enqueueContextProjection(db, event.id, event.org_id, event.ingested_at);
    const threadId = event.thread_id ?? conversationId(event.source, event.external_id, event.id);
    if (input.expected_head_id !== null) {
      const previous = db.prepare(`SELECT thread_id, source, external_id FROM events WHERE org_id = ? AND id = ?`)
        .get(event.org_id, input.expected_head_id) as
        | { thread_id: string | null; source: string; external_id: string }
        | undefined;
      if (previous) {
        const previousThreadId = previous.thread_id ??
          conversationId(previous.source, previous.external_id, input.expected_head_id);
        if (previousThreadId !== threadId) {
          refreshThreadHeadWithinTransaction(db, event.org_id, previousThreadId);
        }
      }
    }
    refreshThreadHeadWithinTransaction(db, event.org_id, threadId);
    return event;
  }

function persistIngestionDisposition(
  db: Database.Database,
  event: EventRecord,
  decision: ArrangementDecision,
  previousEventId?: string,
): void {
  const saved = putDispositionWithinTransaction(db, decision);
  const previous = previousEventId
    ? db.prepare(`SELECT disposition FROM message_dispositions WHERE event_id = ?`)
        .get(previousEventId) as { disposition: ArrangementDecision["disposition"] } | undefined
    : undefined;
  if (
    decision.disposition !== "current_work" &&
    previous?.disposition !== "current_work"
  ) {
    return;
  }
  const threadId =
    event.thread_id ??
    conversationId(event.source, event.external_id, event.id);
  if (saved.disposition === "current_work" && event.operation !== "tombstone") {
    unfoldCurrentWorkWithinTransaction(db, {
      org_id: event.org_id, thread_id: threadId, event_id: event.id,
      cause: "current_work_ingested", dedupe_id: event.id, now: event.ingested_at,
    });
  }
  db.prepare(`INSERT INTO conversation_lifecycle_events (
    id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
    event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
  ) VALUES (?, ?, ?, 'source_event', ?, 1, 'current_work_changed', NULL, ?, 1, ?, ?, ?)`)
    .run(
      randomUUID(),
      event.org_id,
      threadId,
      event.id,
      JSON.stringify(["source_event", event.id, 1, "current_work_changed"]),
      JSON.stringify({
        source: "ingestion",
        previous: previousEventId
          ? { event_id: previousEventId, disposition: previous?.disposition ?? null }
          : null,
        result: saved,
      }),
      decision.decided_at,
      event.ingested_at,
    );
}

function enqueueContextProjection(db: Database.Database, eventId: string, orgId: string, at: string): void {
    db.prepare(
      `
        INSERT INTO context_projection_outbox (
          id, org_id, event_id, status, attempts, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', 0, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          status = 'pending', attempts = 0, lease_owner = NULL,
          lease_expires_at = NULL, next_retry_at = NULL, last_error = NULL,
          updated_at = excluded.updated_at
      `,
    ).run(`context-projection:${eventId}`, orgId, eventId, at, at);
  }

export function toEvent(db: Database.Database, row: EventRow): EventRecord {
    return {
      id: row.id,
      org_id: row.org_id,
      source: row.source,
      external_id: row.external_id,
      operation: row.operation,
      content_hash: row.content_hash ?? undefined,
      parent_event_id: row.parent_event_id ?? undefined,
      thread_id: row.thread_id ?? undefined,
      actor_id: row.actor_id ?? undefined,
      required_scope_ids: row.required_scope_ids_json
        ? (JSON.parse(row.required_scope_ids_json) as string[])
        : undefined,
      direction_tags: row.direction_tags_json
        ? (JSON.parse(row.direction_tags_json) as string[])
        : undefined,
      weight_hints: row.weight_hints_json
        ? JSON.parse(row.weight_hints_json) as NewEvent["weight_hints"]
        : undefined,
      attrs: row.attrs_json
        ? JSON.parse(row.attrs_json) as NewEvent["attrs"]
        : undefined,
      occurred_at: row.occurred_at,
      ingested_at: row.ingested_at,
    };
  }
