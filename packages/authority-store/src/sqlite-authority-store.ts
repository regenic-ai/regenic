import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { AuthorityConflictError } from "@regenic/domain";
import type {
  AuthorityStore,
  BlobRecord,
  EventRecord,
  EventRevision,
  IngestOperation,
  NewEvent,
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

export class SqliteAuthorityStore implements AuthorityStore {
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
}