import type {
  IngestOperation,
  SourceIdentity,
  NewEvent,
  EventRecord,
  SourceIdentityAliasBind,
  OutboundAttemptRecord,
  OutboundAttemptPut,
  EventListQuery,
  ContextAuthorityRead,
  BlobRecord,
  RepointContentInput,
  IngestCommitRequest,
  EventRevision,
  TombstoneEvent,
} from "@regenic/domain";
import Database from "better-sqlite3";
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
  putDispositionWithinTransaction,
  refreshThreadHeadWithinTransaction,
} from "./inbox";

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
    
    const event = await getEvent(db, input.org_id, input.event_id);
    if (!event) {
      throw new Error(`Unknown event for identity alias: ${input.event_id}`);
    }
    const insert = db.prepare(
      `
        INSERT OR IGNORE INTO source_heads (
          org_id, source, external_id, current_event_id
        ) VALUES (?, ?, ?, ?)
      `,
    );
    const run = db.transaction(() => {
      for (const alias of input.aliases) {
        const externalId = alias.external_id.trim();
        if (!alias.source.trim() || !externalId) {
          continue;
        }
        insert.run(input.org_id, alias.source, externalId, input.event_id);
      }
    });
    run();
  }

export async function getOutboundAttempt(db: Database.Database, orgId: string, clientRequestId: string): Promise<OutboundAttemptRecord | null> {
    const row = db
      .prepare(
        `
          SELECT org_id, client_request_id, thread_id, event_id, status,
                 channel_message_ids_json, created_at, updated_at
          FROM outbound_attempts
          WHERE org_id = ? AND client_request_id = ?
        `,
      )
      .get(orgId, clientRequestId) as
      | {
          org_id: string;
          client_request_id: string;
          thread_id: string;
          event_id: string | null;
          status: "pending" | "accepted" | "sent" | "failed";
          channel_message_ids_json: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      org_id: row.org_id,
      client_request_id: row.client_request_id,
      thread_id: row.thread_id,
      ...(row.event_id ? { event_id: row.event_id } : {}),
      status: row.status,
      ...(row.channel_message_ids_json
        ? {
            channel_message_ids: JSON.parse(row.channel_message_ids_json) as string[],
          }
        : {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

export async function putOutboundAttempt(db: Database.Database, input: OutboundAttemptPut): Promise<OutboundAttemptRecord> {
    
    const previous = await getOutboundAttempt(db, 
      input.org_id,
      input.client_request_id,
    );
    const createdAt = previous?.created_at ?? input.now;
    db
      .prepare(
        `
          INSERT INTO outbound_attempts (
            org_id, client_request_id, thread_id, event_id, status,
            channel_message_ids_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(org_id, client_request_id) DO UPDATE SET
            thread_id = excluded.thread_id,
            event_id = excluded.event_id,
            status = excluded.status,
            channel_message_ids_json = excluded.channel_message_ids_json,
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
        createdAt,
        input.now,
      );
    return {
      org_id: input.org_id,
      client_request_id: input.client_request_id,
      thread_id: input.thread_id,
      ...(input.event_id ? { event_id: input.event_id } : {}),
      status: input.status,
      ...(input.channel_message_ids
        ? { channel_message_ids: [...input.channel_message_ids] }
        : {}),
      created_at: createdAt,
      updated_at: input.now,
    };
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
    const limit =
      typeof query?.limit === "number" &&
      Number.isInteger(query.limit) &&
      query.limit > 0
        ? query.limit
        : undefined;
    const rows = db
      .prepare(
        `
          SELECT id, org_id, source, external_id, operation, content_hash,
               parent_event_id, thread_id, actor_id, required_scope_ids_json,
               direction_tags_json, weight_hints_json, attrs_json,
               occurred_at, ingested_at
          FROM events WHERE ${clauses.join(" AND ")} ORDER BY sequence ASC
          ${limit === undefined ? "" : "LIMIT ?"}
        `,
      )
      .all(...(limit === undefined ? params : [...params, limit])) as EventRow[];
    return rows.map((row) => toEvent(db, row));
  }

export async function openContextRead(db: Database.Database, orgId: string): Promise<ContextAuthorityRead> {
    return openContextReadInternal(db, orgId);
  }

export async function openContextReadForThread(db: Database.Database, orgId: string, threadId: string): Promise<ContextAuthorityRead> {
    const scopedThreadId = threadId.trim();
    if (!scopedThreadId) {
      throw new Error("Context thread read requires a thread id");
    }
    return openContextReadInternal(db, orgId, scopedThreadId);
  }

async function openContextReadInternal(db: Database.Database, orgId: string, threadId?: string): Promise<ContextAuthorityRead> {
    const read = db.transaction(() => {
      const rows = db
        .prepare(
          threadId
            ? `
                 SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
                   e.content_hash, e.parent_event_id, e.thread_id, e.actor_id,
                   e.required_scope_ids_json, e.direction_tags_json, e.weight_hints_json, e.attrs_json,
                   e.occurred_at, e.ingested_at,
                   b.media_type AS content_media_type
                 FROM events e
                 LEFT JOIN blobs b ON b.content_hash = e.content_hash
                 WHERE e.org_id = ? AND e.thread_id = ?
                 ORDER BY e.sequence ASC
          `
            : `
                 SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
                   e.content_hash, e.parent_event_id, e.thread_id, e.actor_id,
                   e.required_scope_ids_json, e.direction_tags_json, e.weight_hints_json, e.attrs_json,
                   e.occurred_at, e.ingested_at,
                   b.media_type AS content_media_type
                 FROM events e
                 LEFT JOIN blobs b ON b.content_hash = e.content_hash
                 WHERE e.org_id = ?
                 ORDER BY e.sequence ASC
          `,
        )
        .all(...(threadId ? [orgId, threadId] : [orgId])) as ContextEventRow[];
      const lifecycleHeads = threadId
        ? (db
            .prepare(
              `
            SELECT sh.source, sh.external_id, sh.current_event_id AS head_event_id
            FROM source_heads sh
            WHERE sh.org_id = ?
              AND EXISTS (
                SELECT 1
                FROM events e
                WHERE e.org_id = sh.org_id
                  AND e.source = sh.source
                  AND e.external_id = sh.external_id
                  AND e.thread_id = ?
              )
            ORDER BY sh.source ASC, sh.external_id ASC
          `,
            )
            .all(orgId, threadId) as ContextAuthorityRead["lifecycle_heads"])
        : (db
            .prepare(
              `
            SELECT source, external_id, current_event_id AS head_event_id
            FROM source_heads
            WHERE org_id = ?
            ORDER BY source ASC, external_id ASC
          `,
            )
            .all(orgId) as ContextAuthorityRead["lifecycle_heads"]);
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
          ...(threadId ? { thread_id: threadId } : {}),
          events,
          lifecycle_heads: lifecycleHeads,
        })}`,
        recorded_at: recordedAt,
        events,
        lifecycle_heads: lifecycleHeads,
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

export async function append(db: Database.Database, input: NewEvent): Promise<EventRecord> {
    
    return insert(db, { ...input, operation: "create" });
  }

export async function repointContentHash(db: Database.Database, input: RepointContentInput): Promise<number> {
    
    return db.transaction(() => {
      const now = new Date().toISOString();
      const affectedEvents = db.prepare(
        `SELECT id, org_id FROM events WHERE content_hash = ? ORDER BY sequence`,
      ).all(input.old_content_hash) as Array<{ id: string; org_id: string }>;
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
      for (const event of affectedEvents) {
        enqueueContextProjection(db, event.id, event.org_id, now);
      }
      if (input.old_content_hash !== input.new_content_hash) {
        db
          .prepare(
            `
              DELETE FROM blobs
              WHERE content_hash = ?
                AND content_hash NOT IN (
                  SELECT content_hash FROM events WHERE content_hash IS NOT NULL
                )
            `,
          )
          .run(input.old_content_hash);
      }
      return updated.changes;
    }).immediate();
  }

function insertBlobRow(db: Database.Database, contentHash: string, mediaType: string | undefined, byteSize: number | undefined, createdAt: string): void {
    db
      .prepare(
        `
          INSERT OR IGNORE INTO blobs (
            content_hash, media_type, byte_size, created_at
          ) VALUES (?, ?, ?, ?)
        `,
      )
      .run(contentHash, mediaType ?? "application/octet-stream", byteSize ?? 0, createdAt);
  }

export function commitIngestUnlocked(db: Database.Database, request: IngestCommitRequest): EventRecord[] {
    if (request.appends.length === 0 && request.dispositions.length === 0) {
      return [];
    }
    const events = request.appends.map((input) =>
      insertWithinTransaction(db, { ...input, operation: "create" }),
    );
    for (const decision of request.dispositions) {
      putDispositionWithinTransaction(db, decision);
    }
    return events;
  }

export async function appendRevision(db: Database.Database, input: EventRevision): Promise<EventRecord> {
    
    return insert(db, { ...input, operation: "revise" });
  }

export async function markTombstone(db: Database.Database, input: TombstoneEvent): Promise<EventRecord> {
    
    const transaction = db.transaction(() => {
      const current = findCurrent(db, input);
      return insertWithinTransaction(db, {
        ...input,
        operation: "tombstone",
        content_hash: current?.content_hash,
        parent_event_id: current?.id,
      });
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
    enqueueContextProjection(db, event.id, event.org_id, event.ingested_at);
    refreshThreadHeadWithinTransaction(db, event.org_id, event.thread_id);
    return event;
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
