export const LATEST_SCHEMA_VERSION = 86;

export const PRE_MERGE_LIFECYCLE_REPAIR_SQL = `
  ALTER TABLE work_items ADD COLUMN current_run_id TEXT REFERENCES work_runs(id);
  ALTER TABLE work_items ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0);
  ALTER TABLE work_runs ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0);
  ALTER TABLE work_runs ADD COLUMN trigger_kind TEXT CHECK (trigger_kind IN ('push', 'pull', 'manual'));
  ALTER TABLE work_runs ADD COLUMN write_back_required INTEGER CHECK (write_back_required IN (0, 1));
  ALTER TABLE work_runs ADD COLUMN write_back_target_json TEXT CHECK (write_back_target_json IS NULL OR json_valid(write_back_target_json));
  CREATE UNIQUE INDEX work_runs_org_id_idx ON work_runs (org_id, id);
  CREATE TABLE work_deliveries_repaired (
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
    payload_json TEXT,
    lease_expires_at TEXT,
    idempotency_key TEXT,
    channel_receipt_json TEXT,
    run_id TEXT,
    target_json TEXT CHECK (target_json IS NULL OR json_valid(target_json)),
    lease_owner TEXT,
    claim_token TEXT,
    cancel_requested_at TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    FOREIGN KEY (org_id, run_id) REFERENCES work_runs(org_id, id)
  );
  INSERT INTO work_deliveries_repaired (
    id, org_id, work_item_id, recipe_id, kind, unit_key, event_id,
    status, write_back, attempts, last_error, next_retry_at, created_at, updated_at,
    payload_json, lease_expires_at, idempotency_key, channel_receipt_json,
    lease_owner, claim_token, cancel_requested_at, version
  ) SELECT
    id, org_id, work_item_id, recipe_id, kind, unit_key, event_id,
    status, write_back, attempts, last_error, next_retry_at, created_at, updated_at,
    payload_json, lease_expires_at, idempotency_key, channel_receipt_json,
    lease_owner, claim_token, cancel_requested_at, version
  FROM work_deliveries;
  DROP TABLE work_deliveries;
  ALTER TABLE work_deliveries_repaired RENAME TO work_deliveries;
  CREATE UNIQUE INDEX work_deliveries_run_idx ON work_deliveries (org_id, run_id) WHERE run_id IS NOT NULL;
  CREATE UNIQUE INDEX work_deliveries_legacy_item_idx ON work_deliveries (org_id, work_item_id) WHERE run_id IS NULL;
  CREATE INDEX work_deliveries_item_idx ON work_deliveries (org_id, work_item_id, created_at, id);
  CREATE INDEX work_deliveries_org_status_idx ON work_deliveries (org_id, status, next_retry_at);
`;

export const RECIPE_DESTINATION_COLUMN_SQL =
  "ALTER TABLE recipes ADD COLUMN write_back_thread_id TEXT";

export const CUSTOMER_SERVICE_TASKS_SQL = `
  CREATE TABLE IF NOT EXISTS customer_service_tasks (
    id TEXT NOT NULL,
    org_id TEXT NOT NULL,
    status TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, id)
  );
  CREATE INDEX IF NOT EXISTS customer_service_tasks_status_idx
    ON customer_service_tasks (org_id, status, updated_at DESC, id DESC);
`;

export const RECIPE_CLOCK_COLUMN_SQL = [
  "ALTER TABLE recipes ADD COLUMN trigger_at_minute INTEGER",
  "ALTER TABLE recipes ADD COLUMN trigger_weekdays TEXT",
  "ALTER TABLE recipes ADD COLUMN trigger_timezone TEXT",
] as const;

const RUN_DELIVERY_LEDGER_SQL = `
      ALTER TABLE work_runs ADD COLUMN trigger_kind TEXT CHECK (trigger_kind IN ('push', 'pull', 'manual'));
      ALTER TABLE work_runs ADD COLUMN write_back_required INTEGER CHECK (write_back_required IN (0, 1));
      ALTER TABLE work_runs ADD COLUMN write_back_target_json TEXT CHECK (write_back_target_json IS NULL OR json_valid(write_back_target_json));
      CREATE UNIQUE INDEX work_runs_org_id_idx ON work_runs (org_id, id);
      CREATE TABLE work_deliveries_v58 (
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
        payload_json TEXT,
        lease_expires_at TEXT,
        idempotency_key TEXT,
        channel_receipt_json TEXT,
        run_id TEXT,
        target_json TEXT CHECK (target_json IS NULL OR json_valid(target_json)),
        FOREIGN KEY (org_id, run_id) REFERENCES work_runs(org_id, id)
      );
      INSERT INTO work_deliveries_v58 (
        id, org_id, work_item_id, recipe_id, kind, unit_key, event_id,
        status, write_back, attempts, last_error, next_retry_at, created_at, updated_at,
        payload_json, lease_expires_at, idempotency_key, channel_receipt_json
      ) SELECT id, org_id, work_item_id, recipe_id, kind, unit_key, event_id,
        status, write_back, attempts, last_error, next_retry_at, created_at, updated_at,
        payload_json, lease_expires_at, idempotency_key, channel_receipt_json FROM work_deliveries;
      DROP TABLE work_deliveries;
      ALTER TABLE work_deliveries_v58 RENAME TO work_deliveries;
      CREATE UNIQUE INDEX work_deliveries_run_idx ON work_deliveries (org_id, run_id) WHERE run_id IS NOT NULL;
      CREATE UNIQUE INDEX work_deliveries_legacy_item_idx ON work_deliveries (org_id, work_item_id) WHERE run_id IS NULL;
      CREATE INDEX work_deliveries_item_idx ON work_deliveries (org_id, work_item_id, created_at, id);
      CREATE INDEX work_deliveries_org_status_idx ON work_deliveries (org_id, status, next_retry_at);
`;

