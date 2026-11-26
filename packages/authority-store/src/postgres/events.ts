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
import type {
  PoolClient,
} from "pg";
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
  PgSql,
  asJson,
  asNumber,
  jsonb,
  toIso,
} from "./sql";
import {
  putDispositionWithinTransaction,
  refreshThreadHeadWithinTransaction,
  unfoldCurrentWorkWithinTransaction,
} from "./inbox";
import {
  lockConversationThreads,
  type ConversationLockKey,
} from "./conversation-lock";
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
  required_scope_ids: unknown;
  direction_tags: unknown;
  weight_hints: unknown;
  attrs: unknown;
  occurred_at: unknown;
  ingested_at: unknown;
}

interface ContextEventRow extends EventRow {
  content_media_type: string | null;
}

interface BlobRow {
  content_hash: string;
  media_type: string;
  byte_size: number;
  created_at: unknown;
}

interface BlobInventoryRow extends BlobRow {
  state: BlobInventoryRecord["state"];
  generation: number;
  unreferenced_at: unknown;
  write_lease_expires_at: unknown;
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

export async function findBySourceIdentity(db: PgSql, identity: SourceIdentity): Promise<EventRecord | null> {
    return findCurrent(db, identity);
  }

export async function bindSourceIdentityAliases(db: PgSql, input: SourceIdentityAliasBind): Promise<void> {
    await db.withTx(async (client) => {
      const event = await getEvent(db, input.org_id, input.event_id, client);
      if (!event) {
        throw new Error(`Unknown event for identity alias: ${input.event_id}`);
      }
      await lockConversationThreads(db, client, [{
        org_id: input.org_id,
        thread_id: event.thread_id ?? conversationId(event.source, event.external_id, event.id),
      }]);
      const exists = await db.queryOne("SELECT 1 FROM events WHERE org_id = $1 AND id = $2",
        [input.org_id, input.event_id], client);
      if (!exists) throw new Error(`Unknown event for identity alias: ${input.event_id}`);
      const isCurrent = Boolean(await db.queryOne(
        "SELECT 1 FROM source_heads WHERE org_id = $1 AND current_event_id = $2 LIMIT 1",
        [input.org_id, input.event_id], client,
      ));
      for (const alias of input.aliases) {
        const externalId = alias.external_id.trim();
        if (!alias.source.trim() || !externalId) {
          continue;
        }
        if (!isCurrent && !await db.queryOne(
          "SELECT 1 FROM source_heads WHERE org_id = $1 AND source = $2 AND external_id = $3",
          [input.org_id, alias.source, externalId], client,
        )) {
          throw new AuthorityConflictError();
        }
        await db.execute(
          `
            INSERT INTO source_heads (
              org_id, source, external_id, current_event_id
            ) VALUES ($1, $2, $3, $4)
            ON CONFLICT (org_id, source, external_id) DO NOTHING
          `,
          [input.org_id, alias.source, externalId, input.event_id],
          client,
        );
      }
    });
  }

export async function getOutboundAttempt(db: PgSql, orgId: string, clientRequestId: string, client?: PoolClient): Promise<OutboundAttemptRecord | null> {
    const row = await db.queryOne<{
      org_id: string;
      client_request_id: string;
      thread_id: string;
      event_id: string | null;
      status: OutboundAttemptRecord["status"];
      channel_message_ids: unknown;
      recovery_hash: string | null;
      receipt_json: unknown;
      created_at: unknown;
      updated_at: unknown;
    }>(
      `
        SELECT org_id, client_request_id, thread_id, event_id, status,
               channel_message_ids, recovery_hash, receipt_json, created_at, updated_at
        FROM outbound_attempts
        WHERE org_id = $1 AND client_request_id = $2
      `,
      [orgId, clientRequestId],
      client,
    );
    if (!row) {
      return null;
    }
    const channelMessageIds = row.channel_message_ids
      ? asJson<string[]>(row.channel_message_ids)
      : undefined;
    return {
      org_id: row.org_id,
      client_request_id: row.client_request_id,
      thread_id: row.thread_id,
      ...(row.event_id ? { event_id: row.event_id } : {}),
      status: row.status,
      ...(row.recovery_hash ? { recovery_hash: row.recovery_hash } : {}),
      ...(row.receipt_json
        ? { receipt: asJson<OutboundAttemptRecord["receipt"]>(row.receipt_json) }
        : {}),
      ...(channelMessageIds ? { channel_message_ids: channelMessageIds } : {}),
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
    };
  }

export async function claimOutboundAttempt(db: PgSql, input: NewOutboundAttempt): Promise<boolean> {
  return db.withTx(async (client) => {
    const changed = await db.execute(`
      INSERT INTO outbound_attempts (
        org_id, client_request_id, thread_id, status, recovery_hash, created_at, updated_at
      ) VALUES ($1, $2, $3, 'pending', $4, $5, $5)
      ON CONFLICT (org_id, client_request_id) DO UPDATE SET
        status = 'pending',
        recovery_hash = EXCLUDED.recovery_hash,
        updated_at = EXCLUDED.updated_at
      WHERE outbound_attempts.status = 'rejected'
        AND outbound_attempts.thread_id = EXCLUDED.thread_id
        AND outbound_attempts.event_id IS NULL
        AND outbound_attempts.receipt_json IS NULL
        AND outbound_attempts.channel_message_ids IS NULL
    `, [
      input.org_id, input.client_request_id, input.thread_id,
      input.recovery_hash ?? null, input.now,
    ], client);
    if (changed !== 1) return false;
    await syncOutboundRecoveryBlobReference(db, client, input);
    return true;
  });
}

export async function putOutboundAttempt(db: PgSql, input: OutboundAttemptPut): Promise<OutboundAttemptRecord> {
  return db.withTx(async (client) => {
    const previous = await getOutboundAttempt(db, input.org_id, input.client_request_id, client);
    const createdAt = previous?.created_at ?? input.now;
    await db.execute(
      `
        INSERT INTO outbound_attempts (
          org_id, client_request_id, thread_id, event_id, status,
          channel_message_ids, recovery_hash, receipt_json, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (org_id, client_request_id) DO UPDATE SET
          thread_id = EXCLUDED.thread_id,
          event_id = EXCLUDED.event_id,
          status = EXCLUDED.status,
          channel_message_ids = EXCLUDED.channel_message_ids,
          recovery_hash = COALESCE(EXCLUDED.recovery_hash, outbound_attempts.recovery_hash),
          receipt_json = COALESCE(EXCLUDED.receipt_json, outbound_attempts.receipt_json),
          updated_at = EXCLUDED.updated_at
      `,
      [
        input.org_id,
        input.client_request_id,
        input.thread_id,
        input.event_id ?? null,
        input.status,
        jsonb(input.channel_message_ids),
        input.recovery_hash ?? null,
        jsonb(input.receipt),
        createdAt,
        input.now,
      ],
      client,
    );
    const persisted = await getOutboundAttempt(
      db,
      input.org_id,
      input.client_request_id,
      client,
    );
    const recoveryHash = persisted?.recovery_hash;
    await syncOutboundRecoveryBlobReference(db, client, {
      ...input,
      recovery_hash: recoveryHash,
    });
    return {
      org_id: input.org_id,
      client_request_id: input.client_request_id,
      thread_id: input.thread_id,
      ...(input.event_id ? { event_id: input.event_id } : {}),
      status: input.status,
      recovery_hash: recoveryHash,
      receipt: input.receipt ?? previous?.receipt,
      ...(input.channel_message_ids
        ? { channel_message_ids: [...input.channel_message_ids] }
        : {}),
      created_at: createdAt,
      updated_at: input.now,
    };
  });
}

async function syncOutboundRecoveryBlobReference(
  db: PgSql,
  client: PoolClient,
  input: NewOutboundAttempt | OutboundAttemptPut,
): Promise<void> {
  const expected = new Set(input.recovery_hash ? [input.recovery_hash] : []);
  const reservations = input.blob_reservations;
  const oldRows = await db.query<{ content_hash: string }>(
    `SELECT content_hash FROM blob_references
     WHERE owner_org_id = $1 AND owner_type = 'outbound_attempt'
       AND owner_id = $2 AND reference_kind = 'reply_recovery'`,
    [input.org_id, input.client_request_id],
    client,
  );
  if (reservations !== undefined) {
    const hashes = new Set(reservations.map((reservation) => reservation.content_hash));
    if (hashes.size !== reservations.length || hashes.size !== expected.size
      || [...expected].some((hash) => !hashes.has(hash))) {
      throw new Error("Outbound recovery reservations must exactly match the stored recovery hash");
    }
    await completeBlobReservations(db, client, reservations, expected);
  } else if (input.recovery_hash && !oldRows.some((row) => row.content_hash === input.recovery_hash)) {
    await insertBlobRow(
      db,
      input.recovery_hash,
      "application/vnd.regenic.reply-recovery+json",
      0,
      input.now,
      client,
    );
    const protectedBlob = await db.execute(
      `UPDATE blobs SET state = 'protected', unreferenced_at = NULL
       WHERE content_hash = $1 AND state IN ('available', 'protected')
         AND write_claim_token IS NULL`,
      [input.recovery_hash],
      client,
    );
    if (protectedBlob !== 1) throw new BlobReservationConflictError(input.recovery_hash);
  }

  await db.execute(
    `DELETE FROM blob_references WHERE owner_org_id = $1 AND owner_type = 'outbound_attempt'
       AND owner_id = $2 AND reference_kind = 'reply_recovery'`,
    [input.org_id, input.client_request_id],
    client,
  );
  if (input.recovery_hash) {
    const eligible = await db.execute(
      `UPDATE blobs SET unreferenced_at = NULL
       WHERE content_hash = $1 AND state IN ('available', 'protected')
         AND write_claim_token IS NULL`,
      [input.recovery_hash],
      client,
    );
    if (eligible !== 1) throw new BlobReservationConflictError(input.recovery_hash);
    await db.execute(
      `INSERT INTO blob_references (
         owner_org_id, owner_type, owner_id, reference_kind, content_hash, created_at
       ) VALUES ($1, 'outbound_attempt', $2, 'reply_recovery', $3, $4)
       ON CONFLICT DO NOTHING`,
      [input.org_id, input.client_request_id, input.recovery_hash, input.now],
      client,
    );
  }
  for (const { content_hash } of oldRows) {
    if (content_hash === input.recovery_hash) continue;
    await db.execute(
      `UPDATE blobs SET unreferenced_at = $1
       WHERE content_hash = $2 AND NOT EXISTS (
         SELECT 1 FROM blob_references r WHERE r.content_hash = blobs.content_hash
       )`,
      [input.now, content_hash],
      client,
    );
  }
}

export async function getEvent(db: PgSql, orgId: string, eventId: string, client?: PoolClient): Promise<EventRecord | null> {
    const row = await db.queryOne<EventRow>(
      `
        SELECT id, org_id, source, external_id, operation, content_hash,
               parent_event_id, thread_id, actor_id, required_scope_ids,
               direction_tags, weight_hints, attrs,
               occurred_at, ingested_at
        FROM events WHERE org_id = $1 AND id = $2
      `,
      [orgId, eventId],
      client,
    );
    return row ? toEvent(db, row) : null;
  }

export async function listEvents(db: PgSql, orgId: string, query?: EventListQuery): Promise<EventRecord[]> {
    const params: unknown[] = [];
    const p = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const clauses = [`org_id = ${p(orgId)}`];
    if (query?.source) {
      clauses.push(`source = ${p(query.source)}`);
    }
    if (query?.target) {
      clauses.push(
        `(external_id = ${p(query.target)} OR external_id LIKE ${p(threadExternalIdLike(query.target))} ESCAPE E'\\\\')`,
      );
    }
    if (query?.thread_ids) {
      if (query.thread_ids.length === 0) {
        return [];
      }
      clauses.push(
        `thread_id IN (${query.thread_ids.map((id) => p(id)).join(", ")})`,
      );
    }
    if (query?.since) {
      clauses.push(
        `(ingested_at > ${p(query.since)} OR (ingested_at = ${p(query.since)} AND id > ${p(query.since_id ?? "")}))`,
      );
    }
    if (query?.occurred_since) {
      clauses.push(`occurred_at >= ${p(query.occurred_since)}`);
    }
    const limit =
      typeof query?.limit === "number" &&
      Number.isInteger(query.limit) &&
      query.limit > 0
        ? query.limit
        : undefined;
    const limitSql = limit === undefined ? "" : `LIMIT ${p(limit)}`;
    const order = query?.order === "recent" ? "DESC" : "ASC";
    const orderBy = query?.order === "ingested"
      ? "ingested_at ASC, id ASC"
      : `sequence ${order}`;
    const rows = await db.query<EventRow>(
      `
        SELECT id, org_id, source, external_id, operation, content_hash,
               parent_event_id, thread_id, actor_id, required_scope_ids,
               direction_tags, weight_hints, attrs,
               occurred_at, ingested_at
        FROM events WHERE ${clauses.join(" AND ")} ORDER BY ${orderBy}
        ${limitSql}
      `,
      params,
    );
    return rows.map((row) => toEvent(db, row));
  }

export async function openContextRead(db: PgSql, orgId: string, query?: ContextAuthorityReadQuery): Promise<ContextAuthorityRead> {
    return openContextReadInternal(db, orgId, query);
  }

export async function openContextReadForThread(db: PgSql, orgId: string, threadId: string): Promise<ContextAuthorityRead> {
    const scopedThreadId = threadId.trim();
    if (!scopedThreadId) {
      throw new Error("Context thread read requires a thread id");
    }
    return openContextReadInternal(db, orgId, { filters: { thread_ids: [scopedThreadId] } });
  }

export async function openContextEventPage(
  db: PgSql,
  orgId: string,
  query: ContextEventPageQuery,
): Promise<ContextEventPage> {
  if (!orgId.trim()) {
    throw new Error("Context event page organization is required");
  }
  if (!Number.isInteger(query?.limit) || query.limit < 1 || query.limit > 1_000) {
    throw new Error("Context event page limit is invalid");
  }
  const after = query.after_event_id?.trim() || null;
  const afterRow = after
    ? await db.queryOne<{ sequence: string | number }>(
      `SELECT sequence FROM events WHERE org_id = $1 AND id = $2`,
      [orgId, after],
    )
    : undefined;
  const afterSequence = afterRow ? Number(afterRow.sequence) : -1;
  const rows = await db.query<ContextEventRow>(
    `
      SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
             e.content_hash, e.parent_event_id, e.thread_id, e.actor_id,
             e.required_scope_ids, e.direction_tags, e.weight_hints, e.attrs,
             e.occurred_at, e.ingested_at,
             b.media_type AS content_media_type
      FROM events e
      LEFT JOIN blobs b ON b.content_hash = e.content_hash
      WHERE e.org_id = $1 AND e.sequence > $2
      ORDER BY e.sequence ASC, e.id ASC
      LIMIT $3
    `,
    [orgId, afterSequence, query.limit + 1],
  );
  const done = rows.length <= query.limit;
  return {
    events: rows.slice(0, query.limit).map((row) => ({
      ...toEvent(db, row),
      ...(row.content_media_type ? { content_media_type: row.content_media_type } : {}),
    })),
    done,
  };
}

async function openContextReadInternal(db: PgSql, orgId: string, query?: ContextAuthorityReadQuery): Promise<ContextAuthorityRead> {
    const scope = contextReadScope(orgId, query, "postgres");
    return db.withTx(async (client) => {
      const rows = await db.query<ContextEventRow>(
            `${scope.sql}
              SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
                     e.content_hash, e.parent_event_id, e.thread_id, e.actor_id,
                     e.required_scope_ids, e.direction_tags, e.weight_hints, e.attrs,
                     e.occurred_at, e.ingested_at,
                     b.media_type AS content_media_type
              FROM events e
              JOIN selected_identities s
                ON s.org_id = e.org_id AND s.source = e.source AND s.external_id = e.external_id
              LEFT JOIN blobs b ON b.content_hash = e.content_hash
              ORDER BY e.sequence ASC
            `,
            scope.params,
            client,
          );
      const lifecycleHeads = await db.query<ContextAuthorityRead["lifecycle_heads"][number]>(
            `${scope.sql}
              SELECT sh.source, sh.external_id, sh.current_event_id AS head_event_id
              FROM source_heads sh
              JOIN selected_identities s
                ON s.org_id = sh.org_id AND s.source = sh.source AND s.external_id = sh.external_id
              ORDER BY sh.source ASC, sh.external_id ASC
            `,
            scope.params,
            client,
          );
      const recordedAt = new Date().toISOString();
      const events = rows.map((row) => ({
        ...toEvent(db, row),
        ...(row.content_media_type
          ? { content_media_type: row.content_media_type }
          : {}),
      }));
      return {
        read_epoch: `authority:${hashCanonicalContext({
          org_id: orgId,
          events,
          lifecycle_heads: lifecycleHeads,
        })}`,
        recorded_at: recordedAt,
        events,
        lifecycle_heads: lifecycleHeads,
      } satisfies ContextAuthorityRead;
    }, "REPEATABLE READ");
  }

export async function findBlob(db: PgSql, contentHash: string): Promise<BlobRecord | null> {
    return (await findBlobs(db, [contentHash])).get(contentHash) ?? null;
  }

export async function findBlobs(db: PgSql, contentHashes: readonly string[]): Promise<Map<string, BlobRecord>> {
    const unique = [
      ...new Set(contentHashes.filter((hash) => hash.length > 0)),
    ];
    const found = new Map<string, BlobRecord>();
    const chunkSize = 400;
    for (let offset = 0; offset < unique.length; offset += chunkSize) {
      const chunk = unique.slice(offset, offset + chunkSize);
      const params: unknown[] = [];
      const placeholders = chunk.map((hash) => {
        params.push(hash);
        return `$${params.length}`;
      });
      const rows = await db.query<BlobRow>(
        `SELECT content_hash, media_type, byte_size, created_at
         FROM blobs WHERE content_hash IN (${placeholders.join(", ")})`,
        params,
      );
      for (const row of rows) {
        found.set(row.content_hash, {
          content_hash: row.content_hash,
          media_type: row.media_type,
          byte_size: asNumber(row.byte_size),
          created_at: toIso(row.created_at),
        });
      }
    }
    return found;
  }

