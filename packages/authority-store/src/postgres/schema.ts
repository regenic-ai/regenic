export const PG_SCHEMA_VERSION = 29;

/** Applied when an existing postgres authority DB is already at a prior baseline. */
export const PG_MIGRATIONS = [
  {
    version: 24,
    sql: `
DROP INDEX IF EXISTS context_projection_outbox_due_idx;
CREATE INDEX context_projection_outbox_pending_idx
  ON context_projection_outbox (created_at, id)
  WHERE status = 'pending';
CREATE INDEX context_projection_outbox_failed_due_idx
  ON context_projection_outbox (next_retry_at, created_at, id)
  WHERE status = 'failed';
CREATE INDEX context_projection_outbox_running_expired_idx
  ON context_projection_outbox (lease_expires_at, created_at, id)
  WHERE status = 'running';
`,
  },
  {
    version: 25,
    sql: `
ALTER TABLE recipes ADD COLUMN max_concurrent INTEGER;
`,
  },
  {
    version: 26,
    sql: `
CREATE TABLE thread_heads (
  org_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  face_event_id TEXT NOT NULL REFERENCES events(id),
  face_occurred_at TIMESTAMPTZ NOT NULL,
  has_current_work BOOLEAN NOT NULL,
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
  CASE WHEN has_work THEN TRUE ELSE FALSE END
FROM (
  SELECT
    e.org_id AS org_id,
    e.thread_id AS thread_id,
    e.id AS id,
    e.occurred_at AS occurred_at,
    EXISTS (
      SELECT 1
      FROM message_dispositions d2
      JOIN events e2 ON e2.id = d2.event_id
      WHERE d2.disposition = 'current_work'
        AND e2.org_id = e.org_id
        AND e2.thread_id = e.thread_id
        AND EXISTS (
          SELECT 1 FROM source_heads h2 WHERE h2.current_event_id = e2.id
        )
    ) AS has_work,
    ROW_NUMBER() OVER (
      PARTITION BY e.org_id, e.thread_id
      ORDER BY e.occurred_at DESC, e.id DESC
    ) AS rn
  FROM message_dispositions d
  JOIN events e ON e.id = d.event_id
  WHERE e.thread_id IS NOT NULL
    AND e.thread_id != ''
    AND e.operation != 'tombstone'
    AND NOT (d.reason_codes ? 'thread_status')
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
        WHERE p.org_id = e.org_id AND p.hidden IS TRUE
      )
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
  decided_at TIMESTAMPTZ NOT NULL,
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
INSERT INTO thread_heads (
  org_id, thread_id, face_event_id, face_occurred_at, has_current_work
)
SELECT
  org_id,
  thread_id,
  id,
  occurred_at,
  CASE WHEN has_work THEN TRUE ELSE FALSE END
FROM (
  SELECT
    e.org_id AS org_id,
    e.thread_id AS thread_id,
    e.id AS id,
    e.occurred_at AS occurred_at,
    EXISTS (
      SELECT 1
      FROM message_dispositions d2
      JOIN events e2 ON e2.id = d2.event_id
      WHERE d2.disposition = 'current_work'
        AND e2.org_id = e.org_id
        AND e2.thread_id = e.thread_id
        AND EXISTS (
          SELECT 1 FROM source_heads h2 WHERE h2.current_event_id = e2.id
        )
    ) AS has_work,
    ROW_NUMBER() OVER (
      PARTITION BY e.org_id, e.thread_id
      ORDER BY e.occurred_at DESC, e.id DESC
    ) AS rn
  FROM message_dispositions d
  JOIN events e ON e.id = d.event_id
  WHERE e.thread_id IS NOT NULL
    AND e.thread_id != ''
    AND e.operation != 'tombstone'
    AND NOT (d.reason_codes ? 'thread_status')
    AND EXISTS (
      SELECT 1 FROM source_heads h WHERE h.current_event_id = e.id
    )
    AND e.thread_id IN (
      SELECT p.thread_id
      FROM conversation_prefs p
      WHERE p.org_id = e.org_id AND p.hidden IS TRUE
    )
) ranked
WHERE rn = 1
ON CONFLICT (org_id, thread_id) DO NOTHING;
`,
  },
  {
    version: 29,
    sql: `
ALTER TABLE events ADD COLUMN direction_tags JSONB;
ALTER TABLE events ADD COLUMN weight_hints JSONB;
ALTER TABLE events ADD COLUMN attrs JSONB;
`,
  },
] as const;

