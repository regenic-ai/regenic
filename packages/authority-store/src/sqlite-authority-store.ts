import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { AuthorityConflictError } from "@regenic/domain";
import type {
  AuthorityStore,
  BlobRecord,
  ConnectorInstallation,
  ConnectorLease,
  ConnectorRuntimeStore,
  ConnectorStreamCursor,
  EventRecord,
  EventRevision,
  IngestAttempt,
  IngestQuarantine,
  IngestOperation,
  NewConnectorInstallation,
  NewEvent,
  NewIngestAttempt,
  ReleaseConnectorLease,
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

interface InsertEventInput extends SourceIdentity {
  operation: IngestOperation;
  content_hash?: string;
  content_media_type?: string;
  content_byte_size?: number;
  parent_event_id?: string;
  revision_id?: string;
  occurred_at: string;
  expected_head_id: string | null;
}

export class SqliteAuthorityStore
  implements AuthorityStore, ConnectorRuntimeStore
{
  private readonly database: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new Database(path);
    try {
      this.database.pragma("busy_timeout = 5000");
      this.database.pragma("foreign_keys = ON");
      this.database.pragma("journal_mode = WAL");
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  async findBySourceIdentity(
    identity: SourceIdentity,
  ): Promise<EventRecord | null> {
    return this.findCurrent(identity);
  }

  async listEvents(orgId: string): Promise<EventRecord[]> {
    const rows = this.database
      .prepare(
        `
          SELECT id, org_id, source, external_id, operation, content_hash,
                 parent_event_id, occurred_at, ingested_at
          FROM events WHERE org_id = ? ORDER BY sequence ASC
        `,
      )
      .all(orgId) as EventRow[];
    return rows.map((row) => this.toEvent(row));
  }

  async findBlob(contentHash: string): Promise<BlobRecord | null> {
    const row = this.database
      .prepare(
        `SELECT content_hash, media_type, byte_size, created_at
         FROM blobs WHERE content_hash = ?`,
      )
      .get(contentHash) as BlobRow | undefined;
    return row ?? null;
  }

  async append(input: NewEvent): Promise<EventRecord> {
    return this.insert({ ...input, operation: "create" });
  }

  async appendRevision(input: EventRevision): Promise<EventRecord> {
    return this.insert({ ...input, operation: "revise" });
  }

  async markTombstone(input: TombstoneEvent): Promise<EventRecord> {
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

  async acquireLease(input: {
    installation_id: string;
    stream_key: string;
    lease_owner: string;
    now: string;
    lease_duration_ms: number;
  }): Promise<ConnectorLease | null> {
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

  async beginAttempt(input: NewIngestAttempt): Promise<IngestAttempt> {
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
      id: randomUUID(),
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
            parent_event_id, revision_id, occurred_at, ingested_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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