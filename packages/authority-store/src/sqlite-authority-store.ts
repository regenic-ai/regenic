import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import {
  AuthorityConflictError,
  conversationId,
  formatInboxDigest,
  normalizeInboxLimit,
  threadExternalIdLike,
} from "@regenic/domain";
import type {
  ArrangementDecision,
  AuthorityStore,
  BlobRecord,
  ConnectorInstallation,
  ConversationPref,
  ConversationPrefPatch,
  InboxItem,
  InboxQuery,
  InboxSummary,
  ConnectorLease,
  ConnectorRuntimeStore,
  ConnectorStreamCursor,
  EventListQuery,
  EventRecord,
  EventRevision,
  IngestAttempt,
  IngestCommitRequest,
  IngestQuarantine,
  IngestOperation,
  NewConnectorInstallation,
  NewEvent,
  NewIngestAttempt,
  ResetConnectorCursor,
  ReleaseConnectorLease,
  SetConnectorInstallationConfig,
  SetConnectorInstallationStatus,
  SettleIngestAttempt,
  SourceIdentity,
  TombstoneEvent,
} from "@regenic/domain";
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations";

interface EventRow {
  id: string;
  org_id: string;
  source: string;
  external_id: string;
  operation: IngestOperation;
  content_hash: string | null;
  parent_event_id: string | null;
  occurred_at: string;
  ingested_at: string;
}

interface DispositionRow {
  event_id: string;
  org_id: string;
  disposition: ArrangementDecision["disposition"];
  layer: ArrangementDecision["layer"];
  reason_codes_json: string;
  score: number;
  decided_at: string;
}

interface InboxRow extends EventRow {
  event_id: string;
  disposition_org_id: string;
  disposition: ArrangementDecision["disposition"];
  layer: ArrangementDecision["layer"];
  reason_codes_json: string;
  score: number;
  decided_at: string;
}

interface BlobRow {
  content_hash: string;
  media_type: string;
  byte_size: number;
  created_at: string;
}

