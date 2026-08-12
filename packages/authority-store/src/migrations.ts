export const LATEST_SCHEMA_VERSION = 2;

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
  {
    version: 2,
    sql: `
      CREATE TABLE connector_installations (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        connector_type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('enabled', 'disabled', 'needs_attention')
        ),
        config_json TEXT NOT NULL,
        credentials_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX connector_installations_org_idx
        ON connector_installations (org_id, connector_type);

      CREATE TABLE connector_cursors (
        installation_id TEXT NOT NULL REFERENCES connector_installations(id),
        stream_key TEXT NOT NULL,
        cursor_value TEXT,
        cursor_version INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (installation_id, stream_key)
      );

      CREATE TABLE ingest_attempts (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        connector_installation_id TEXT NOT NULL
          REFERENCES connector_installations(id),
        stream_key TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
        accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
        duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
        quarantined_count INTEGER NOT NULL DEFAULT 0 CHECK (quarantined_count >= 0),
        retryable_failure_count INTEGER NOT NULL DEFAULT 0
          CHECK (retryable_failure_count >= 0),
        error_code TEXT
      );

      CREATE INDEX ingest_attempts_installation_idx
        ON ingest_attempts (connector_installation_id, stream_key, started_at);

      CREATE TABLE ingest_quarantines (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES ingest_attempts(id),
        record_external_id TEXT NOT NULL,
        reason_code TEXT NOT NULL,
        safe_metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution TEXT
      );

      CREATE INDEX ingest_quarantines_attempt_idx
        ON ingest_quarantines (attempt_id, created_at);
    `,
  },
] as const;