import type {
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
  BlobRecord,
  RepointContentInput,
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
  AuthorityConflictError,
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
      for (const alias of input.aliases) {
        const externalId = alias.external_id.trim();
        if (!alias.source.trim() || !externalId) {
          continue;
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
    return await db.execute(`
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
    ]) === 1;
  }

export async function putOutboundAttempt(db: PgSql, input: OutboundAttemptPut): Promise<OutboundAttemptRecord> {
    const previous = await getOutboundAttempt(db, 
      input.org_id,
      input.client_request_id,
    );
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
    );
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
    const rows = await db.query<EventRow>(
      `
        SELECT id, org_id, source, external_id, operation, content_hash,
               parent_event_id, thread_id, actor_id, required_scope_ids,
               direction_tags, weight_hints, attrs,
               occurred_at, ingested_at
        FROM events WHERE ${clauses.join(" AND ")} ORDER BY sequence ${order}
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

export async function append(db: PgSql, input: NewEvent): Promise<EventRecord> {
    return insert(db, { ...input, operation: "create" });
  }

export async function repointContentHash(db: PgSql, input: RepointContentInput): Promise<number> {
    return db.withTx(async (client) => {
      const now = new Date().toISOString();
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
      if (input.old_content_hash !== input.new_content_hash) {
        await db.execute(
          `
            DELETE FROM blobs
            WHERE content_hash = $1
              AND content_hash NOT IN (
                SELECT content_hash FROM events WHERE content_hash IS NOT NULL
              )
          `,
          [input.old_content_hash],
          client,
        );
      }
      return updated;
    });
  }

async function insertBlobRow(db: PgSql, contentHash: string, mediaType: string | undefined, byteSize: number | undefined, createdAt: string, client: PoolClient): Promise<void> {
    await db.execute(
      `
        INSERT INTO blobs (
          content_hash, media_type, byte_size, created_at
        ) VALUES ($1, $2, $3, $4)
        ON CONFLICT (content_hash) DO NOTHING
      `,
      [contentHash, mediaType ?? "application/octet-stream", byteSize ?? 0, createdAt],
      client,
    );
  }

export async function commitIngestOn(db: PgSql, client: PoolClient, request: IngestCommitRequest): Promise<EventRecord[]> {
    if (request.appends.length === 0 && request.dispositions.length === 0) {
      return [];
    }
    const events: EventRecord[] = [];
    for (const input of request.appends) {
      events.push(
        await insertWithinTransaction(db, 
          { ...input, operation: "create" },
          client,
        ),
      );
    }
    for (const decision of request.dispositions) {
      await putDispositionWithinTransaction(db, decision, client);
    }
    return events;
  }

export async function appendRevision(db: PgSql, input: EventRevision): Promise<EventRecord> {
    return insert(db, { ...input, operation: "revise" });
  }

export async function markTombstone(db: PgSql, input: TombstoneEvent): Promise<EventRecord> {
    return db.withTx(async (client) => {
      const current = await findCurrent(db, input, client);
      return insertWithinTransaction(db, 
        {
          ...input,
          operation: "tombstone",
          content_hash: current?.content_hash,
          parent_event_id: current?.id,
        },
        client,
      );
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
    return db.withTx((client) => insertWithinTransaction(db, input, client));
  }

async function insertWithinTransaction(db: PgSql, input: InsertEventInput, client: PoolClient): Promise<EventRecord> {
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
    await refreshThreadHeadWithinTransaction(db, 
      event.org_id,
      event.thread_id,
      client,
    );
    return event;
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