interface InstallationRow {
  id: string;
  org_id: string;
  connector_type: string;
  status: ConnectorInstallation["status"];
  config_json: string;
  credentials_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface CursorRow {
  installation_id: string;
  stream_key: string;
  cursor_value: string | null;
  cursor_version: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  updated_at: string;
}

interface AttemptRow {
  id: string;
  org_id: string;
  connector_installation_id: string;
  stream_key: string;
  delivery_id: string;
  started_at: string;
  finished_at: string | null;
  status: IngestAttempt["status"];
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
  retryable_failure_count: number;
  error_code: string | null;
}

interface QuarantineRow {
  id: string;
  attempt_id: string;
  connector_installation_id: string;
  stream_key: string;
  record_external_id: string;
  reason_code: IngestQuarantine["reason_code"];
  safe_metadata_json: string;
  created_at: string;
}

interface PrefRow {
  org_id: string;
  thread_id: string;
  title: string | null;
  pinned: number;
  updated_at: string;
}

const INBOX_COLUMNS = `
  d.event_id, d.org_id AS disposition_org_id, d.disposition, d.layer,
  d.reason_codes_json, d.score, d.decided_at,
  e.id, e.source, e.external_id, e.operation, e.content_hash,
  e.parent_event_id, e.occurred_at, e.ingested_at
`;

interface InsertEventInput extends SourceIdentity {
  id?: string;
  operation: IngestOperation;
  content_hash?: string;
  content_media_type?: string;
  content_byte_size?: number;
  parent_event_id?: string;
  revision_id?: string;
  occurred_at: string;
  expected_head_id: string | null;
}

export interface SqliteOpenOptions {
  readonly?: boolean;
}

export class SqliteAuthorityStore
  implements AuthorityStore, ConnectorRuntimeStore
{
  private readonly database: Database.Database;
  readonly readonly: boolean;

  constructor(path: string, options: SqliteOpenOptions = {}) {
    this.readonly = options.readonly === true;
    if (!this.readonly) {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.database = new Database(
      path,
      this.readonly ? { fileMustExist: true } : undefined,
    );
    try {
      this.database.pragma("busy_timeout = 5000");
      this.database.pragma("foreign_keys = ON");
      if (!this.readonly) {
        this.database.pragma("journal_mode = WAL");
      }
      this.database.function(
        "conversation_id",
        (source: string, externalId: string, fallbackId: string) =>
          conversationId(source, externalId, fallbackId),
      );
      if (this.readonly) {
        // Keep OS-level write access so WAL readers can update -shm and see
        // commits from the writer. query_only still blocks application writes.
        this.database.pragma("query_only = ON");
      } else {
        this.migrate();
      }
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  private assertWritable(): void {
    if (this.readonly) {
      throw new Error("Authority database is open read-only");
    }
  }

  async findBySourceIdentity(
    identity: SourceIdentity,
  ): Promise<EventRecord | null> {
    return this.findCurrent(identity);
  }

  async getEvent(orgId: string, eventId: string): Promise<EventRecord | null> {
    const row = this.database
      .prepare(
        `
          SELECT id, org_id, source, external_id, operation, content_hash,
                 parent_event_id, occurred_at, ingested_at
          FROM events WHERE org_id = ? AND id = ?
        `,
      )
      .get(orgId, eventId) as EventRow | undefined;
    return row ? this.toEvent(row) : null;
  }

  async listEvents(orgId: string, query?: EventListQuery): Promise<EventRecord[]> {
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
    const rows = this.database
      .prepare(
        `
          SELECT id, org_id, source, external_id, operation, content_hash,
                 parent_event_id, occurred_at, ingested_at
          FROM events WHERE ${clauses.join(" AND ")} ORDER BY sequence ASC
        `,
      )
      .all(...params) as EventRow[];
    return rows.map((row) => this.toEvent(row));
  }

  async putDisposition(decision: ArrangementDecision): Promise<void> {
    this.assertWritable();
    this.putDispositionWithinTransaction(decision);
  }

  private putDispositionWithinTransaction(decision: ArrangementDecision): void {
    this.database
      .prepare(
        `
          INSERT INTO message_dispositions (
            event_id, org_id, disposition, layer, reason_codes_json, score, decided_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(event_id) DO UPDATE SET
            org_id = excluded.org_id,
            disposition = excluded.disposition,
            layer = excluded.layer,
            reason_codes_json = excluded.reason_codes_json,
            score = excluded.score,
            decided_at = excluded.decided_at
        `,
      )
      .run(
        decision.event_id,
        decision.org_id,
        decision.disposition,
        decision.layer,
        JSON.stringify(decision.reason_codes),
        decision.score,
        decision.decided_at,
      );
  }

  async getDisposition(eventId: string): Promise<ArrangementDecision | null> {
    const row = this.database
      .prepare(
        `
          SELECT event_id, org_id, disposition, layer, reason_codes_json, score, decided_at
          FROM message_dispositions WHERE event_id = ?
        `,
      )
      .get(eventId) as DispositionRow | undefined;
    return row ? this.toDisposition(row) : null;
  }

  async listInbox(orgId: string, query?: InboxQuery): Promise<InboxItem[]> {
    if (query?.thread_ids && query.thread_ids.length === 0) {
      return [];
    }
    const { sql, params } = this.inboxSql(orgId, query);
    const rows = this.database.prepare(sql).all(...params) as InboxRow[];
    const items = rows.map((row) => this.toInboxItem(row));
    if (inboxUsesNewestFirst(query)) {
      items.reverse();
    }
    return items;
  }

  async summarizeInbox(orgId: string): Promise<InboxSummary> {
    const latest = this.database
      .prepare(
        `
          SELECT e.ingested_at AS latest_at, e.id AS latest_id
          FROM events e
          JOIN message_dispositions d ON d.event_id = e.id
          WHERE e.org_id = ?
            AND d.disposition = 'current_work'
            AND ${isCurrentHeadSql("e")}
          ORDER BY e.ingested_at DESC, e.id DESC
          LIMIT 1
        `,
      )
      .get(orgId) as { latest_at: string; latest_id: string } | undefined;
    const counted = this.database
      .prepare(
        `
          SELECT COUNT(*) AS count FROM (
            SELECT e.thread_id AS thread_id
            FROM events e
            JOIN message_dispositions d ON d.event_id = e.id
            WHERE e.org_id = ?
              AND ${isCurrentHeadSql("e")}
            GROUP BY e.thread_id
            HAVING
              SUM(CASE WHEN d.disposition = 'current_work' THEN 1 ELSE 0 END) > 0
              AND SUM(
                CASE
                  WHEN d.reason_codes_json LIKE '%thread_status%' THEN 0
                  ELSE 1
                END
              ) > 0
          )
        `,
      )
      .get(orgId) as { count: number };
    const prefs = this.database
      .prepare(
        `
          SELECT COUNT(*) AS pref_count,
                 COALESCE(MAX(updated_at), '') AS pref_updated_at
          FROM conversation_prefs WHERE org_id = ?
        `,
      )
      .get(orgId) as { pref_count: number; pref_updated_at: string };
    return {
      count: counted.count,
      digest: formatInboxDigest({
        count: counted.count,
        latest_at: latest?.latest_at ?? "",
        latest_id: latest?.latest_id ?? "",
        pref_count: prefs.pref_count,
        pref_updated_at: prefs.pref_updated_at,
      }),
    };
  }

  async listConversationPrefs(orgId: string): Promise<ConversationPref[]> {
    const rows = this.database
      .prepare(
        `
          SELECT org_id, thread_id, title, pinned, updated_at
          FROM conversation_prefs WHERE org_id = ?
          ORDER BY pinned DESC, updated_at DESC
        `,
      )
      .all(orgId) as PrefRow[];
    return rows.map((row) => this.toPref(row));
  }

  async getConversationPref(
    orgId: string,
    threadId: string,
  ): Promise<ConversationPref | null> {
    const row = this.database
      .prepare(
        `
          SELECT org_id, thread_id, title, pinned, updated_at
          FROM conversation_prefs WHERE org_id = ? AND thread_id = ?
        `,
      )
      .get(orgId, threadId) as PrefRow | undefined;
    return row ? this.toPref(row) : null;
  }

  async putConversationPref(
    input: ConversationPrefPatch,
  ): Promise<ConversationPref> {
    this.assertWritable();
    const transaction = this.database.transaction(() => {
      const current = this.database
        .prepare(
          `
            SELECT org_id, thread_id, title, pinned, updated_at
            FROM conversation_prefs WHERE org_id = ? AND thread_id = ?
          `,
        )
        .get(input.org_id, input.thread_id) as PrefRow | undefined;
      const next: ConversationPref = {
        org_id: input.org_id,
        thread_id: input.thread_id,
        title: input.title !== undefined ? input.title : (current?.title ?? null),
        pinned:
          input.pinned !== undefined
            ? input.pinned
            : Boolean(current?.pinned),
        updated_at: input.updated_at,
      };
      this.database
        .prepare(
          `
            INSERT INTO conversation_prefs (
              org_id, thread_id, title, pinned, updated_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(org_id, thread_id) DO UPDATE SET
              title = excluded.title,
              pinned = excluded.pinned,
              updated_at = excluded.updated_at
          `,
        )
        .run(
          next.org_id,
          next.thread_id,
          next.title,
          next.pinned ? 1 : 0,
          next.updated_at,
        );
      return next;
    });
    return transaction.immediate();
  }

  async findBlob(contentHash: string): Promise<BlobRecord | null> {
    return (await this.findBlobs([contentHash])).get(contentHash) ?? null;
  }

  async findBlobs(
    contentHashes: readonly string[],
  ): Promise<Map<string, BlobRecord>> {
    const unique = [
      ...new Set(contentHashes.filter((hash) => hash.length > 0)),
    ];
    const found = new Map<string, BlobRecord>();
    const chunkSize = 400;
    for (let offset = 0; offset < unique.length; offset += chunkSize) {
      const chunk = unique.slice(offset, offset + chunkSize);
      const rows = this.database
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

  async append(input: NewEvent): Promise<EventRecord> {
    this.assertWritable();
    return this.insert({ ...input, operation: "create" });
  }

  async commitIngest(request: IngestCommitRequest): Promise<EventRecord[]> {
    this.assertWritable();
    if (request.appends.length === 0 && request.dispositions.length === 0) {
      return [];
    }
    return this.database
      .transaction(() => {
        const events = request.appends.map((input) =>
          this.insertWithinTransaction({ ...input, operation: "create" }),
        );
        for (const decision of request.dispositions) {
          this.putDispositionWithinTransaction(decision);
        }
        return events;
      })
      .immediate();
  }

  async appendRevision(input: EventRevision): Promise<EventRecord> {
    this.assertWritable();
    return this.insert({ ...input, operation: "revise" });
  }

  async markTombstone(input: TombstoneEvent): Promise<EventRecord> {
    this.assertWritable();
    const transaction = this.database.transaction(() => {
      const current = this.findCurrent(input);
      return this.insertWithinTransaction({
        ...input,
        operation: "tombstone",
        content_hash: current?.content_hash,
        parent_event_id: current?.id,
      });
    });
    return transaction.immediate();
  }

  async createInstallation(
    input: NewConnectorInstallation,
  ): Promise<ConnectorInstallation> {
    this.assertWritable();
    const installation: ConnectorInstallation = {
      ...input,
      config: { ...input.config },
      updated_at: input.created_at,
    };
    this.database
      .prepare(
        `
          INSERT INTO connector_installations (
            id, org_id, connector_type, status, config_json, credentials_ref,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        installation.id,
        installation.org_id,
        installation.connector_type,
        installation.status,
        JSON.stringify(installation.config),
        installation.credentials_ref ?? null,
        installation.created_at,
        installation.updated_at,
      );
    return installation;
  }

  async findInstallation(id: string): Promise<ConnectorInstallation | null> {
    const row = this.database
      .prepare(
        `
          SELECT id, org_id, connector_type, status, config_json, credentials_ref,
                 created_at, updated_at
          FROM connector_installations WHERE id = ?
        `,
      )
      .get(id) as InstallationRow | undefined;
    return row ? this.toInstallation(row) : null;
  }

  async listInstallations(orgId: string): Promise<ConnectorInstallation[]> {
    const rows = this.database
      .prepare(
        `
          SELECT id, org_id, connector_type, status, config_json, credentials_ref,
                 created_at, updated_at
          FROM connector_installations WHERE org_id = ? ORDER BY created_at DESC
        `,
      )
      .all(orgId) as InstallationRow[];
    return rows.map((row) => this.toInstallation(row));
  }

  async setInstallationStatus(
    input: SetConnectorInstallationStatus,
  ): Promise<ConnectorInstallation | null> {
    this.assertWritable();
    const updated = this.database
      .prepare(
        `
          UPDATE connector_installations SET status = ?, updated_at = ?
          WHERE id = ? AND org_id = ?
        `,
      )
      .run(input.status, input.updated_at, input.id, input.org_id);
    return updated.changes === 1 ? this.findInstallation(input.id) : null;
  }

  async updateInstallationConfig(
    input: SetConnectorInstallationConfig,
  ): Promise<ConnectorInstallation | null> {
    this.assertWritable();
    const updated = this.database
      .prepare(
        `
          UPDATE connector_installations SET config_json = ?, updated_at = ?
          WHERE id = ? AND org_id = ?
        `,
      )
      .run(
        JSON.stringify(input.config),
        input.updated_at,
        input.id,
        input.org_id,
      );
    return updated.changes === 1 ? this.findInstallation(input.id) : null;
  }

  async deleteInstallation(id: string, orgId: string): Promise<boolean> {
    this.assertWritable();
    const removed = this.database.transaction(() => {
      const row = this.database
        .prepare(
          `SELECT id FROM connector_installations WHERE id = ? AND org_id = ?`,
        )
        .get(id, orgId) as { id: string } | undefined;
      if (!row) {
        return false;
      }
      this.database
        .prepare(
          `
            DELETE FROM ingest_quarantines
            WHERE attempt_id IN (
              SELECT id FROM ingest_attempts WHERE connector_installation_id = ?
            )
          `,
        )
        .run(id);
      this.database
        .prepare(`DELETE FROM ingest_attempts WHERE connector_installation_id = ?`)
        .run(id);
      this.database
        .prepare(`DELETE FROM connector_cursors WHERE installation_id = ?`)
        .run(id);
      this.database
        .prepare(`DELETE FROM connector_installations WHERE id = ? AND org_id = ?`)
        .run(id, orgId);
      return true;
    });
    return removed();
  }

  async acquireLease(input: {
    installation_id: string;
    stream_key: string;
    lease_owner: string;
    now: string;
    lease_duration_ms: number;
  }): Promise<ConnectorLease | null> {
    this.assertWritable();
    const transaction = this.database.transaction(() => {
      const installation = this.database
        .prepare(`SELECT status FROM connector_installations WHERE id = ?`)
        .get(input.installation_id) as
        | { status: ConnectorInstallation["status"] }
        | undefined;
      if (!installation || installation.status !== "enabled") {
        return null;
      }

      const current = this.findCursorRow(
        input.installation_id,
        input.stream_key,
      );
      if (
        current?.lease_expires_at &&
        current.lease_expires_at > input.now &&
        current.lease_owner !== input.lease_owner
      ) {
        return null;
      }

      const leaseExpiresAt = new Date(
        new Date(input.now).getTime() + input.lease_duration_ms,
      ).toISOString();
      if (current) {
        this.database
          .prepare(
            `
              UPDATE connector_cursors
              SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
              WHERE installation_id = ? AND stream_key = ?
            `,
          )
          .run(
            input.lease_owner,
            leaseExpiresAt,
            input.now,
            input.installation_id,
            input.stream_key,
          );
      } else {
        this.database
          .prepare(
            `
              INSERT INTO connector_cursors (
                installation_id, stream_key, cursor_value, cursor_version,
                lease_owner, lease_expires_at, updated_at
              ) VALUES (?, ?, NULL, 1, ?, ?, ?)
            `,
          )
          .run(
            input.installation_id,
            input.stream_key,
            input.lease_owner,
            leaseExpiresAt,
            input.now,
          );
      }
      return this.toLease(
        this.findCursorRow(input.installation_id, input.stream_key)!,
      );
    });
    return transaction.immediate();
  }

  async releaseLease(input: ReleaseConnectorLease): Promise<boolean> {
    this.assertWritable();
    const released = this.database
      .prepare(
        `
          UPDATE connector_cursors
          SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
          WHERE installation_id = ? AND stream_key = ? AND lease_owner = ?
        `,
      )
      .run(
        input.now,
        input.installation_id,
        input.stream_key,
        input.lease_owner,
      );
    return released.changes === 1;
  }

  async resetCursor(
    input: ResetConnectorCursor,
  ): Promise<ConnectorStreamCursor | null> {
    this.assertWritable();
    const transaction = this.database.transaction(() => {
      const cursor = this.findCursorRow(input.installation_id, input.stream_key);
      if (!cursor) {
        return null;
      }
      if (cursor.lease_expires_at && cursor.lease_expires_at > input.now) {
        throw new Error("Connector cursor is leased and cannot be reset");
      }
      this.database
        .prepare(
          `
            UPDATE connector_cursors
            SET cursor_value = NULL, cursor_version = ?, lease_owner = NULL,
                lease_expires_at = NULL, updated_at = ?
            WHERE installation_id = ? AND stream_key = ?
          `,
        )
        .run(
          cursor.cursor_version + 1,
          input.now,
          input.installation_id,
          input.stream_key,
        );
      return this.toCursor(this.findCursorRow(input.installation_id, input.stream_key)!);
    });
    return transaction.immediate();
  }

  async beginAttempt(input: NewIngestAttempt): Promise<IngestAttempt> {
    this.assertWritable();
    this.database
      .prepare(
        `
          INSERT INTO ingest_attempts (
            id, org_id, connector_installation_id, stream_key, delivery_id,
            started_at, status
          ) VALUES (?, ?, ?, ?, ?, ?, 'running')
        `,
      )
      .run(
        input.id,
        input.org_id,
        input.connector_installation_id,
        input.stream_key,
        input.delivery_id,
        input.started_at,
      );
    return this.findAttempt(input.id)!;
  }

  async settleAttempt(input: SettleIngestAttempt): Promise<IngestAttempt> {
    this.assertWritable();

    const transaction = this.database.transaction(() => {
      const cursor = this.findCursorRow(input.installation_id, input.stream_key);
      if (!cursor || cursor.lease_owner !== input.lease_owner) {
        throw new Error("Connector lease is not held by the attempt owner");
      }
      const status =
        input.retryable_failure_count === 0 ? "succeeded" : "failed";
      this.database
        .prepare(
          `
            UPDATE ingest_attempts
            SET finished_at = ?, status = ?, accepted_count = ?, duplicate_count = ?,
                quarantined_count = ?, retryable_failure_count = ?, error_code = ?
            WHERE id = ?
          `,
        )
        .run(
          input.finished_at,
          status,
          input.accepted_count,
          input.duplicate_count,
          input.quarantined_count,
          input.retryable_failure_count,
          input.error_code ?? null,
          input.attempt_id,
        );
      for (const quarantine of input.quarantines) {
        this.database
          .prepare(
            `
              INSERT INTO ingest_quarantines (
                id, attempt_id, record_external_id, reason_code,
                safe_metadata_json, created_at
              ) VALUES (?, ?, ?, ?, ?, ?)
            `,
          )
          .run(
            quarantine.id,
            input.attempt_id,
            quarantine.record_external_id,
            quarantine.reason_code,
            JSON.stringify(quarantine.safe_metadata),
            quarantine.created_at,
          );
      }
      const advancesCursor =
        input.retryable_failure_count === 0 && input.next_cursor !== undefined;
      this.database
        .prepare(
          `
            UPDATE connector_cursors
            SET cursor_value = ?, cursor_version = ?, lease_owner = NULL,
                lease_expires_at = NULL, updated_at = ?
            WHERE installation_id = ? AND stream_key = ?
          `,
        )
        .run(
          advancesCursor ? input.next_cursor : cursor.cursor_value,
          advancesCursor ? cursor.cursor_version + 1 : cursor.cursor_version,
          input.finished_at,
          input.installation_id,
          input.stream_key,
        );
      return this.findAttempt(input.attempt_id)!;
    });
    return transaction.immediate();
  }

  async listAttempts(installationId: string): Promise<IngestAttempt[]> {
    const rows = this.database
      .prepare(
        `
          SELECT id, org_id, connector_installation_id, stream_key, delivery_id,
                 started_at, finished_at, status, accepted_count, duplicate_count,
                 quarantined_count, retryable_failure_count, error_code
          FROM ingest_attempts
          WHERE connector_installation_id = ? ORDER BY started_at DESC
        `,
      )
      .all(installationId) as AttemptRow[];
    return rows.map((row) => this.toAttempt(row));
  }

  async listQuarantines(installationId: string): Promise<IngestQuarantine[]> {
    const rows = this.database
      .prepare(
        `
          SELECT q.id, q.attempt_id, a.connector_installation_id, a.stream_key,
                 q.record_external_id, q.reason_code, q.safe_metadata_json, q.created_at
          FROM ingest_quarantines q
          JOIN ingest_attempts a ON a.id = q.attempt_id
          WHERE a.connector_installation_id = ? ORDER BY q.created_at DESC
        `,
      )
      .all(installationId) as QuarantineRow[];
    return rows.map((row) => this.toQuarantine(row));
  }

  async getCursor(
    installationId: string,
    streamKey: string,
  ): Promise<ConnectorStreamCursor | null> {
    const row = this.findCursorRow(installationId, streamKey);
    return row ? this.toCursor(row) : null;
  }

  close(): void {
    this.database.close();
  }

  get schemaVersion(): number {
    return this.database.pragma("user_version", { simple: true }) as number;
  }

  private migrate(): void {
    const currentVersion = this.database.pragma("user_version", {
      simple: true,
    }) as number;
    if (currentVersion > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `Authority database schema ${currentVersion} is newer than supported ${LATEST_SCHEMA_VERSION}`,
      );
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) {
        continue;
      }
      const applyMigration = this.database.transaction(() => {
        const lockedVersion = this.database.pragma("user_version", {
          simple: true,
        }) as number;
        if (migration.version <= lockedVersion) {
          return;
        }
        this.database.exec(migration.sql);
        this.database.pragma(`user_version = ${migration.version}`);
      });
      applyMigration.immediate();
    }
  }

  private findCurrent(identity: SourceIdentity): EventRecord | null {
    const row = this.database
      .prepare(
        `
          SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
                 e.content_hash, e.parent_event_id, e.occurred_at, e.ingested_at
          FROM source_heads h
          JOIN events e ON e.id = h.current_event_id
          WHERE h.org_id = ? AND h.source = ? AND h.external_id = ?
        `,
      )
      .get(identity.org_id, identity.source, identity.external_id) as
      | EventRow
      | undefined;
    return row ? this.toEvent(row) : null;
  }

  private findCursorRow(
    installationId: string,
    streamKey: string,
  ): CursorRow | null {
    return (
      (this.database
        .prepare(
          `
            SELECT installation_id, stream_key, cursor_value, cursor_version,
                   lease_owner, lease_expires_at, updated_at
            FROM connector_cursors
            WHERE installation_id = ? AND stream_key = ?
          `,
        )
        .get(installationId, streamKey) as CursorRow | undefined) ?? null
    );
  }

  private findAttempt(id: string): IngestAttempt | null {
    const row = this.database
      .prepare(
        `
          SELECT id, org_id, connector_installation_id, stream_key, delivery_id,
                 started_at, finished_at, status, accepted_count, duplicate_count,
                 quarantined_count, retryable_failure_count, error_code
          FROM ingest_attempts WHERE id = ?
        `,
      )
      .get(id) as AttemptRow | undefined;
    return row ? this.toAttempt(row) : null;
  }

  private insert(input: InsertEventInput): EventRecord {
    return this.database.transaction(() =>
      this.insertWithinTransaction(input),
    ).immediate();
  }

  private insertWithinTransaction(input: InsertEventInput): EventRecord {
    const event: EventRecord = {
      id: input.id ?? randomUUID(),
      org_id: input.org_id,
      source: input.source,
      external_id: input.external_id,
      operation: input.operation,
      content_hash: input.content_hash,
      parent_event_id: input.parent_event_id,
      occurred_at: input.occurred_at,
      ingested_at: new Date().toISOString(),
    };

    if (input.content_hash) {
      this.database
        .prepare(
          `
            INSERT OR IGNORE INTO blobs (
              content_hash, media_type, byte_size, created_at
            ) VALUES (?, ?, ?, ?)
          `,
        )
        .run(
          input.content_hash,
          input.content_media_type,
          input.content_byte_size,
          event.ingested_at,
        );
    }

    this.database
      .prepare(
        `
          INSERT INTO events (
            id, org_id, source, external_id, operation, content_hash,
            parent_event_id, revision_id, occurred_at, ingested_at, thread_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        conversationId(event.source, event.external_id, event.id),
      );
    const headUpdate =
      input.expected_head_id === null
        ? this.database
            .prepare(
              `
                INSERT OR IGNORE INTO source_heads (
                  org_id, source, external_id, current_event_id
                ) VALUES (?, ?, ?, ?)
              `,
            )
            .run(event.org_id, event.source, event.external_id, event.id)
        : this.database
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
    return event;
  }

  private inboxSql(
    orgId: string,
    query?: InboxQuery,
  ): { sql: string; params: unknown[] } {
    if (query?.heads) {
      const visible = this.inboxClauses(orgId, query, "any");
      const current = this.inboxClauses(orgId, query, "current_work", {
        event: "e2",
        disposition: "d2",
      });
      return {
        sql: `
          SELECT * FROM (
            SELECT ${INBOX_COLUMNS},
              ROW_NUMBER() OVER (
                PARTITION BY e.thread_id
                ORDER BY e.occurred_at DESC, e.id DESC
              ) AS rn
            FROM message_dispositions d
            JOIN events e ON e.id = d.event_id
            WHERE ${visible.clauses.join(" AND ")}
              AND ${isCurrentHeadSql("e")}
              AND d.reason_codes_json NOT LIKE '%thread_status%'
              AND e.thread_id IN (
                SELECT e2.thread_id
                FROM message_dispositions d2
                JOIN events e2 ON e2.id = d2.event_id
                WHERE ${current.clauses.join(" AND ")}
                  AND ${isCurrentHeadSql("e2", "h2")}
              )
          ) ranked
          WHERE rn = 1
          ORDER BY occurred_at ASC, id ASC
        `,
        params: [...visible.params, ...current.params],
      };
    }
    if (query?.siblings) {
      const { clauses, params } = this.inboxClauses(orgId, query, "any");
      if (!query.source && !query.target && !query.thread_ids) {
        clauses.push(`e.thread_id IN (
          SELECT e2.thread_id
          FROM message_dispositions d2
          JOIN events e2 ON e2.id = d2.event_id
          WHERE d2.org_id = ? AND d2.disposition = 'current_work'
            AND ${isCurrentHeadSql("e2", "h2")}
        )`);
        params.push(orgId);
      }
      const tail = inboxTail(query);
      return {
        sql: `
          SELECT ${INBOX_COLUMNS}
          FROM message_dispositions d
          JOIN events e ON e.id = d.event_id
          WHERE ${clauses.join(" AND ")}
          ${tail.orderSql}
        `,
        params: [...params, ...tail.orderParams],
      };
    }
    const { clauses, params } = this.inboxClauses(orgId, query, "current_work");
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

  private inboxClauses(
    orgId: string,
    query: InboxQuery | undefined,
    disposition: "current_work" | "any",
    tables: { event?: string; disposition?: string } = {},
  ): { clauses: string[]; params: unknown[] } {
    const event = tables.event ?? "e";
    const decision = tables.disposition ?? "d";
    const clauses = [`${event}.org_id = ?`];
    const params: unknown[] = [orgId];
    if (disposition === "current_work") {
      clauses.push(`${decision}.disposition = 'current_work'`);
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

  private toInboxItem(row: InboxRow): InboxItem {
    return {
      decision: this.toDisposition({
        event_id: row.event_id,
        org_id: row.disposition_org_id,
        disposition: row.disposition,
        layer: row.layer,
        reason_codes_json: row.reason_codes_json,
        score: row.score,
        decided_at: row.decided_at,
      }),
      event: this.toEvent({
        id: row.id,
        org_id: row.disposition_org_id,
        source: row.source,
        external_id: row.external_id,
        operation: row.operation,
        content_hash: row.content_hash,
        parent_event_id: row.parent_event_id,
        occurred_at: row.occurred_at,
        ingested_at: row.ingested_at,
      }),
    };
  }

  private toEvent(row: EventRow): EventRecord {
    return {
      id: row.id,
      org_id: row.org_id,
      source: row.source,
      external_id: row.external_id,
      operation: row.operation,
      content_hash: row.content_hash ?? undefined,
      parent_event_id: row.parent_event_id ?? undefined,
      occurred_at: row.occurred_at,
      ingested_at: row.ingested_at,
    };
  }

  private toPref(row: PrefRow): ConversationPref {
    return {
      org_id: row.org_id,
      thread_id: row.thread_id,
      title: row.title,
      pinned: row.pinned === 1,
      updated_at: row.updated_at,
    };
  }

  private toDisposition(row: DispositionRow): ArrangementDecision {
    return {
      event_id: row.event_id,
      org_id: row.org_id,
      disposition: row.disposition,
      layer: row.layer,
      reason_codes: JSON.parse(row.reason_codes_json) as string[],
      score: row.score,
      decided_at: row.decided_at,
    };
  }

  private toInstallation(row: InstallationRow): ConnectorInstallation {
    return {
      id: row.id,
      org_id: row.org_id,
      connector_type: row.connector_type,
      status: row.status,
      config: JSON.parse(row.config_json) as ConnectorInstallation["config"],
      credentials_ref: row.credentials_ref ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private toCursor(row: CursorRow): ConnectorStreamCursor {
    return {
      installation_id: row.installation_id,
      stream_key: row.stream_key,
      cursor: row.cursor_value ?? undefined,
      cursor_version: row.cursor_version,
      updated_at: row.updated_at,
    };
  }

  private toLease(row: CursorRow): ConnectorLease {
    return {
      ...this.toCursor(row),
      lease_owner: row.lease_owner!,
      lease_expires_at: row.lease_expires_at!,
    };
  }

  private toAttempt(row: AttemptRow): IngestAttempt {
    return {
      id: row.id,
      org_id: row.org_id,
      connector_installation_id: row.connector_installation_id,
      stream_key: row.stream_key,
      delivery_id: row.delivery_id,
      started_at: row.started_at,
      finished_at: row.finished_at ?? undefined,
      status: row.status,
      accepted_count: row.accepted_count,
      duplicate_count: row.duplicate_count,
      quarantined_count: row.quarantined_count,
      retryable_failure_count: row.retryable_failure_count,
      error_code: row.error_code ?? undefined,
    };
  }

  private toQuarantine(row: QuarantineRow): IngestQuarantine {
    return {
      id: row.id,
      attempt_id: row.attempt_id,
      connector_installation_id: row.connector_installation_id,
      stream_key: row.stream_key,
      record_external_id: row.record_external_id,
      reason_code: row.reason_code,
      safe_metadata: JSON.parse(row.safe_metadata_json) as IngestQuarantine["safe_metadata"],
      created_at: row.created_at,
    };
  }
}

function inboxUsesNewestFirst(query?: InboxQuery): boolean {
  return Boolean(!query?.heads && normalizeInboxLimit(query?.limit));
}

function isCurrentHeadSql(event = "e", heads = "h"): string {
  return `EXISTS (
    SELECT 1 FROM source_heads ${heads}
    WHERE ${heads}.current_event_id = ${event}.id
  )`;
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