  export async function inspectBlobInventory(
    db: PgSql,
    contentHashes: readonly string[],
  ): Promise<Map<string, BlobInventoryRecord>> {
    const unique = [...new Set(contentHashes.filter((hash) => hash.length > 0))];
    const found = new Map<string, BlobInventoryRecord>();
    const chunkSize = 400;
    for (let offset = 0; offset < unique.length; offset += chunkSize) {
      const chunk = unique.slice(offset, offset + chunkSize);
      const params: unknown[] = [];
      const placeholders = chunk.map((hash) => {
        params.push(hash);
        return `$${params.length}`;
      });
      const rows = await db.query<BlobInventoryRow>(`
        SELECT b.content_hash, b.media_type, b.byte_size, b.created_at, b.state,
               b.generation, b.unreferenced_at, b.write_lease_expires_at,
               COUNT(r.content_hash)::INTEGER AS reference_count
        FROM blobs b
        LEFT JOIN blob_references r ON r.content_hash = b.content_hash
        WHERE b.content_hash IN (${placeholders.join(", ")})
        GROUP BY b.content_hash
      `, params);
      for (const row of rows) {
        found.set(row.content_hash, {
          content_hash: row.content_hash,
          media_type: row.media_type,
          byte_size: asNumber(row.byte_size),
          created_at: toIso(row.created_at),
          state: row.state,
          generation: asNumber(row.generation),
          unreferenced_at: row.unreferenced_at === null ? null : toIso(row.unreferenced_at),
          write_lease_expires_at: row.write_lease_expires_at === null
            ? null
            : toIso(row.write_lease_expires_at),
          reference_count: asNumber(row.reference_count),
        });
      }
    }
    return found;
  }

