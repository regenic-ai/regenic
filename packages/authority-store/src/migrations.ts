export const LATEST_SCHEMA_VERSION = 1;

export const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE blobs (
        content_hash TEXT PRIMARY KEY,
        media_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
        created_at TEXT NOT NULL
      );

      CREATE TABLE events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        org_id TEXT NOT NULL,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('create', 'revise', 'tombstone')),
        content_hash TEXT REFERENCES blobs(content_hash),
        parent_event_id TEXT REFERENCES events(id),
        revision_id TEXT,
        occurred_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL
      );

      CREATE INDEX events_source_identity_idx
        ON events (org_id, source, external_id, sequence);
      CREATE INDEX events_content_hash_idx ON events (content_hash);

      CREATE TABLE source_heads (
        org_id TEXT NOT NULL,
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        current_event_id TEXT NOT NULL REFERENCES events(id),
        PRIMARY KEY (org_id, source, external_id)
      );
    `,
  },
] as const;