export const OUTBOUND_REJECTION_MIGRATION_SQL = `
  CREATE TABLE outbound_attempts_next (
    org_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    event_id TEXT REFERENCES events(id),
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'accepted', 'sent', 'failed', 'rejected')
    ),
    channel_message_ids_json TEXT,
    recovery_hash TEXT,
    receipt_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (org_id, client_request_id)
  );
  INSERT INTO outbound_attempts_next (
    org_id, client_request_id, thread_id, event_id, status,
    channel_message_ids_json, recovery_hash, receipt_json, created_at, updated_at
  )
  SELECT org_id, client_request_id, thread_id, event_id, status,
    channel_message_ids_json, recovery_hash, receipt_json, created_at, updated_at
  FROM outbound_attempts;
  DROP TABLE outbound_attempts;
  ALTER TABLE outbound_attempts_next RENAME TO outbound_attempts;
  CREATE INDEX outbound_attempts_event_idx ON outbound_attempts (event_id);
`;

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
  {
    version: 18,
    sql: `
      ALTER TABLE conversation_prefs ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE conversation_prefs ADD COLUMN hidden_reason TEXT;
      CREATE INDEX conversation_prefs_hidden_idx
        ON conversation_prefs (org_id, hidden);
    `,
  },
  {
    version: 19,
    sql: `
      CREATE TABLE connector_stream_members (
        installation_id TEXT NOT NULL REFERENCES connector_installations(id),
        stream_key TEXT NOT NULL,
        thread_id TEXT,
        label TEXT,
        kind TEXT,
        generation INTEGER NOT NULL,
        discovered_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        PRIMARY KEY (installation_id, stream_key)
      );

      CREATE INDEX connector_stream_members_generation_idx
        ON connector_stream_members (installation_id, generation);

      CREATE TABLE connector_catalog_cursors (
        installation_id TEXT NOT NULL REFERENCES connector_installations(id),
        cursor_value TEXT,
        complete INTEGER NOT NULL DEFAULT 0 CHECK (complete IN (0, 1)),
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (installation_id)
      );

      CREATE TABLE connector_sync_state (
        installation_id TEXT NOT NULL REFERENCES connector_installations(id),
        stream_key TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (
          phase IN ('unseeded', 'live', 'history', 'steady')
        ),
        live_cursor TEXT,
        history_cursor TEXT,
        media_pending INTEGER NOT NULL DEFAULT 0 CHECK (media_pending IN (0, 1)),
        idle_until TEXT,
        generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (installation_id, stream_key)
      );
    `,
  },
  {
    version: 20,
    sql: `
      CREATE TABLE context_artifacts (
        org_id TEXT NOT NULL,
        id TEXT NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        generation TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (org_id, id)
      );

      CREATE INDEX context_artifacts_query_idx
        ON context_artifacts (org_id, kind, status, generation, recorded_at, id);

      CREATE TABLE context_snapshots (
        org_id TEXT NOT NULL,
        id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (org_id, id)
      );

      CREATE TABLE context_bundles (
        org_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        principal_actor_type TEXT NOT NULL,
        principal_actor_id TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (
          org_id,
          snapshot_id,
          principal_actor_type,
          principal_actor_id,
          consumer_id
        )
      );

      CREATE TABLE context_projection_checkpoints (
        org_id TEXT NOT NULL,
        projector_id TEXT NOT NULL,
        generation TEXT NOT NULL,
        algorithm_version TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence >= 0),
        watermark TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (org_id, projector_id, generation)
      );
    `,
  },
  {
    version: 21,
    sql: `
      ALTER TABLE events ADD COLUMN actor_id TEXT;
      ALTER TABLE events ADD COLUMN required_scope_ids_json TEXT
        CHECK (
          required_scope_ids_json IS NULL OR
          json_valid(required_scope_ids_json)
        );
    `,
  },
  {
    version: 22,
    sql: `
      CREATE TABLE context_projection_outbox (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_owner TEXT,
        lease_expires_at TEXT,
        next_retry_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX context_projection_outbox_due_idx
        ON context_projection_outbox (status, next_retry_at, lease_expires_at, created_at);
      CREATE INDEX context_projection_outbox_org_idx
        ON context_projection_outbox (org_id, created_at, id);
    `,
  },
  {
    version: 23,
    sql: `
      CREATE TABLE outbound_attempts (
        org_id TEXT NOT NULL,
        client_request_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        event_id TEXT REFERENCES events(id),
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'accepted', 'sent', 'failed')
        ),
        channel_message_ids_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (org_id, client_request_id)
      );

      CREATE INDEX outbound_attempts_event_idx
        ON outbound_attempts (event_id);
    `,
  },
  {
    version: 24,
    sql: `
      ALTER TABLE recipes ADD COLUMN max_concurrent INTEGER;
    `,
  },
  {
    version: 25,
    sql: `
      CREATE TABLE thread_heads (
        org_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        face_event_id TEXT NOT NULL REFERENCES events(id),
        face_occurred_at TEXT NOT NULL,
        has_current_work INTEGER NOT NULL CHECK (has_current_work IN (0, 1)),
        PRIMARY KEY (org_id, thread_id)
      );

      CREATE INDEX thread_heads_org_face_idx
        ON thread_heads (org_id, has_current_work, face_occurred_at DESC, face_event_id DESC);

      INSERT INTO thread_heads (
        org_id, thread_id, face_event_id, face_occurred_at, has_current_work
      )
      SELECT
        org_id,
        thread_id,
        id,
        occurred_at,
        CASE WHEN has_work = 1 THEN 1 ELSE 0 END
      FROM (
        SELECT
          e.org_id AS org_id,
          e.thread_id AS thread_id,
          e.id AS id,
          e.occurred_at AS occurred_at,
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM message_dispositions d2
              JOIN events e2 ON e2.id = d2.event_id
              WHERE d2.disposition = 'current_work'
                AND e2.org_id = e.org_id
                AND e2.thread_id = e.thread_id
                AND EXISTS (
                  SELECT 1 FROM source_heads h2 WHERE h2.current_event_id = e2.id
                )
            ) THEN 1
            ELSE 0
          END AS has_work,
          ROW_NUMBER() OVER (
            PARTITION BY e.org_id, e.thread_id
            ORDER BY e.occurred_at DESC, e.id DESC
          ) AS rn
        FROM message_dispositions d
        JOIN events e ON e.id = d.event_id
        WHERE e.thread_id IS NOT NULL
          AND e.thread_id != ''
          AND e.operation != 'tombstone'
          AND d.reason_codes_json NOT LIKE '%thread_status%'
          AND EXISTS (
            SELECT 1 FROM source_heads h WHERE h.current_event_id = e.id
          )
          AND (
            e.thread_id IN (
              SELECT e2.thread_id
              FROM message_dispositions d2
              JOIN events e2 ON e2.id = d2.event_id
              WHERE d2.disposition = 'current_work'
                AND e2.thread_id IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM source_heads h2 WHERE h2.current_event_id = e2.id
                )
            )
            OR e.thread_id IN (
              SELECT p.thread_id
              FROM conversation_prefs p
              WHERE p.org_id = e.org_id AND p.hidden = 1
            )
          )
      ) ranked
      WHERE rn = 1;
    `,
  },
  {
    version: 26,
    sql: `
      INSERT OR IGNORE INTO thread_heads (
        org_id, thread_id, face_event_id, face_occurred_at, has_current_work
      )
      SELECT
        org_id,
        thread_id,
        id,
        occurred_at,
        CASE WHEN has_work = 1 THEN 1 ELSE 0 END
      FROM (
        SELECT
          e.org_id AS org_id,
          e.thread_id AS thread_id,
          e.id AS id,
          e.occurred_at AS occurred_at,
          CASE
            WHEN EXISTS (
              SELECT 1
              FROM message_dispositions d2
              JOIN events e2 ON e2.id = d2.event_id
              WHERE d2.disposition = 'current_work'
                AND e2.org_id = e.org_id
                AND e2.thread_id = e.thread_id
                AND EXISTS (
                  SELECT 1 FROM source_heads h2 WHERE h2.current_event_id = e2.id
                )
            ) THEN 1
            ELSE 0
          END AS has_work,
          ROW_NUMBER() OVER (
            PARTITION BY e.org_id, e.thread_id
            ORDER BY e.occurred_at DESC, e.id DESC
          ) AS rn
        FROM message_dispositions d
        JOIN events e ON e.id = d.event_id
        WHERE e.thread_id IS NOT NULL
          AND e.thread_id != ''
          AND e.operation != 'tombstone'
          AND d.reason_codes_json NOT LIKE '%thread_status%'
          AND EXISTS (
            SELECT 1 FROM source_heads h WHERE h.current_event_id = e.id
          )
          AND e.thread_id IN (
            SELECT p.thread_id
            FROM conversation_prefs p
            WHERE p.org_id = e.org_id AND p.hidden = 1
          )
      ) ranked
      WHERE rn = 1;
    `,
  },
  {
    version: 27,
    sql: `
      CREATE TABLE context_artifact_states (
        org_id TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'needs_clarify', 'superseded')),
        decided_at TEXT NOT NULL,
        superseded_by TEXT,
        PRIMARY KEY (org_id, artifact_id),
        FOREIGN KEY (org_id, artifact_id) REFERENCES context_artifacts(org_id, id)
      );
      CREATE INDEX context_artifact_states_query_idx
        ON context_artifact_states (org_id, status, decided_at, artifact_id);
    `,
  },
  {
    version: 28,
    sql: `
      ALTER TABLE events ADD COLUMN direction_tags_json TEXT
        CHECK (direction_tags_json IS NULL OR json_valid(direction_tags_json));
      ALTER TABLE events ADD COLUMN weight_hints_json TEXT
        CHECK (weight_hints_json IS NULL OR json_valid(weight_hints_json));
      ALTER TABLE events ADD COLUMN attrs_json TEXT
        CHECK (attrs_json IS NULL OR json_valid(attrs_json));
    `,
  },
  {
    version: 29,
    sql: `
      CREATE TABLE daily_digest_jobs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        utc_date TEXT NOT NULL,
        generation TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_owner TEXT,
        lease_expires_at TEXT,
        next_retry_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (org_id, utc_date, generation)
      );
      CREATE INDEX daily_digest_jobs_due_idx
        ON daily_digest_jobs (status, next_retry_at, lease_expires_at, created_at);
      CREATE INDEX daily_digest_jobs_org_idx
        ON daily_digest_jobs (org_id, created_at, id);
    `,
  },
  {
    version: 30,
    sql: `
      CREATE TABLE daily_digest_schedule_cursors (
        org_id TEXT NOT NULL,
        generation TEXT NOT NULL,
        last_scheduled_utc_date TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (org_id, generation)
      );
    `,
  },
  {
    version: 31,
    sql: `
      CREATE TABLE daily_digest_coverage_alerts (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        local_date TEXT NOT NULL,
        generation TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id),
        reason_code TEXT NOT NULL CHECK (reason_code = 'omitted_high_signal'),
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE (org_id, local_date, generation, event_id, reason_code)
      );
      CREATE INDEX daily_digest_coverage_alerts_query_idx
        ON daily_digest_coverage_alerts (org_id, status, local_date, id);
    `,
  },
  {
    version: 32,
    sql: `
      CREATE TABLE proposals (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'submitted', 'in_review', 'accepted', 'rejected', 'withdrawn')),
        source_digest_id TEXT,
        source_item_event_id TEXT,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (org_id, source_digest_id, source_item_event_id)
      );
      CREATE INDEX proposals_query_idx ON proposals (org_id, status, created_at, id);
    `,
  },
  {
    version: 33,
    sql: `
      ALTER TABLE proposals ADD COLUMN outcome_kind TEXT
        CHECK (outcome_kind IS NULL OR outcome_kind IN ('standard_version', 'decision', 'claim', 'none'));
      ALTER TABLE proposals ADD COLUMN outcome_ref_id TEXT;
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        proposal_id TEXT NOT NULL REFERENCES proposals(id),
        status TEXT NOT NULL CHECK (status IN ('committed', 'superseded', 'void')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        committed_at TEXT NOT NULL,
        UNIQUE (org_id, proposal_id)
      );
      CREATE INDEX decisions_query_idx ON decisions (org_id, committed_at, id);
    `,
  },
  {
    version: 34,
    sql: `
      CREATE TABLE reviews (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        subject_kind TEXT NOT NULL CHECK (subject_kind IN ('standard_version', 'decision', 'hypothesis_claim', 'agent_run')),
        subject_id TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX reviews_query_idx ON reviews (org_id, subject_id, created_at, id);
    `,
  },
  {
    version: 35,
    sql: `
      CREATE TABLE handoffs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('agent_to_human', 'human_to_agent')),
        status TEXT NOT NULL CHECK (status IN ('open', 'acked', 'resolved', 'cancelled')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX handoffs_query_idx ON handoffs (org_id, status, direction, created_at, id);
    `,
  },
  {
    version: 36,
    sql: `
      CREATE TABLE standards (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        current_version_id TEXT,
        citation_count INTEGER NOT NULL DEFAULT 0 CHECK (citation_count >= 0),
        created_at TEXT NOT NULL,
        UNIQUE (org_id, slug)
      );
      CREATE INDEX standards_query_idx ON standards (org_id, created_at, id);
      CREATE TABLE standard_versions (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        standard_id TEXT NOT NULL REFERENCES standards(id),
        proposal_id TEXT NOT NULL REFERENCES proposals(id),
        version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('draft', 'trial', 'active', 'deprecated')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        state_json TEXT NOT NULL CHECK (json_valid(state_json)),
        created_at TEXT NOT NULL,
        UNIQUE (org_id, standard_id, version),
        UNIQUE (org_id, proposal_id)
      );
      CREATE INDEX standard_versions_query_idx
        ON standard_versions (org_id, standard_id, created_at, id);
    `,
  },
  {
    version: 37,
    sql: `
      CREATE TABLE standard_gaps (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        source_kind TEXT NOT NULL CHECK (source_kind IN ('execution_failure', 'exception', 'three_questions', 'review', 'manual')),
        source_ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'converted', 'dismissed')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        converted_proposal_id TEXT REFERENCES proposals(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (org_id, source_kind, source_ref)
      );
      CREATE INDEX standard_gaps_query_idx ON standard_gaps (org_id, status, created_at, id);
    `,
  },
  {
    version: 38,
    sql: `
      CREATE TABLE agent_runs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'handed_off', 'cancelled')),
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        state_json TEXT NOT NULL CHECK (json_valid(state_json)),
        created_at TEXT NOT NULL
      );
      CREATE INDEX agent_runs_query_idx ON agent_runs (org_id, status, created_at, id);
    `,
  },
  {
    version: 39,
    sql: `
      CREATE TABLE standard_usage (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        standard_id TEXT NOT NULL REFERENCES standards(id),
        version_id TEXT NOT NULL REFERENCES standard_versions(id),
        source_kind TEXT NOT NULL CHECK (source_kind IN ('decision', 'agent_run')),
        source_id TEXT NOT NULL,
        context_snapshot_id TEXT NOT NULL,
        cited_at TEXT NOT NULL,
        UNIQUE (org_id, source_kind, source_id, standard_id, version_id)
      );
      CREATE INDEX standard_usage_query_idx
        ON standard_usage (org_id, standard_id, version_id, cited_at, id);
    `,
  },
  {
    version: 40,
    sql: `
      CREATE INDEX events_org_occurred_idx
        ON events (org_id, occurred_at, id);
    `,
  },
  {
    version: 41,
    sql: `
      CREATE TABLE context_snapshot_index (
        org_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        snapshot_id TEXT NOT NULL,
        principal_actor_type TEXT NOT NULL,
        principal_actor_id TEXT NOT NULL,
        consumer_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
        PRIMARY KEY (
          org_id, thread_id, snapshot_id, principal_actor_type,
          principal_actor_id, consumer_id
        )
      );
      CREATE INDEX context_snapshot_index_query_idx
        ON context_snapshot_index (
          org_id, thread_id, principal_actor_type, principal_actor_id,
          consumer_id, created_at DESC, snapshot_id DESC
        );
    `,
  },
  {
    version: 42,
    sql: `
      CREATE TABLE sync_runs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        installation_id TEXT NOT NULL REFERENCES connector_installations(id),
        mode TEXT NOT NULL CHECK (
          mode IN ('quick_start', 'continuous', 'archive')
        ),
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled')
        ),
        options_json TEXT NOT NULL CHECK (json_valid(options_json)),
        total_work INTEGER NOT NULL DEFAULT 0 CHECK (total_work >= 0),
        completed_work INTEGER NOT NULL DEFAULT 0 CHECK (completed_work >= 0),
        failed_work INTEGER NOT NULL DEFAULT 0 CHECK (failed_work >= 0),
        accepted_count INTEGER NOT NULL DEFAULT 0 CHECK (accepted_count >= 0),
        started_at TEXT,
        finished_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX sync_runs_org_created_idx
        ON sync_runs (org_id, created_at DESC, id DESC);
      CREATE INDEX sync_runs_installation_status_idx
        ON sync_runs (installation_id, status, updated_at);

      CREATE TABLE connector_sync_work (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES sync_runs(id),
        installation_id TEXT NOT NULL REFERENCES connector_installations(id),
        stream_key TEXT NOT NULL,
        lane TEXT NOT NULL CHECK (
          lane IN ('interactive', 'live', 'catalog', 'history', 'media')
        ),
        priority INTEGER NOT NULL,
        next_due_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')
        ),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        generation INTEGER NOT NULL,
        lease_owner TEXT,
        lease_expires_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE UNIQUE INDEX connector_sync_work_unique_idx
        ON connector_sync_work (
          installation_id, stream_key, lane, generation
        );
      CREATE INDEX connector_sync_work_due_idx
        ON connector_sync_work (
          status, next_due_at, priority DESC, created_at, id
        );
      CREATE INDEX connector_sync_work_run_idx
        ON connector_sync_work (run_id, status, updated_at);
      CREATE INDEX connector_sync_work_expired_idx
        ON connector_sync_work (lease_expires_at, priority DESC, id)
        WHERE status = 'running';
    `,
  },
  {
    version: 43,
    sql: `
      CREATE INDEX connector_sync_work_unassigned_idx
        ON connector_sync_work (installation_id, status, lane)
        WHERE run_id IS NULL;
    `,
  },
  {
    version: 44,
    sql: `
      CREATE INDEX connector_sync_state_gap_idx
        ON connector_sync_state (
          installation_id, phase, stream_key, generation, media_pending, idle_until
        );
    `,
  },
  {
    version: 45,
    sql: `
      CREATE INDEX events_parent_event_idx
        ON events (parent_event_id)
        WHERE parent_event_id IS NOT NULL;
    `,
  },
  {
    version: 46,
    sql: `
      ALTER TABLE context_artifacts ADD COLUMN preview_json TEXT NOT NULL DEFAULT '';
    `,
  },
  {
    version: 47,
    sql: `
      SELECT 1;
    `,
  },
  {
    version: 48,
    sql: CUSTOMER_SERVICE_TASKS_SQL,
  },
  {
    version: 49,
    sql: `
      ALTER TABLE outbound_attempts ADD COLUMN recovery_hash TEXT;
      ALTER TABLE outbound_attempts ADD COLUMN receipt_json TEXT;
    `,
  },
  {
    version: 50,
    sql: `ALTER TABLE work_runs ADD COLUMN start_state TEXT
      CHECK (start_state IN ('pending', 'submitted', 'uncertain'));`,
  },
  {
    version: 51,
    sql: `CREATE TABLE IF NOT EXISTS context_artifact_segments (
      org_id TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
      PRIMARY KEY (org_id, content_hash)
    );`,
  },
  {
    version: 52,
    sql: OUTBOUND_REJECTION_MIGRATION_SQL,
  },
  {
    version: 53,
    sql: `
      CREATE TABLE IF NOT EXISTS search_answers (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL REFERENCES work_items(id),
        query TEXT NOT NULL,
        event_ids_json TEXT NOT NULL CHECK (json_valid(event_ids_json)),
        outcome TEXT CHECK (outcome IN ('timed_out')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS search_answers_work_item_idx
        ON search_answers (org_id, work_item_id);
    `,
  },
  {
    // The schedule branch already shipped these columns as version 48.
    // Apply each statement only when that column is still missing.
    version: 54,
    sql: `${RECIPE_CLOCK_COLUMN_SQL.join(";\n")};`,
  },
  {
    // Those same databases skipped this table, because version 48 was taken.
    version: 55,
    sql: CUSTOMER_SERVICE_TASKS_SQL,
  },
  {
    version: 56,
    sql: `ALTER TABLE search_answers ADD COLUMN scope_json TEXT
      CHECK (scope_json IS NULL OR json_valid(scope_json));`,
  },
  {
    version: 57,
    sql: RECIPE_DESTINATION_COLUMN_SQL,
  },
  {
    version: 58,
    sql: `ALTER TABLE recipes ADD COLUMN hide_on_success INTEGER NOT NULL DEFAULT 1
      CHECK (hide_on_success IN (0, 1));`,

  },
  {
    version: 59,
    sql: `
      ALTER TABLE work_items ADD COLUMN current_run_id TEXT REFERENCES work_runs(id);
      ALTER TABLE work_items ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0);
      ALTER TABLE work_runs ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0);
      UPDATE work_items SET current_run_id = (
        SELECT r.id FROM work_runs r
        WHERE r.org_id = work_items.org_id AND r.work_item_id = work_items.id
          AND r.recipe_id = work_items.recipe_id
          AND r.status IN ('running', 'waiting_human')
      )
      WHERE status IN ('running', 'waiting_human')
        AND 1 = (
          SELECT COUNT(*) FROM work_runs r
          WHERE r.org_id = work_items.org_id AND r.work_item_id = work_items.id
        );
    `,
  },
  { version: 60, sql: RUN_DELIVERY_LEDGER_SQL },
  {
    version: 61,
    sql: `
      ALTER TABLE work_deliveries ADD COLUMN lease_owner TEXT;
      ALTER TABLE work_deliveries ADD COLUMN claim_token TEXT;
      ALTER TABLE work_deliveries ADD COLUMN cancel_requested_at TEXT;
    `,
  },
  {
    version: 62,
    sql: `
      ALTER TABLE conversation_prefs ADD COLUMN visibility_version INTEGER NOT NULL DEFAULT 0 CHECK (visibility_version >= 0);
    `,
  },
  {
    version: 63,
    sql: `
      ALTER TABLE work_items ADD COLUMN visibility_intent_version INTEGER NOT NULL DEFAULT 0 CHECK (visibility_intent_version >= 0);
    `,
  },
  {
    version: 64,
    sql: `
      CREATE TABLE conversation_lifecycle_events (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        aggregate_type TEXT NOT NULL CHECK (
          aggregate_type IN ('work_item', 'work_run', 'work_delivery', 'conversation', 'source_event')
        ),
        aggregate_id TEXT NOT NULL,
        aggregate_version INTEGER NOT NULL CHECK (aggregate_version >= 0),
        event_type TEXT NOT NULL CHECK (
          event_type IN (
            'work_item_transitioned', 'work_run_transitioned', 'work_acknowledged',
            'delivery_created', 'delivery_claimed', 'delivery_transitioned',
            'cancellation_requested', 'visibility_intent_changed', 'visibility_changed',
            'current_work_changed'
          )
        ),
        command_id TEXT,
        dedupe_key TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        payload_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (org_id, id),
        UNIQUE (org_id, dedupe_key)
      );
      CREATE INDEX conversation_lifecycle_events_thread_idx
        ON conversation_lifecycle_events (org_id, thread_id, created_at, id);
      CREATE INDEX conversation_lifecycle_events_aggregate_idx
        ON conversation_lifecycle_events (org_id, aggregate_type, aggregate_id, aggregate_version);
      CREATE INDEX conversation_lifecycle_events_command_idx
        ON conversation_lifecycle_events (org_id, command_id);
    `,
  },
  {
    version: 65,
    sql: `
      CREATE UNIQUE INDEX conversation_lifecycle_events_command_unique_idx
        ON conversation_lifecycle_events (org_id, command_id)
        WHERE command_id IS NOT NULL;
    `,
  },
  {
    version: 66,
    sql: `
      ALTER TABLE work_items ADD COLUMN acknowledged_run_id TEXT REFERENCES work_runs(id);
    `,
  },
  {
    version: 67,
    sql: `
      CREATE TABLE conversation_lifecycle_jobs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        job_type TEXT NOT NULL CHECK (job_type = 'cancel_execution'),
        run_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version >= 1),
        status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'dead')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_owner TEXT,
        claim_token TEXT,
        lease_expires_at TEXT,
        next_retry_at TEXT,
        last_error_code TEXT,
        last_error TEXT,
        outcome_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (org_id, event_id) REFERENCES conversation_lifecycle_events(org_id, id),
        FOREIGN KEY (org_id, run_id) REFERENCES work_runs(org_id, id),
        UNIQUE (org_id, job_type, run_id)
      );
      CREATE INDEX conversation_lifecycle_jobs_pending_idx
        ON conversation_lifecycle_jobs (created_at, id) WHERE status = 'pending';
      CREATE INDEX conversation_lifecycle_jobs_failed_due_idx
        ON conversation_lifecycle_jobs (next_retry_at, created_at, id) WHERE status = 'failed';
      CREATE INDEX conversation_lifecycle_jobs_running_expired_idx
        ON conversation_lifecycle_jobs (lease_expires_at, created_at, id) WHERE status = 'running';
      CREATE INDEX conversation_lifecycle_jobs_org_idx
        ON conversation_lifecycle_jobs (org_id, status, updated_at, id);
    `,
  },
  {
    version: 68,
    sql: `
      ALTER TABLE work_runs ADD COLUMN executor_config_json TEXT
        CHECK (executor_config_json IS NULL OR json_valid(executor_config_json));
      ALTER TABLE work_runs ADD COLUMN include_context INTEGER
        CHECK (include_context IS NULL OR include_context IN (0, 1));
    `,
  },
  {
    version: 69,
    sql: `
      ALTER TABLE work_deliveries ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0);
      ALTER TABLE message_dispositions ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0);
    `,
  },
  {
    version: 70,
    sql: `
      UPDATE thread_heads SET has_current_work = 0
      WHERE has_current_work = 1 AND NOT EXISTS (
        SELECT 1 FROM events e
        JOIN message_dispositions d ON d.event_id = e.id AND d.org_id = e.org_id
        WHERE e.org_id = thread_heads.org_id AND e.thread_id = thread_heads.thread_id
          AND e.operation <> 'tombstone' AND d.disposition = 'current_work'
          AND EXISTS (SELECT 1 FROM source_heads h WHERE h.current_event_id = e.id)
      );
    `,
  },
  {
    version: 71,
    sql: `
      ALTER TABLE connector_cursors ADD COLUMN lease_claim_token TEXT;
      UPDATE connector_cursors
      SET lease_owner = NULL, lease_expires_at = NULL
      WHERE lease_owner IS NOT NULL;
    `,
  },
  {
    version: 72,
    sql: `
      ALTER TABLE blobs ADD COLUMN state TEXT NOT NULL DEFAULT 'protected'
        CHECK (state IN ('reserved', 'available', 'deleting', 'protected'));
      ALTER TABLE blobs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0);
      ALTER TABLE blobs ADD COLUMN write_lease_owner TEXT;
      ALTER TABLE blobs ADD COLUMN write_claim_token TEXT;
      ALTER TABLE blobs ADD COLUMN write_lease_expires_at TEXT;
      ALTER TABLE blobs ADD COLUMN unreferenced_at TEXT;
      ALTER TABLE blobs ADD COLUMN gc_claim_token TEXT;
      ALTER TABLE blobs ADD COLUMN gc_started_at TEXT;
      CREATE INDEX blobs_gc_candidate_idx
        ON blobs (state, unreferenced_at, content_hash);
      CREATE TABLE blob_references (
        owner_org_id TEXT NOT NULL,
        owner_type TEXT NOT NULL CHECK (owner_type IN ('event', 'context_artifact')),
        owner_id TEXT NOT NULL,
        reference_kind TEXT NOT NULL
          CHECK (reference_kind IN ('body', 'attachment', 'artifact_body', 'evidence')),
        content_hash TEXT NOT NULL REFERENCES blobs(content_hash),
        created_at TEXT NOT NULL,
        PRIMARY KEY (owner_org_id, owner_type, owner_id, reference_kind, content_hash)
      );
      CREATE INDEX blob_references_hash_idx
        ON blob_references (content_hash);
      CREATE INDEX blob_references_owner_idx
        ON blob_references (owner_org_id, owner_type, owner_id);
    `,
  },
  {
    version: 73,
    sql: `
      DROP INDEX blob_references_hash_idx;
      DROP INDEX blob_references_owner_idx;
      ALTER TABLE blob_references RENAME TO blob_references_v70;
      CREATE TABLE blob_references (
        owner_org_id TEXT NOT NULL,
        owner_type TEXT NOT NULL
          CHECK (owner_type IN ('event', 'context_artifact', 'outbound_attempt')),
        owner_id TEXT NOT NULL,
        reference_kind TEXT NOT NULL
          CHECK (reference_kind IN ('body', 'attachment', 'artifact_body', 'evidence', 'reply_recovery')),
        content_hash TEXT NOT NULL REFERENCES blobs(content_hash),
        created_at TEXT NOT NULL,
        PRIMARY KEY (owner_org_id, owner_type, owner_id, reference_kind, content_hash)
      );
      INSERT INTO blob_references
        SELECT owner_org_id, owner_type, owner_id, reference_kind, content_hash, created_at
        FROM blob_references_v70;
      INSERT OR IGNORE INTO blobs (
        content_hash, media_type, byte_size, created_at, state
      )
        SELECT DISTINCT recovery_hash, 'application/vnd.regenic.reply-recovery+json',
          0, updated_at, 'protected'
        FROM outbound_attempts WHERE recovery_hash IS NOT NULL;
      UPDATE blobs SET state = 'protected', unreferenced_at = NULL,
        gc_claim_token = NULL, gc_started_at = NULL
      WHERE content_hash IN (
        SELECT DISTINCT recovery_hash FROM outbound_attempts WHERE recovery_hash IS NOT NULL
      );
      INSERT OR IGNORE INTO blob_references (
        owner_org_id, owner_type, owner_id, reference_kind, content_hash, created_at
      )
        SELECT org_id, 'outbound_attempt', client_request_id, 'reply_recovery',
          recovery_hash, updated_at
        FROM outbound_attempts WHERE recovery_hash IS NOT NULL;
      DROP TABLE blob_references_v70;
      CREATE INDEX blob_references_hash_idx
        ON blob_references (content_hash);
      CREATE INDEX blob_references_owner_idx
        ON blob_references (owner_org_id, owner_type, owner_id);
    `,
  },
  {
    version: 74,
    sql: `
      UPDATE blobs SET state = 'protected', unreferenced_at = NULL,
        gc_claim_token = NULL, gc_started_at = NULL
      WHERE content_hash IN (
        SELECT DISTINCT content_hash FROM events WHERE content_hash IS NOT NULL
      );
      INSERT OR IGNORE INTO blob_references (
        owner_org_id, owner_type, owner_id, reference_kind, content_hash, created_at
      )
        SELECT org_id, 'event', id, 'body', content_hash, ingested_at
        FROM events WHERE content_hash IS NOT NULL;
    `,
  },
  {
    version: 75,
    sql: `
      INSERT OR IGNORE INTO blobs (
        content_hash, media_type, byte_size, created_at, state
      )
        SELECT DISTINCT content_hash, media_type, 0, recorded_at, 'protected'
        FROM (
          SELECT json_extract(payload_json, '$.body_hash') AS content_hash,
            'application/vnd.regenic.context-artifact+json' AS media_type,
            recorded_at, payload_json,
            CASE WHEN json_extract(payload_json, '$.body_storage') IS NULL
              OR json_extract(payload_json, '$.body_storage') <> 'artifact'
              THEN 1 ELSE 0 END AS external_blob
          FROM context_artifacts
          UNION ALL
          SELECT json_extract(reference.value, '$.content_hash') AS content_hash,
            'application/octet-stream' AS media_type,
            artifact.recorded_at, artifact.payload_json, 1 AS external_blob
          FROM context_artifacts artifact,
            json_each(
              CASE WHEN json_valid(artifact.payload_json)
                THEN artifact.payload_json ELSE '{}' END,
              '$.input_refs'
            ) reference
        )
        WHERE json_valid(payload_json)
          AND external_blob = 1
          AND content_hash IS NOT NULL
          AND length(content_hash) = 64
          AND content_hash NOT GLOB '*[^0-9a-f]*';
      UPDATE blobs SET state = 'protected', unreferenced_at = NULL,
        gc_claim_token = NULL, gc_started_at = NULL
      WHERE content_hash IN (
        SELECT json_extract(payload_json, '$.body_hash')
        FROM context_artifacts
        WHERE json_valid(payload_json)
          AND (json_extract(payload_json, '$.body_storage') IS NULL
            OR json_extract(payload_json, '$.body_storage') <> 'artifact')
        UNION
        SELECT json_extract(reference.value, '$.content_hash')
        FROM context_artifacts artifact,
          json_each(
            CASE WHEN json_valid(artifact.payload_json)
              THEN artifact.payload_json ELSE '{}' END,
            '$.input_refs'
          ) reference
        WHERE json_valid(artifact.payload_json)
      );
      INSERT OR IGNORE INTO blob_references (
        owner_org_id, owner_type, owner_id, reference_kind, content_hash, created_at
      )
        SELECT org_id, 'context_artifact', id, 'artifact_body',
          json_extract(payload_json, '$.body_hash'), recorded_at
        FROM context_artifacts
        WHERE json_valid(payload_json)
          AND json_extract(payload_json, '$.body_hash') IS NOT NULL
          AND length(json_extract(payload_json, '$.body_hash')) = 64
          AND json_extract(payload_json, '$.body_hash') NOT GLOB '*[^0-9a-f]*'
          AND (json_extract(payload_json, '$.body_storage') IS NULL
            OR json_extract(payload_json, '$.body_storage') <> 'artifact');
      INSERT OR IGNORE INTO blob_references (
        owner_org_id, owner_type, owner_id, reference_kind, content_hash, created_at
      )
        SELECT artifact.org_id, 'context_artifact', artifact.id, 'evidence',
          json_extract(reference.value, '$.content_hash'), artifact.recorded_at
        FROM context_artifacts artifact,
          json_each(
            CASE WHEN json_valid(artifact.payload_json)
              THEN artifact.payload_json ELSE '{}' END,
            '$.input_refs'
          ) reference
        WHERE json_valid(artifact.payload_json)
          AND json_extract(reference.value, '$.content_hash') IS NOT NULL
          AND length(json_extract(reference.value, '$.content_hash')) = 64
          AND json_extract(reference.value, '$.content_hash') NOT GLOB '*[^0-9a-f]*';
    `,
  },
  {
    version: 76,
    sql: `ALTER TABLE work_runs ADD COLUMN completion_policy_version INTEGER
      CHECK (completion_policy_version IS NULL OR completion_policy_version = 1);`,
  },
  {
    version: 77,
    sql: `ALTER TABLE work_runs ADD COLUMN hide_on_success INTEGER CHECK (hide_on_success IS NULL OR hide_on_success IN (0, 1));`,
  },
  {
    version: 78,
    sql: `
      UPDATE work_items SET current_run_id = (
        SELECT r.id FROM work_runs r
        WHERE r.org_id = work_items.org_id AND r.work_item_id = work_items.id
          AND r.recipe_id = work_items.recipe_id
          AND r.status IN ('running', 'waiting_human')
      )
      WHERE current_run_id IS NULL AND version = 0 AND status IN ('running', 'waiting_human')
        AND 1 = (
          SELECT COUNT(*) FROM work_runs r
          WHERE r.org_id = work_items.org_id AND r.work_item_id = work_items.id
            AND r.recipe_id = work_items.recipe_id
            AND r.status IN ('running', 'waiting_human')
        );
    `,
  },
  {
    version: 79,
    sql: `
      CREATE TABLE search_answers_next (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL REFERENCES work_items(id),
        query TEXT NOT NULL,
        event_ids_json TEXT NOT NULL CHECK (json_valid(event_ids_json)),
        outcome TEXT CHECK (outcome IN ('timed_out', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        scope_json TEXT CHECK (scope_json IS NULL OR json_valid(scope_json))
      );
      INSERT INTO search_answers_next
        (id, org_id, work_item_id, query, event_ids_json, outcome,
         created_at, updated_at, scope_json)
      SELECT id, org_id, work_item_id, query, event_ids_json, outcome,
        created_at, updated_at, scope_json
      FROM search_answers;
      DROP TABLE search_answers;
      ALTER TABLE search_answers_next RENAME TO search_answers;
      CREATE UNIQUE INDEX search_answers_work_item_idx
        ON search_answers (org_id, work_item_id);
    `,
  },
  {
    version: 80,
    sql: `
      CREATE TABLE IF NOT EXISTS connector_push_watermarks (
        installation_id TEXT NOT NULL REFERENCES connector_installations(id),
        stream_key TEXT NOT NULL,
        watermark TEXT NOT NULL,
        batch_id TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (installation_id, stream_key)
      );
    `,
  },
  {
    version: 81,
    sql: `
      CREATE TABLE IF NOT EXISTS aggregate_fact_cache (
        org_id TEXT NOT NULL,
        spec_hash TEXT NOT NULL,
        extractor_version TEXT NOT NULL,
        event_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        facts_json TEXT NOT NULL CHECK (json_valid(facts_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (org_id, spec_hash, extractor_version, event_id)
      );
      CREATE INDEX IF NOT EXISTS aggregate_fact_cache_event_idx
        ON aggregate_fact_cache (org_id, event_id);
    `,
  },
  {
    version: 82,
    sql: `
      DROP TABLE IF EXISTS customer_service_tasks;
      DROP TABLE IF EXISTS daily_digest_coverage_alerts;
      DROP TABLE IF EXISTS daily_digest_jobs;
      DROP TABLE IF EXISTS daily_digest_schedule_cursors;
      DELETE FROM ui_prefs WHERE key IN (
        'daily_digest_policy_v1',
        'personal_follow_up_policy_v1',
        'personal_follow_up_snoozes_v1'
      );
    `,
  },
  {
    // Some local databases already advanced through 83–85. Those steps are not
    // repeated: 83 and 84 deleted live preferences, and 85 dropped search_answers.
    version: 83,
    sql: "SELECT 1",
  },
  {
    version: 84,
    sql: "SELECT 1",
  },
  {
    version: 85,
    sql: "SELECT 1",
  },
  {
    version: 86,
    sql: `
      CREATE TABLE IF NOT EXISTS search_answers (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL REFERENCES work_items(id),
        query TEXT NOT NULL,
        event_ids_json TEXT NOT NULL CHECK (json_valid(event_ids_json)),
        scope_json TEXT CHECK (scope_json IS NULL OR json_valid(scope_json)),
        outcome TEXT CHECK (outcome IN ('timed_out', 'cancelled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS search_answers_work_item_idx
        ON search_answers (org_id, work_item_id);
    `,
  },
] as const;