  export async function listBlobInventoryPage(
    db: PgSql,
    query: BlobInventoryPageQuery,
  ): Promise<BlobInventoryPage> {
    assertBlobInventoryPageQuery(query);
    const rows = await db.query<BlobInventoryRow>(`
      SELECT b.content_hash, b.media_type, b.byte_size, b.created_at, b.state,
             b.generation, b.unreferenced_at, b.write_lease_expires_at,
             COUNT(r.content_hash)::INTEGER AS reference_count
      FROM blobs b
      LEFT JOIN blob_references r ON r.content_hash = b.content_hash
      WHERE ($1::TEXT IS NULL OR b.content_hash > $1)
      GROUP BY b.content_hash
      ORDER BY b.content_hash
      LIMIT $2
    `, [query.after_hash ?? null, query.limit + 1]);
    const hasMore = rows.length > query.limit;
    const entries = rows.slice(0, query.limit).map((row) => ({
      content_hash: row.content_hash,
      media_type: row.media_type,
      byte_size: asNumber(row.byte_size),
      created_at: toIso(row.created_at),
      state: row.state,
      generation: asNumber(row.generation),
      unreferenced_at: row.unreferenced_at === null ? null : toIso(row.unreferenced_at),
      write_lease_expires_at: row.write_lease_expires_at === null
        ? null
        : toIso(row.write_lease_expires_at),
      reference_count: asNumber(row.reference_count),
    }));
    return {
      entries,
      next_after_hash: hasMore ? entries.at(-1)?.content_hash ?? null : null,
    };
  }

export async function backfillEventAttachmentReferences(
  db: PgSql,
  input: EventAttachmentReferenceBackfill,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(input.expected_content_hash) ||
    input.attachment_hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("Invalid Event attachment reference hash");
  }
  await db.withTx(async (client) => {
    const event = await db.queryOne<{ content_hash: string | null; ingested_at: unknown }>(
      `SELECT content_hash, ingested_at FROM events WHERE org_id = $1 AND id = $2 FOR UPDATE`,
      [input.org_id, input.event_id],
      client,
    );
    if (!event || event.content_hash !== input.expected_content_hash) {
      throw new Error("Event changed during attachment reference backfill");
    }
    const ingestedAt = toIso(event.ingested_at);
    for (const hash of [...new Set(input.attachment_hashes)].sort()) {
      await insertBlobRow(db, hash, "application/octet-stream", 0, ingestedAt, client);
      const protectedBlob = await db.execute(
        `UPDATE blobs SET state = 'protected', unreferenced_at = NULL,
           gc_claim_token = NULL, gc_started_at = NULL
         WHERE content_hash = $1 AND state IN ('available', 'protected')
           AND write_claim_token IS NULL`,
        [hash],
        client,
      );
      if (protectedBlob !== 1) throw new BlobReservationConflictError(hash);
      await insertBlobReference(db, input.org_id, input.event_id, "attachment", hash, ingestedAt, client);
    }
  });
}