export const PG_BASELINE_SQL = `
CREATE TABLE blobs (
  content_hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE events (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY,
  id TEXT NOT NULL UNIQUE,
  org_id TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'revise', 'tombstone')),
  content_hash TEXT REFERENCES blobs(content_hash),
  parent_event_id TEXT REFERENCES events(id),
  revision_id TEXT,
  occurred_at TIMESTAMPTZ NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL,
  thread_id TEXT,
  actor_id TEXT,
  required_scope_ids JSONB,
  direction_tags JSONB,
  weight_hints JSONB,
  attrs JSONB,
  PRIMARY KEY (sequence)
);

CREATE INDEX events_source_identity_idx
  ON events (org_id, source, external_id, sequence);
CREATE INDEX events_content_hash_idx ON events (content_hash);
CREATE INDEX events_org_ingested_idx ON events (org_id, ingested_at, id);
CREATE INDEX events_org_thread_occurred_idx
  ON events (org_id, thread_id, occurred_at, id);

CREATE TABLE source_heads (
  org_id TEXT NOT NULL,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  current_event_id TEXT NOT NULL REFERENCES events(id),
  PRIMARY KEY (org_id, source, external_id)
);

CREATE INDEX source_heads_current_event_idx ON source_heads (current_event_id);

CREATE TABLE connector_installations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  connector_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('enabled', 'disabled', 'needs_attention')
  ),
  config_json JSONB NOT NULL,
  credentials_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX connector_installations_org_idx
  ON connector_installations (org_id, connector_type);

CREATE TABLE connector_cursors (
  installation_id TEXT NOT NULL REFERENCES connector_installations(id),
  stream_key TEXT NOT NULL,
  cursor_value TEXT,
  cursor_version INTEGER NOT NULL,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (installation_id, stream_key)
);

CREATE TABLE ingest_attempts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  connector_installation_id TEXT NOT NULL
    REFERENCES connector_installations(id),
  stream_key TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
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
CREATE INDEX ingest_attempts_installation_started_idx
  ON ingest_attempts (connector_installation_id, started_at DESC, id DESC);

CREATE TABLE ingest_quarantines (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES ingest_attempts(id),
  record_external_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  safe_metadata_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolution TEXT
);

CREATE INDEX ingest_quarantines_attempt_idx
  ON ingest_quarantines (attempt_id, created_at);

CREATE TABLE message_dispositions (
  event_id TEXT PRIMARY KEY REFERENCES events(id),
  org_id TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (
    disposition IN ('current_work', 'outside_current_work', 'pending')
  ),
  layer TEXT NOT NULL CHECK (layer IN ('L1_event')),
  reason_codes JSONB NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX message_dispositions_inbox_idx
  ON message_dispositions (org_id, disposition, decided_at);

CREATE TABLE conversation_prefs (
  org_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  title TEXT,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  hidden BOOLEAN NOT NULL DEFAULT FALSE,
  hidden_reason TEXT,
  last_read_at TIMESTAMPTZ,
  last_read_external_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, thread_id)
);

CREATE INDEX conversation_prefs_org_idx
  ON conversation_prefs (org_id, pinned, updated_at);
CREATE INDEX conversation_prefs_hidden_idx
  ON conversation_prefs (org_id, hidden);

CREATE TABLE recipes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  match_json JSONB NOT NULL,
  executor_type TEXT NOT NULL,
  executor_config_json JSONB NOT NULL,
  can_write_back BOOLEAN NOT NULL DEFAULT FALSE,
  include_context BOOLEAN NOT NULL DEFAULT FALSE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  trigger_kind TEXT NOT NULL DEFAULT 'push',
  trigger_interval_ms INTEGER,
  trigger_coalesce BOOLEAN NOT NULL DEFAULT TRUE,
  max_concurrent INTEGER,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX recipes_org_idx ON recipes (org_id, updated_at);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  unit_key TEXT NOT NULL,
  head_event_id TEXT REFERENCES events(id),
  record_class TEXT NOT NULL,
  thread_facet TEXT NOT NULL,
  status TEXT NOT NULL,
  recipe_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (org_id, thread_id, unit_key)
);

CREATE INDEX work_items_org_status_idx ON work_items (org_id, status, updated_at);
CREATE INDEX work_items_session_idx ON work_items (org_id, thread_id, updated_at);

CREATE TABLE work_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  recipe_id TEXT NOT NULL,
  executor_type TEXT NOT NULL,
  external_run_id TEXT,
  agent_thread_id TEXT,
  status TEXT NOT NULL,
  result_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX work_runs_item_idx ON work_runs (org_id, work_item_id, updated_at);

CREATE TABLE ui_prefs (
  org_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, key)
);

CREATE TABLE executor_installations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local_connector', 'http')),
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
  config_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX executor_installations_org_idx
  ON executor_installations (org_id, updated_at);

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
  next_retry_at TIMESTAMPTZ,
  payload_json JSONB,
  lease_expires_at TIMESTAMPTZ,
  idempotency_key TEXT,
  channel_receipt_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (org_id, work_item_id)
);

CREATE INDEX work_deliveries_org_status_idx
  ON work_deliveries (org_id, status, next_retry_at);

CREATE TABLE connector_stream_members (
  installation_id TEXT NOT NULL REFERENCES connector_installations(id),
  stream_key TEXT NOT NULL,
  thread_id TEXT,
  label TEXT,
  kind TEXT,
  generation INTEGER NOT NULL,
  discovered_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (installation_id, stream_key)
);

CREATE INDEX connector_stream_members_generation_idx
  ON connector_stream_members (installation_id, generation);

CREATE TABLE connector_catalog_cursors (
  installation_id TEXT NOT NULL REFERENCES connector_installations(id),
  cursor_value TEXT,
  complete BOOLEAN NOT NULL DEFAULT FALSE,
  generation INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
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
  media_pending BOOLEAN NOT NULL DEFAULT FALSE,
  idle_until TIMESTAMPTZ,
  generation INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (installation_id, stream_key)
);

CREATE TABLE context_artifacts (
  org_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  generation TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL,
  PRIMARY KEY (org_id, id)
);

CREATE TABLE context_artifact_states (
  org_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'needs_clarify', 'superseded')),
  decided_at TIMESTAMPTZ NOT NULL,
  superseded_by TEXT,
  PRIMARY KEY (org_id, artifact_id),
  FOREIGN KEY (org_id, artifact_id) REFERENCES context_artifacts(org_id, id)
);
CREATE INDEX context_artifact_states_query_idx
  ON context_artifact_states (org_id, status, decided_at, artifact_id);

CREATE INDEX context_artifacts_query_idx
  ON context_artifacts (org_id, kind, status, generation, recorded_at, id);

CREATE TABLE context_snapshots (
  org_id TEXT NOT NULL,
  id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  PRIMARY KEY (org_id, id)
);

CREATE TABLE context_bundles (
  org_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  principal_actor_type TEXT NOT NULL,
  principal_actor_id TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  payload_json JSONB NOT NULL,
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
  watermark TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL,
  PRIMARY KEY (org_id, projector_id, generation)
);

CREATE TABLE context_projection_outbox (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_retry_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

-- Claim is an OR of three status branches; partial indexes match each arm.
CREATE INDEX context_projection_outbox_pending_idx
  ON context_projection_outbox (created_at, id)
  WHERE status = 'pending';
CREATE INDEX context_projection_outbox_failed_due_idx
  ON context_projection_outbox (next_retry_at, created_at, id)
  WHERE status = 'failed';
CREATE INDEX context_projection_outbox_running_expired_idx
  ON context_projection_outbox (lease_expires_at, created_at, id)
  WHERE status = 'running';
CREATE INDEX context_projection_outbox_org_idx
  ON context_projection_outbox (org_id, created_at, id);

CREATE TABLE outbound_attempts (
  org_id TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  event_id TEXT REFERENCES events(id),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'accepted', 'sent', 'failed')
  ),
  channel_message_ids JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (org_id, client_request_id)
);

CREATE INDEX outbound_attempts_event_idx ON outbound_attempts (event_id);

CREATE TABLE thread_heads (
  org_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  face_event_id TEXT NOT NULL REFERENCES events(id),
  face_occurred_at TIMESTAMPTZ NOT NULL,
  has_current_work BOOLEAN NOT NULL,
  PRIMARY KEY (org_id, thread_id)
);

CREATE INDEX thread_heads_org_face_idx
  ON thread_heads (org_id, has_current_work, face_occurred_at DESC, face_event_id DESC);
`;
