export const LATEST_SCHEMA_VERSION = 17;

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
  {
    version: 3,
    sql: `
      CREATE TABLE message_dispositions (
        event_id TEXT PRIMARY KEY REFERENCES events(id),
        org_id TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (
          disposition IN ('current_work', 'outside_current_work', 'pending')
        ),
        layer TEXT NOT NULL CHECK (layer IN ('L1_event')),
        reason_codes_json TEXT NOT NULL,
        score REAL NOT NULL,
        decided_at TEXT NOT NULL
      );

      CREATE INDEX message_dispositions_inbox_idx
        ON message_dispositions (org_id, disposition, decided_at);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE conversation_prefs (
        org_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        title TEXT,
        pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
        updated_at TEXT NOT NULL,
        PRIMARY KEY (org_id, thread_id)
      );

      CREATE INDEX conversation_prefs_org_idx
        ON conversation_prefs (org_id, pinned, updated_at);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE INDEX events_org_ingested_idx
        ON events (org_id, ingested_at, id);
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE events ADD COLUMN thread_id TEXT;

      UPDATE events
      SET thread_id = conversation_id(source, external_id, id)
      WHERE thread_id IS NULL OR thread_id = '';

      CREATE INDEX events_org_thread_occurred_idx
        ON events (org_id, thread_id, occurred_at, id);
    `,
  },
  {
    version: 7,
    sql: `
      CREATE INDEX source_heads_current_event_idx
        ON source_heads (current_event_id);
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE conversation_prefs ADD COLUMN last_read_at TEXT;
      ALTER TABLE conversation_prefs ADD COLUMN last_read_external_id TEXT;
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE recipes (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        name TEXT NOT NULL,
        match_json TEXT NOT NULL,
        executor_type TEXT NOT NULL,
        executor_config_json TEXT NOT NULL,
        can_write_back INTEGER NOT NULL DEFAULT 0 CHECK (can_write_back IN (0, 1)),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX recipes_org_idx ON recipes (org_id, updated_at);

      CREATE TABLE work_items (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        head_event_id TEXT REFERENCES events(id),
        record_class TEXT NOT NULL,
        thread_facet TEXT NOT NULL,
        status TEXT NOT NULL,
        recipe_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (org_id, thread_id)
      );

      CREATE INDEX work_items_org_status_idx ON work_items (org_id, status, updated_at);

      CREATE TABLE work_runs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL REFERENCES work_items(id),
        recipe_id TEXT NOT NULL,
        executor_type TEXT NOT NULL,
        external_run_id TEXT,
        agent_thread_id TEXT,
        status TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX work_runs_item_idx ON work_runs (org_id, work_item_id, updated_at);

      CREATE TABLE ui_prefs (
        org_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (org_id, key)
      );
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE work_items_v10 (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        unit_key TEXT NOT NULL,
        head_event_id TEXT REFERENCES events(id),
        record_class TEXT NOT NULL,
        thread_facet TEXT NOT NULL,
        status TEXT NOT NULL,
        recipe_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (org_id, thread_id, unit_key)
      );

      INSERT INTO work_items_v10 (
        id, org_id, thread_id, unit_key, head_event_id, record_class,
        thread_facet, status, recipe_id, created_at, updated_at
      )
      SELECT
        id, org_id, thread_id, COALESCE(head_event_id, id), head_event_id,
        record_class, thread_facet, status, recipe_id, created_at, updated_at
      FROM work_items;

      DROP TABLE work_items;
      ALTER TABLE work_items_v10 RENAME TO work_items;

      CREATE INDEX work_items_org_status_idx ON work_items (org_id, status, updated_at);
      CREATE INDEX work_items_session_idx ON work_items (org_id, thread_id, updated_at);
    `,
  },
  {
    version: 11,
    sql: `
      ALTER TABLE recipes ADD COLUMN include_context INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 12,
    sql: `
      CREATE TABLE executor_installations (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('local_connector', 'http')),
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX executor_installations_org_idx
        ON executor_installations (org_id, updated_at);
    `,
  },
  {
    version: 13,
    sql: `
      ALTER TABLE recipes ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'push';
      ALTER TABLE recipes ADD COLUMN trigger_interval_ms INTEGER;
      ALTER TABLE recipes ADD COLUMN trigger_coalesce INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    version: 14,
    sql: `
      CREATE TABLE work_deliveries (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL REFERENCES work_items(id),
        recipe_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        unit_key TEXT NOT NULL,
        event_id TEXT,
        status TEXT NOT NULL,
        write_back TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_retry_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (org_id, work_item_id)
      );

      CREATE INDEX work_deliveries_org_status_idx
        ON work_deliveries (org_id, status, next_retry_at);
    `,
  },
  {
    version: 15,
    sql: `
      ALTER TABLE work_deliveries ADD COLUMN payload_json TEXT;
      ALTER TABLE work_deliveries ADD COLUMN lease_expires_at TEXT;
    `,
  },
  {
    version: 16,
    sql: `
      ALTER TABLE recipes ADD COLUMN next_run_at TEXT;
      ALTER TABLE work_deliveries ADD COLUMN idempotency_key TEXT;
      ALTER TABLE work_deliveries ADD COLUMN channel_receipt_json TEXT;
    `,
  },
  {
    version: 17,
    sql: `
      CREATE INDEX ingest_attempts_installation_started_idx
        ON ingest_attempts (connector_installation_id, started_at DESC, id DESC);
    `,
  },
] as const;