export async function append(db: PgSql, input: NewEvent): Promise<EventRecord> {
    return insert(db, { ...input, operation: "create" });
  }

export async function repointContentHash(db: PgSql, input: RepointContentInput): Promise<number> {
    return db.withTx(async (client) => {
      const now = new Date().toISOString();
      const affectedEvents = await db.query<{ id: string; org_id: string }>(
        `SELECT id, org_id FROM events WHERE content_hash = $1 ORDER BY id FOR UPDATE`,
        [input.old_content_hash],
        client,
      );
      if (affectedEvents.length === 0) return 0;
      await insertBlobRow(db, 
        input.new_content_hash,
        input.content_media_type,
        input.content_byte_size,
        now,
        client,
      );
      for (const blob of input.extra_blobs ?? []) {
        await insertBlobRow(db, 
          blob.content_hash,
          blob.media_type,
          blob.byte_size,
          now,
          client,
        );
      }
      const updated = await db.execute(
        `UPDATE events SET content_hash = $1 WHERE content_hash = $2`,
        [input.new_content_hash, input.old_content_hash],
        client,
      );
      if (updated > 0) {
        const referencedHashes = new Set([
          input.new_content_hash,
          ...(input.extra_blobs ?? []).map((blob) => blob.content_hash),
        ]);
        if (input.blob_reservations) {
          assertCompleteRepointReservations(referencedHashes, input.blob_reservations);
          await completeBlobReservations(db, client, input.blob_reservations, referencedHashes);
        } else {
          await protectRepointBlobs(db, client, referencedHashes);
        }
        await db.execute(
          `DELETE FROM blob_references
           WHERE owner_type = 'event' AND owner_id = ANY($1::text[])`,
          [affectedEvents.map((event) => event.id)],
          client,
        );
        for (const event of affectedEvents) {
          await insertBlobReference(
            db,
            event.org_id,
            event.id,
            "body",
            input.new_content_hash,
            now,
            client,
          );
          for (const blob of input.extra_blobs ?? []) {
            await insertBlobReference(
              db,
              event.org_id,
              event.id,
              "attachment",
              blob.content_hash,
              now,
              client,
            );
          }
        }
      }
      if (input.old_content_hash !== input.new_content_hash) {
        await db.execute(
          `
            UPDATE blobs SET unreferenced_at = $2
            WHERE content_hash = $1
              AND NOT EXISTS (
                SELECT 1 FROM blob_references r
                WHERE r.content_hash = blobs.content_hash
              )
          `,
          [input.old_content_hash, now],
          client,
        );
      }
      return updated;
    });
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

async function protectRepointBlobs(
  db: PgSql,
  client: PoolClient,
  referencedHashes: ReadonlySet<string>,
): Promise<void> {
  for (const hash of referencedHashes) {
    const updated = await db.execute(
      `UPDATE blobs SET state = 'protected', unreferenced_at = NULL
       WHERE content_hash = $1 AND state IN ('available', 'protected')
         AND write_claim_token IS NULL`,
      [hash],
      client,
    );
    if (updated !== 1) throw new BlobReservationConflictError(hash);
  }
}

async function insertBlobRow(db: PgSql, contentHash: string, mediaType: string | undefined, byteSize: number | undefined, createdAt: string, client: PoolClient): Promise<void> {
    await db.execute(
      `
        INSERT INTO blobs (
          content_hash, media_type, byte_size, created_at, state
        ) VALUES ($1, $2, $3, $4, 'protected')
        ON CONFLICT (content_hash) DO NOTHING
      `,
      [contentHash, mediaType ?? "application/octet-stream", byteSize ?? 0, createdAt],
      client,
    );
  }

export async function reserveBlobWrites(
  db: PgSql,
  input: ReserveBlobWritesInput,
): Promise<BlobReservation[]> {
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

  return db.withTx(async (client) => {
    const plans: BlobReservation[] = [];
    for (const blob of blobs) {
      let current = await db.queryOne<{
        state: "reserved" | "available" | "deleting" | "protected";
        generation: number;
        write_claim_token: string | null;
        lease_active: boolean;
      }>(
        `SELECT state, generation, write_claim_token,
                write_lease_expires_at > CURRENT_TIMESTAMP AS lease_active
         FROM blobs WHERE content_hash = $1 FOR UPDATE`,
        [blob.content_hash],
        client,
      );
      if (!current) {
        const token = randomUUID();
        await db.execute(
          `INSERT INTO blobs (
             content_hash, media_type, byte_size, created_at, state, generation,
             write_lease_owner, write_claim_token, write_lease_expires_at, unreferenced_at
           ) VALUES (
             $1, $2, $3, CURRENT_TIMESTAMP, 'reserved', 1, $4, $5,
             CURRENT_TIMESTAMP + ($6::double precision * INTERVAL '1 millisecond'),
             CURRENT_TIMESTAMP
           )
           ON CONFLICT (content_hash) DO NOTHING`,
          [
            blob.content_hash,
            blob.media_type,
            blob.byte_size,
            input.owner_id,
            token,
            input.lease_duration_ms,
          ],
          client,
        );
        current = await db.queryOne<{
          state: "reserved" | "available" | "deleting" | "protected";
          generation: number;
          write_claim_token: string | null;
          lease_active: boolean;
        }>(
          `SELECT state, generation, write_claim_token,
                  write_lease_expires_at > CURRENT_TIMESTAMP AS lease_active
           FROM blobs WHERE content_hash = $1 FOR UPDATE`,
          [blob.content_hash],
          client,
        );
        if (!current) throw new Error("Blob reservation row disappeared");
        if (current.write_claim_token !== token) {
          if (current.state === "deleting" || current.lease_active) {
            throw new BlobReservationConflictError(blob.content_hash);
          }
        } else {
          plans.push({
            content_hash: blob.content_hash,
            generation: asNumber(current.generation),
            mode: "write",
            claim_token: token,
          });
          continue;
        }
      }

      if (current.state === "deleting" || current.lease_active) {
        throw new BlobReservationConflictError(blob.content_hash);
      }

      const needsWrite = current.state === "reserved" || forceWrite.has(blob.content_hash);
      if (needsWrite) {
        const generation = asNumber(current.generation) + 1;
        const token = randomUUID();
        await db.execute(
          `UPDATE blobs
           SET state = CASE WHEN state = 'protected' THEN 'protected' ELSE 'reserved' END,
               generation = $2, write_lease_owner = $3, write_claim_token = $4,
               write_lease_expires_at = CURRENT_TIMESTAMP + ($5::double precision * INTERVAL '1 millisecond'),
               unreferenced_at = CASE WHEN state = 'protected' THEN unreferenced_at ELSE CURRENT_TIMESTAMP END
           WHERE content_hash = $1`,
          [
            blob.content_hash,
            generation,
            input.owner_id,
            token,
            input.lease_duration_ms,
          ],
          client,
        );
        plans.push({
          content_hash: blob.content_hash,
          generation,
          mode: "write",
          claim_token: token,
        });
      } else {
        if (current.write_claim_token !== null) {
          await db.execute(
            `UPDATE blobs SET write_lease_owner = NULL, write_claim_token = NULL,
               write_lease_expires_at = NULL WHERE content_hash = $1`,
            [blob.content_hash],
            client,
          );
        }
        plans.push({
          content_hash: blob.content_hash,
          generation: asNumber(current.generation),
          mode: "reuse",
        });
      }
    }
    return plans;
  });
}

export async function releaseBlobReservations(
  db: PgSql,
  reservations: readonly BlobReservation[],
): Promise<void> {
  await db.withTx(async (client) => {
    for (const reservation of reservations) {
      if (reservation.mode !== "write") continue;
      await db.execute(
        `UPDATE blobs SET write_lease_owner = NULL, write_claim_token = NULL,
           write_lease_expires_at = NULL,
           unreferenced_at = CASE
             WHEN state = 'protected' THEN unreferenced_at
             WHEN EXISTS (
               SELECT 1 FROM blob_references r WHERE r.content_hash = blobs.content_hash
             ) THEN NULL
             ELSE COALESCE(unreferenced_at, CURRENT_TIMESTAMP)
           END
         WHERE content_hash = $1 AND generation = $2 AND write_claim_token = $3`,
        [reservation.content_hash, reservation.generation, reservation.claim_token],
        client,
      );
    }
  });
}

export async function completeBlobReservations(
  db: PgSql,
  client: PoolClient,
  reservations: readonly BlobReservation[] | undefined,
  referencedHashes: ReadonlySet<string>,
): Promise<void> {
  const seen = new Set<string>();
  for (const reservation of reservations ?? []) {
    if (seen.has(reservation.content_hash)) {
      throw new Error("Blob reservations must contain unique hashes");
    }
    seen.add(reservation.content_hash);
    if (reservation.mode === "write") {
      if (!referencedHashes.has(reservation.content_hash)) {
        throw new Error("Blob write reservation is not referenced by the owner commit");
      }
      const updated = await db.execute(
        `UPDATE blobs
         SET state = CASE WHEN state = 'protected' THEN 'protected' ELSE 'available' END,
             write_lease_owner = NULL, write_claim_token = NULL,
             write_lease_expires_at = NULL, unreferenced_at = NULL
         WHERE content_hash = $1 AND generation = $2 AND write_claim_token = $3
           AND state IN ('reserved', 'protected')
           AND write_lease_expires_at > CURRENT_TIMESTAMP`,
        [reservation.content_hash, reservation.generation, reservation.claim_token],
        client,
      );
      if (updated !== 1) throw new BlobReservationConflictError(reservation.content_hash);
    } else {
      const updated = await db.execute(
        `UPDATE blobs SET unreferenced_at = NULL
         WHERE content_hash = $1 AND generation = $2
           AND state IN ('available', 'protected') AND write_claim_token IS NULL`,
        [reservation.content_hash, reservation.generation],
        client,
      );
      if (updated !== 1) throw new BlobReservationConflictError(reservation.content_hash);
    }
  }
}

async function insertBlobReference(
  db: PgSql,
  orgId: string,
  eventId: string,
  kind: "body" | "attachment",
  contentHash: string,
  createdAt: string,
  client: PoolClient,
): Promise<void> {
  const eligible = await db.execute(
    `UPDATE blobs SET unreferenced_at = NULL
     WHERE content_hash = $1 AND state IN ('available', 'protected')
       AND write_claim_token IS NULL`,
    [contentHash],
    client,
  );
  if (eligible !== 1) throw new BlobReservationConflictError(contentHash);
  await db.execute(
    `INSERT INTO blob_references (
       owner_org_id, owner_type, owner_id, reference_kind, content_hash, created_at
     ) VALUES ($1, 'event', $2, $3, $4, $5)
     ON CONFLICT DO NOTHING`,
    [orgId, eventId, kind, contentHash, createdAt],
    client,
  );
}

export async function commitIngestOn(
  db: PgSql,
  client: PoolClient,
  request: IngestCommitRequest,
  additionalConversations: readonly ConversationLockKey[] = [],
): Promise<EventRecord[]> {
    assertIngestDispositionBindings(request);
    if (
      request.appends.length === 0 &&
      request.dispositions.length === 0 &&
      additionalConversations.length === 0
    ) {
      return [];
    }
    await completeBlobReservations(
      db,
      client,
      request.blob_reservations,
      new Set(request.appends.flatMap((append) => [
        ...(append.content_hash ? [append.content_hash] : []),
        ...(append.extra_blobs ?? []).map((blob) => blob.content_hash),
      ])),
    );
    const appends = request.appends.map((append) => ({
      ...append,
      id: append.id ?? randomUUID(),
    }));
    const conversations: ConversationLockKey[] = [
      ...additionalConversations,
      ...appends.map((append) => ({
        org_id: append.org_id,
        thread_id: append.thread_id ?? conversationId(
          append.source,
          append.external_id,
          append.id,
        ),
      })),
    ];
    for (const append of appends) {
      const previous = await previousConversationLock(db, client, append.org_id, append.expected_head_id);
      if (previous) conversations.push(previous);
    }
    await lockConversationThreads(db, client, conversations);
    const events: EventRecord[] = [];
    for (const input of appends) {
      const operation = input.operation ?? "create";
      if (operation === "tombstone") {
        const current = await findCurrent(db, input, client);
        if ((current?.id ?? null) !== input.expected_head_id) {
          throw new AuthorityConflictError();
        }
        events.push(await insertWithinTransaction(db, {
          ...input,
          operation,
          content_hash: current?.content_hash ?? input.content_hash,
          parent_event_id: current?.id,
        }, client));
        continue;
      }
      events.push(
        await insertWithinTransaction(db, 
          {
            ...input,
            operation,
            ...(operation === "revise" && input.parent_event_id
              ? { parent_event_id: input.parent_event_id }
              : {}),
          },
          client,
        ),
      );
    }
    const eventsById = new Map(events.map((event) => [event.id, event]));
    const appendsByEventId = new Map(
      events.map((event, index) => [event.id, appends[index]]),
    );
    for (const decision of request.dispositions) {
      const event = eventsById.get(decision.event_id);
      if (!event) {
        throw new Error("Ingest disposition event was not created");
      }
      await persistIngestionDisposition(
        db,
        event,
        decision,
        appendsByEventId.get(event.id)?.parent_event_id,
        client,
      );
    }
    return events;
  }

export async function appendRevision(db: PgSql, input: EventRevision): Promise<EventRecord> {
    assertEventDispositionBinding(input);
    const eventInput = { ...input, id: input.id ?? randomUUID() };
    return db.withTx(async (client) => {
      const previous = await previousConversationLock(db, client, input.org_id, input.expected_head_id);
      await lockConversationThreads(db, client, [{
        org_id: input.org_id,
        thread_id: input.thread_id ?? conversationId(
          input.source,
          input.external_id,
          eventInput.id,
        ),
      }, ...(previous ? [previous] : [])]);
      await completeBlobReservations(
        db,
        client,
        input.blob_reservations,
        new Set([
          input.content_hash,
          ...(input.extra_blobs ?? []).map((blob) => blob.content_hash),
        ]),
      );
      const event = await insertWithinTransaction(db, { ...eventInput, operation: "revise" }, client);
      if (input.disposition) {
        await persistIngestionDisposition(
          db,
          event,
          input.disposition,
          input.parent_event_id,
          client,
        );
      }
      return event;
    });
  }

export async function markTombstone(db: PgSql, input: TombstoneEvent): Promise<EventRecord> {
    assertEventDispositionBinding(input);
    const eventInput = { ...input, id: input.id ?? randomUUID() };
    return db.withTx(async (client) => {
      const previous = await previousConversationLock(db, client, input.org_id, input.expected_head_id);
      await lockConversationThreads(db, client, [{
        org_id: input.org_id,
        thread_id: input.thread_id ?? conversationId(
          input.source,
          input.external_id,
          eventInput.id,
        ),
      }, ...(previous ? [previous] : [])]);
      const current = await findCurrent(db, input, client);
      if ((current?.id ?? null) !== input.expected_head_id) {
        throw new AuthorityConflictError();
      }
      const event = await insertWithinTransaction(db,
        {
          ...eventInput,
          operation: "tombstone",
          content_hash: current?.content_hash,
          parent_event_id: current?.id,
        },
        client,
      );
      if (input.disposition) {
        await persistIngestionDisposition(
          db,
          event,
          input.disposition,
          current?.id,
          client,
        );
      }
      return event;
    });
  }

async function findCurrent(db: PgSql, identity: SourceIdentity, client?: PoolClient): Promise<EventRecord | null> {
    const row = await db.queryOne<EventRow>(
      `
        SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
               e.content_hash, e.parent_event_id, e.thread_id, e.actor_id,
               e.required_scope_ids, e.direction_tags, e.weight_hints, e.attrs,
               e.occurred_at, e.ingested_at
        FROM source_heads h
        JOIN events e ON e.id = h.current_event_id
        WHERE h.org_id = $1 AND h.source = $2 AND h.external_id = $3
      `,
      [identity.org_id, identity.source, identity.external_id],
      client,
    );
    return row ? toEvent(db, row) : null;
  }

async function insert(db: PgSql, input: InsertEventInput): Promise<EventRecord> {
    const eventInput = { ...input, id: input.id ?? randomUUID() };
    return db.withTx(async (client) => {
      const previous = await previousConversationLock(db, client, input.org_id, input.expected_head_id);
      await lockConversationThreads(db, client, [{
        org_id: input.org_id,
        thread_id: input.thread_id ?? conversationId(
          input.source,
          input.external_id,
          eventInput.id,
        ),
      }, ...(previous ? [previous] : [])]);
      return insertWithinTransaction(db, eventInput, client);
    });
  }

async function previousConversationLock(
  db: PgSql, client: PoolClient, orgId: string, eventId: string | null | undefined,
): Promise<ConversationLockKey | undefined> {
  if (!eventId) return undefined;
  const event = await db.queryOne<{ source: string; external_id: string; thread_id: string | null }>(
    "SELECT source, external_id, thread_id FROM events WHERE org_id = $1 AND id = $2",
    [orgId, eventId], client,
  );
  return event ? {
    org_id: orgId,
    thread_id: event.thread_id ?? conversationId(event.source, event.external_id, eventId),
  } : undefined;
}

async function insertWithinTransaction(
  db: PgSql, input: InsertEventInput & { id: string }, client: PoolClient,
): Promise<EventRecord> {
    const event: EventRecord = {
      id: input.id,
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
      await insertBlobRow(db, 
        input.content_hash,
        input.content_media_type,
        input.content_byte_size,
        event.ingested_at,
        client,
      );
    }
    for (const blob of input.extra_blobs ?? []) {
      await insertBlobRow(db, 
        blob.content_hash,
        blob.media_type,
        blob.byte_size,
        event.ingested_at,
        client,
      );
    }

    await db.execute(
      `
        INSERT INTO events (
          id, org_id, source, external_id, operation, content_hash,
          parent_event_id, revision_id, occurred_at, ingested_at, thread_id,
          actor_id, required_scope_ids, direction_tags, weight_hints, attrs
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      `,
      [
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
        jsonb(event.required_scope_ids),
        jsonb(event.direction_tags),
        jsonb(event.weight_hints),
        jsonb(event.attrs),
      ],
      client,
    );
    const headUpdate =
      input.expected_head_id === null
        ? await db.execute(
            `
              INSERT INTO source_heads (
                org_id, source, external_id, current_event_id
              ) VALUES ($1, $2, $3, $4)
              ON CONFLICT (org_id, source, external_id) DO NOTHING
            `,
            [event.org_id, event.source, event.external_id, event.id],
            client,
          )
        : await db.execute(
            `
              UPDATE source_heads SET current_event_id = $1
              WHERE org_id = $2 AND source = $3 AND external_id = $4
                AND current_event_id = $5
            `,
            [
              event.id,
              event.org_id,
              event.source,
              event.external_id,
              input.expected_head_id,
            ],
            client,
          );
    if (headUpdate !== 1) {
      throw new AuthorityConflictError();
    }
    if (event.content_hash) {
      await insertBlobReference(
        db,
        event.org_id,
        event.id,
        "body",
        event.content_hash,
        event.ingested_at,
        client,
      );
    }
    for (const blob of input.extra_blobs ?? []) {
      await insertBlobReference(
        db,
        event.org_id,
        event.id,
        "attachment",
        blob.content_hash,
        event.ingested_at,
        client,
      );
    }
    await db.execute(
      `
        INSERT INTO context_projection_outbox (
          id, org_id, event_id, status, attempts, created_at, updated_at
        ) VALUES ($1, $2, $3, 'pending', 0, $4, $5)
      `,
      [
        `context-projection:${event.id}`,
        event.org_id,
        event.id,
        event.ingested_at,
        event.ingested_at,
      ],
      client,
    );
    const threadId = event.thread_id ?? conversationId(event.source, event.external_id, event.id);
    const previous = await previousConversationLock(db, client, event.org_id, input.expected_head_id);
    if (previous && previous.thread_id !== threadId) {
      await refreshThreadHeadWithinTransaction(db, event.org_id, previous.thread_id, client);
    }
    await refreshThreadHeadWithinTransaction(db, event.org_id, threadId, client);
    return event;
  }

async function persistIngestionDisposition(
  db: PgSql,
  event: EventRecord,
  decision: ArrangementDecision,
  previousEventId: string | undefined,
  client: PoolClient,
): Promise<void> {
  const saved = await putDispositionWithinTransaction(db, decision, client);
  const previous = previousEventId
    ? await db.queryOne<{ disposition: ArrangementDecision["disposition"] }>(
        `SELECT disposition FROM message_dispositions WHERE event_id = $1`,
        [previousEventId],
        client,
      )
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
    await unfoldCurrentWorkWithinTransaction(db, client, {
      org_id: event.org_id, thread_id: threadId, event_id: event.id,
      cause: "current_work_ingested", dedupe_id: event.id, now: event.ingested_at,
    });
  }
  await db.execute(`INSERT INTO conversation_lifecycle_events (
    id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
    event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
  ) VALUES ($1, $2, $3, 'source_event', $4, 1, 'current_work_changed', NULL, $5, 1, $6, $7, $8)`,
  [
    randomUUID(),
    event.org_id,
    threadId,
    event.id,
    JSON.stringify(["source_event", event.id, 1, "current_work_changed"]),
    jsonb({
      source: "ingestion",
      previous: previousEventId
        ? { event_id: previousEventId, disposition: previous?.disposition ?? null }
        : null,
      result: saved,
    }),
    decision.decided_at,
    event.ingested_at,
  ], client);
}

export function toEvent(db: PgSql, row: EventRow): EventRecord {
    const requiredScopeIds = row.required_scope_ids
      ? asJson<string[]>(row.required_scope_ids)
      : undefined;
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
      required_scope_ids: requiredScopeIds,
      direction_tags: row.direction_tags
        ? asJson<string[]>(row.direction_tags)
        : undefined,
      weight_hints: row.weight_hints
        ? asJson<NewEvent["weight_hints"]>(row.weight_hints)
        : undefined,
      attrs: row.attrs ? asJson<NewEvent["attrs"]>(row.attrs) : undefined,
      occurred_at: toIso(row.occurred_at),
      ingested_at: toIso(row.ingested_at),
    };
  }
