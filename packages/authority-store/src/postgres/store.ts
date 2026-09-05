import { randomUUID } from "node:crypto";
import { Pool, types, type PoolClient } from "pg";
import {
  AuthorityConflictError,
  applySyncCatalogMembers,
  canonicalContextJson,
  conversationId,
  formatInboxDigest,
  hashCanonicalContext,
  headsScanQuery,
  isRecipeTriggerKind,
  isPullIntervalMs,
  isWorkDeliveryStatus,
  isWorkWriteBackState,
  normalizeInboxLimit,
  normalizeInboxListView,
  normalizeHiddenReason,
  recipeTriggerOf,
  threadExternalIdLike,
  validateContextArtifact,
  validateContextArtifactQuery,
  validateContextBundle,
  validateContextProjectionCheckpoint,
  validateContextSnapshot,
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
  ContextArtifact,
  ContextArtifactDecision,
  ContextArtifactQuery,
  ContextArtifactState,
  ContextArtifactStore,
  ContextArtifactSupersession,
  ContextAuthorityRead,
  ContextAuthorityReader,
  ContextBundle,
  ContextBundleLookup,
  ContextProjectionCheckpoint,
  ContextProjectionJob,
  ContextProjectionOutboxStore,
  ClaimContextProjectionJobs,
  CompleteContextProjectionJob,
  FailContextProjectionJob,
  RenewContextProjectionJob,
  ContextSnapshot,
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
  OutboundAttemptPut,
  OutboundAttemptRecord,
  RepointContentInput,
  ResetConnectorCursor,
  ReleaseConnectorLease,
  SetConnectorInstallationConfig,
  SetConnectorInstallationStatus,
  SettleIngestAttempt,
  SourceIdentity,
  SourceIdentityAliasBind,
  TombstoneEvent,
  Recipe,
  WorkDelivery,
  StoreClearResult,
  StoreFootprint,
  WorkItem,
  WorkRun,
  WorkStore,
  ExecutorInstallation,
  ExecutorStore,
  ApplySyncCatalogPageInput,
  SyncCatalogMember,
  SyncCatalogSnapshot,
  SyncCatalogView,
  SyncPhase,
  SyncStreamState,
} from "@regenic/domain";
import { migratePostgresAuthority } from "./migrate";

types.setTypeParser(1184, (value: string) => new Date(value).toISOString());
types.setTypeParser(1114, (value: string) => new Date(value).toISOString());

export const INGEST_ATTEMPT_KEEP_PER_INSTALLATION = 64;
export const INGEST_ATTEMPT_PRUNE_BATCH = 5_000;
export const INGEST_ATTEMPT_PRUNE_INSTALLATIONS = 25;

interface EventRow {
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
  occurred_at: unknown;
  ingested_at: unknown;
}

interface ContextEventRow extends EventRow {
  content_media_type: string | null;
}

interface DispositionRow {
  event_id: string;
  org_id: string;
  disposition: ArrangementDecision["disposition"];
  layer: ArrangementDecision["layer"];
  reason_codes: unknown;
  score: unknown;
  decided_at: unknown;
}

interface InboxRow extends EventRow {
  event_id: string;
  disposition_org_id: string;
  disposition: ArrangementDecision["disposition"];
  layer: ArrangementDecision["layer"];
  reason_codes: unknown;
  score: unknown;
  decided_at: unknown;
}

interface BlobRow {
  content_hash: string;
  media_type: string;
  byte_size: number;
  created_at: unknown;
}

interface InstallationRow {
  id: string;
  org_id: string;
  connector_type: string;
  status: ConnectorInstallation["status"];
  config_json: unknown;
  credentials_ref: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface CursorRow {
  installation_id: string;
  stream_key: string;
  cursor_value: string | null;
  cursor_version: number;
  lease_owner: string | null;
  lease_expires_at: unknown;
  updated_at: unknown;
}

interface StreamMemberRow {
  installation_id: string;
  stream_key: string;
  thread_id: string | null;
  label: string | null;
  kind: string | null;
  generation: number;
  discovered_at: unknown;
  last_seen_at: unknown;
}

interface CatalogCursorRow {
  installation_id: string;
  cursor_value: string | null;
  complete: unknown;
  generation: number;
  updated_at: unknown;
}

interface SyncStateRow {
  installation_id: string;
  stream_key: string;
  phase: SyncPhase;
  live_cursor: string | null;
  history_cursor: string | null;
  media_pending: unknown;
  idle_until: unknown;
  generation: number;
  updated_at: unknown;
}

interface AttemptRow {
  id: string;
  org_id: string;
  connector_installation_id: string;
  stream_key: string;
  delivery_id: string;
  started_at: unknown;
  finished_at: unknown;
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
  safe_metadata_json: unknown;
  created_at: unknown;
}

interface ContextProjectionJobRow {
  id: string;
  org_id: string;
  event_id: string;
  status: ContextProjectionJob["status"];
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: unknown;
  next_retry_at: unknown;
  last_error: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface ArtifactStateRow {
  org_id: string;
  artifact_id: string;
  status: ContextArtifactState["status"];
  decided_at: string;
  superseded_by: string | null;
}

interface PrefRow {
  org_id: string;
  thread_id: string;
  title: string | null;
  pinned: unknown;
  hidden: unknown;
  hidden_reason: string | null;
  last_read_at: unknown;
  last_read_external_id: string | null;
  updated_at: unknown;
}

const PREF_COLUMNS = `
  org_id, thread_id, title, pinned, hidden, hidden_reason,
  last_read_at, last_read_external_id, updated_at
`;

const INBOX_COLUMNS = `
  d.event_id, d.org_id AS disposition_org_id, d.disposition, d.layer,
  d.reason_codes, d.score, d.decided_at,
  e.id, e.source, e.external_id, e.operation, e.content_hash,
  e.parent_event_id, e.thread_id, e.actor_id, e.required_scope_ids,
  e.occurred_at, e.ingested_at
`;

const CURSOR_COLUMNS = `
  installation_id, stream_key, cursor_value, cursor_version,
  lease_owner, lease_expires_at, updated_at
`;

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
  occurred_at: string;
  expected_head_id: string | null;
}

export class PostgresAuthorityStore
  implements
    AuthorityStore,
    ConnectorRuntimeStore,
    WorkStore,
    ExecutorStore,
    ContextArtifactStore,
    ContextAuthorityReader,
    ContextProjectionOutboxStore
{
  readonly readonly = false;

  private constructor(private readonly pool: Pool) {}

  static async open(connectionString: string): Promise<PostgresAuthorityStore> {
    const pool = new Pool({ connectionString });
    try {
      await migratePostgresAuthority(pool);
      return new PostgresAuthorityStore(pool);
    } catch (error) {
      await pool.end();
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async maintainStore(): Promise<{ deleted: number }> {
    let deleted = 0;
    for (;;) {
      const batch = await this.pruneIngestAttempts(
        INGEST_ATTEMPT_KEEP_PER_INSTALLATION,
        INGEST_ATTEMPT_PRUNE_BATCH,
        INGEST_ATTEMPT_PRUNE_INSTALLATIONS,
      );
      deleted += batch.deleted;
      if (batch.deleted === 0) {
        break;
      }
    }
    return { deleted };
  }

  async vacuumStore(): Promise<void> {
    await this.pool.query("ANALYZE");
  }

  /** Live connectivity check for /health — uses the store pool, not a one-off Client. */
  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async findBySourceIdentity(
    identity: SourceIdentity,
  ): Promise<EventRecord | null> {
    return this.findCurrent(identity);
  }

  async bindSourceIdentityAliases(input: SourceIdentityAliasBind): Promise<void> {
    await this.withTx(async (client) => {
      const event = await this.getEvent(input.org_id, input.event_id, client);
      if (!event) {
        throw new Error(`Unknown event for identity alias: ${input.event_id}`);
      }
      for (const alias of input.aliases) {
        const externalId = alias.external_id.trim();
        if (!alias.source.trim() || !externalId) {
          continue;
        }
        await this.execute(
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

  async getOutboundAttempt(
    orgId: string,
    clientRequestId: string,
    client?: PoolClient,
  ): Promise<OutboundAttemptRecord | null> {
    const row = await this.queryOne<{
      org_id: string;
      client_request_id: string;
      thread_id: string;
      event_id: string | null;
      status: "pending" | "accepted" | "sent" | "failed";
      channel_message_ids: unknown;
      created_at: unknown;
      updated_at: unknown;
    }>(
      `
        SELECT org_id, client_request_id, thread_id, event_id, status,
               channel_message_ids, created_at, updated_at
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
      ...(channelMessageIds ? { channel_message_ids: channelMessageIds } : {}),
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
    };
  }

  async putOutboundAttempt(
    input: OutboundAttemptPut,
  ): Promise<OutboundAttemptRecord> {
    const previous = await this.getOutboundAttempt(
      input.org_id,
      input.client_request_id,
    );
    const createdAt = previous?.created_at ?? input.now;
    await this.execute(
      `
        INSERT INTO outbound_attempts (
          org_id, client_request_id, thread_id, event_id, status,
          channel_message_ids, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (org_id, client_request_id) DO UPDATE SET
          thread_id = EXCLUDED.thread_id,
          event_id = EXCLUDED.event_id,
          status = EXCLUDED.status,
          channel_message_ids = EXCLUDED.channel_message_ids,
          updated_at = EXCLUDED.updated_at
      `,
      [
        input.org_id,
        input.client_request_id,
        input.thread_id,
        input.event_id ?? null,
        input.status,
        jsonb(input.channel_message_ids),
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
      ...(input.channel_message_ids
        ? { channel_message_ids: [...input.channel_message_ids] }
        : {}),
      created_at: createdAt,
      updated_at: input.now,
    };
  }

  async getEvent(
    orgId: string,
    eventId: string,
    client?: PoolClient,
  ): Promise<EventRecord | null> {
    const row = await this.queryOne<EventRow>(
      `
        SELECT id, org_id, source, external_id, operation, content_hash,
               parent_event_id, thread_id, actor_id, required_scope_ids,
               occurred_at, ingested_at
        FROM events WHERE org_id = $1 AND id = $2
      `,
      [orgId, eventId],
      client,
    );
    return row ? this.toEvent(row) : null;
  }

  async listEvents(orgId: string, query?: EventListQuery): Promise<EventRecord[]> {
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
    const limit =
      typeof query?.limit === "number" &&
      Number.isInteger(query.limit) &&
      query.limit > 0
        ? query.limit
        : undefined;
    const limitSql = limit === undefined ? "" : `LIMIT ${p(limit)}`;
    const rows = await this.query<EventRow>(
      `
        SELECT id, org_id, source, external_id, operation, content_hash,
               parent_event_id, thread_id, actor_id, required_scope_ids,
               occurred_at, ingested_at
        FROM events WHERE ${clauses.join(" AND ")} ORDER BY sequence ASC
        ${limitSql}
      `,
      params,
    );
    return rows.map((row) => this.toEvent(row));
  }

  async openContextRead(orgId: string): Promise<ContextAuthorityRead> {
    return this.openContextReadInternal(orgId);
  }

  async openContextReadForThread(
    orgId: string,
    threadId: string,
  ): Promise<ContextAuthorityRead> {
    const scopedThreadId = threadId.trim();
    if (!scopedThreadId) {
      throw new Error("Context thread read requires a thread id");
    }
    return this.openContextReadInternal(orgId, scopedThreadId);
  }

  private async openContextReadInternal(
    orgId: string,
    threadId?: string,
  ): Promise<ContextAuthorityRead> {
    return this.withTx(async (client) => {
      const rows = threadId
        ? await this.query<ContextEventRow>(
            `
              SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
                     e.content_hash, e.parent_event_id, e.thread_id, e.actor_id,
                     e.required_scope_ids, e.occurred_at, e.ingested_at,
                     b.media_type AS content_media_type
              FROM events e
              LEFT JOIN blobs b ON b.content_hash = e.content_hash
              WHERE e.org_id = $1 AND e.thread_id = $2
              ORDER BY e.sequence ASC
            `,
            [orgId, threadId],
            client,
          )
        : await this.query<ContextEventRow>(
            `
              SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
                     e.content_hash, e.parent_event_id, e.thread_id, e.actor_id,
                     e.required_scope_ids, e.occurred_at, e.ingested_at,
                     b.media_type AS content_media_type
              FROM events e
              LEFT JOIN blobs b ON b.content_hash = e.content_hash
              WHERE e.org_id = $1
              ORDER BY e.sequence ASC
            `,
            [orgId],
            client,
          );
      const lifecycleHeads = threadId
        ? await this.query<ContextAuthorityRead["lifecycle_heads"][number]>(
            `
              SELECT sh.source, sh.external_id, sh.current_event_id AS head_event_id
              FROM source_heads sh
              WHERE sh.org_id = $1
                AND EXISTS (
                  SELECT 1
                  FROM events e
                  WHERE e.org_id = sh.org_id
                    AND e.source = sh.source
                    AND e.external_id = sh.external_id
                    AND e.thread_id = $2
                )
              ORDER BY sh.source ASC, sh.external_id ASC
            `,
            [orgId, threadId],
            client,
          )
        : await this.query<ContextAuthorityRead["lifecycle_heads"][number]>(
            `
              SELECT source, external_id, current_event_id AS head_event_id
              FROM source_heads
              WHERE org_id = $1
              ORDER BY source ASC, external_id ASC
            `,
            [orgId],
            client,
          );
      const recordedAt = new Date().toISOString();
      const events = rows.map((row) => ({
        ...this.toEvent(row),
        ...(row.content_media_type
          ? { content_media_type: row.content_media_type }
          : {}),
      }));
      return {
        read_epoch: `authority:${hashCanonicalContext({
          org_id: orgId,
          ...(threadId ? { thread_id: threadId } : {}),
          recorded_at: recordedAt,
          events,
          lifecycle_heads: lifecycleHeads,
        })}`,
        recorded_at: recordedAt,
        events,
        lifecycle_heads: lifecycleHeads,
      } satisfies ContextAuthorityRead;
    }, "REPEATABLE READ");
  }

  async putArtifact(artifact: ContextArtifact): Promise<ContextArtifact> {
    requireContextValue(validateContextArtifact(artifact), "artifact");
    const payload = canonicalContextJson(artifact);
    await this.putImmutableContextJson(
      "context_artifacts",
      "org_id = $1 AND id = $2",
      [artifact.org_id, artifact.id],
      payload,
      "artifact",
      `
        INSERT INTO context_artifacts (
          org_id, id, kind, status, generation, recorded_at, payload_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        artifact.org_id,
        artifact.id,
        artifact.kind,
        artifact.status,
        artifact.generation,
        artifact.recorded_at,
        payload,
      ],
    );
    await this.execute(
      `INSERT INTO context_artifact_states (org_id, artifact_id, status, decided_at) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, artifact_id) DO NOTHING`,
      [artifact.org_id, artifact.id, artifact.status, artifact.recorded_at],
    );
    return parseContextJson<ContextArtifact>(payload);
  }

  async getArtifact(orgId: string, id: string): Promise<ContextArtifact | null> {
    const row = await this.queryOne<{ payload_json: unknown; lifecycle_status: ContextArtifact["status"] }>(
      `SELECT a.payload_json, s.status AS lifecycle_status FROM context_artifacts a JOIN context_artifact_states s ON s.org_id = a.org_id AND s.artifact_id = a.id WHERE a.org_id = $1 AND a.id = $2`,
      [orgId, id],
    );
    return row ? { ...parseContextJson<ContextArtifact>(row.payload_json), status: row.lifecycle_status } : null;
  }

  async listArtifacts(query: ContextArtifactQuery): Promise<ContextArtifact[]> {
    const validation = validateContextArtifactQuery(query);
    requireContextValue(validation, "artifact query");
    const stableQuery = validation.success ? validation.data : query;
    const params: unknown[] = [];
    const p = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const clauses = [`a.org_id = ${p(stableQuery.org_id)}`];
    if (stableQuery.kinds) {
      if (stableQuery.kinds.length === 0) {
        return [];
      }
      clauses.push(
        `a.kind IN (${stableQuery.kinds.map((kind) => p(kind)).join(", ")})`,
      );
    }
    if (stableQuery.statuses) {
      if (stableQuery.statuses.length === 0) {
        return [];
      }
      clauses.push(
        `s.status IN (${stableQuery.statuses.map((status) => p(status)).join(", ")})`,
      );
    }
    if (stableQuery.generation) {
      clauses.push(`a.generation = ${p(stableQuery.generation)}`);
    }
    const limit = stableQuery.limit;
    const limitSql =
      typeof limit === "number" && Number.isFinite(limit)
        ? `LIMIT ${p(limit)}`
        : "";
    const rows = await this.query<{ payload_json: unknown; lifecycle_status: ContextArtifact["status"] }>(
      `
        SELECT a.payload_json, s.status AS lifecycle_status FROM context_artifacts a
        JOIN context_artifact_states s ON s.org_id = a.org_id AND s.artifact_id = a.id
        WHERE ${clauses.join(" AND ")}
        ORDER BY a.recorded_at ASC, a.id ASC
        ${limitSql}
      `,
      params,
    );
    return rows.map((row) => ({ ...parseContextJson<ContextArtifact>(row.payload_json), status: row.lifecycle_status }));
  }

  async getArtifactState(orgId: string, artifactId: string): Promise<ContextArtifactState | null> {
    const row = await this.queryOne<ArtifactStateRow>(
      `SELECT org_id, artifact_id, status, decided_at, superseded_by FROM context_artifact_states WHERE org_id = $1 AND artifact_id = $2`,
      [orgId, artifactId],
    );
    return row ? artifactState(row) : null;
  }

  async decideArtifact(input: ContextArtifactDecision): Promise<ContextArtifactState> {
    assertArtifactDecision(input);
    return this.withTx(async (client) => {
      const state = await this.transitionableArtifact(input.org_id, input.artifact_id, client);
      await this.execute(`UPDATE context_artifact_states SET status = $1, decided_at = $2, superseded_by = NULL WHERE org_id = $3 AND artifact_id = $4`, [input.status, input.decided_at, input.org_id, input.artifact_id], client);
      return { ...state, status: input.status, decided_at: input.decided_at } as ContextArtifactState;
    });
  }

  async supersedeArtifact(input: ContextArtifactSupersession): Promise<{ superseded: ContextArtifactState; accepted: ContextArtifactState }> {
    assertArtifactSupersession(input);
    return this.withTx(async (client) => {
      const current = await this.queryOne<ArtifactStateRow>(`SELECT org_id, artifact_id, status, decided_at, superseded_by FROM context_artifact_states WHERE org_id = $1 AND artifact_id = $2 FOR UPDATE`, [input.org_id, input.artifact_id], client);
      const replacement = await this.transitionableArtifact(input.org_id, input.replacement_id, client);
      const artifactRow = await this.queryOne<{ payload_json: unknown }>(
        `SELECT payload_json FROM context_artifacts WHERE org_id = $1 AND id = $2`,
        [input.org_id, input.replacement_id],
        client,
      );
      const artifact = artifactRow
        ? parseContextJson<ContextArtifact>(artifactRow.payload_json)
        : null;
      if (!current || current.status !== "accepted" || !artifact || artifact.supersedes_id !== input.artifact_id) throw new Error("Invalid Context artifact supersession");
      await this.execute(`UPDATE context_artifact_states SET status = 'superseded', decided_at = $1, superseded_by = $2 WHERE org_id = $3 AND artifact_id = $4`, [input.decided_at, input.replacement_id, input.org_id, input.artifact_id], client);
      await this.execute(`UPDATE context_artifact_states SET status = 'accepted', decided_at = $1, superseded_by = NULL WHERE org_id = $2 AND artifact_id = $3`, [input.decided_at, input.org_id, input.replacement_id], client);
      return {
        superseded: { ...artifactState(current), status: "superseded", decided_at: input.decided_at, superseded_by: input.replacement_id },
        accepted: { ...replacement, status: "accepted", decided_at: input.decided_at },
      };
    });
  }

  async putSnapshot(snapshot: ContextSnapshot): Promise<void> {
    requireContextValue(validateContextSnapshot(snapshot), "snapshot");
    const payload = canonicalContextJson(snapshot);
    await this.putImmutableContextJson(
      "context_snapshots",
      "org_id = $1 AND id = $2",
      [snapshot.org_id, snapshot.id],
      payload,
      "snapshot",
      "INSERT INTO context_snapshots (org_id, id, payload_json) VALUES ($1, $2, $3)",
      [snapshot.org_id, snapshot.id, payload],
    );
  }

  async getSnapshot(orgId: string, id: string): Promise<ContextSnapshot | null> {
    return this.getContextJson<ContextSnapshot>(
      "context_snapshots",
      "org_id = $1 AND id = $2",
      [orgId, id],
    );
  }

  async putBundle(bundle: ContextBundle): Promise<void> {
    requireContextValue(validateContextBundle(bundle), "bundle");
    const payload = canonicalContextJson(bundle);
    const lookup = [
      bundle.org_id,
      bundle.snapshot_id,
      bundle.principal.actor_type,
      bundle.principal.actor_id,
      bundle.consumer_id,
    ];
    await this.putImmutableContextJson(
      "context_bundles",
      `
        org_id = $1 AND snapshot_id = $2 AND principal_actor_type = $3
        AND principal_actor_id = $4 AND consumer_id = $5
      `,
      lookup,
      payload,
      "bundle",
      `
        INSERT INTO context_bundles (
          org_id, snapshot_id, principal_actor_type, principal_actor_id,
          consumer_id, payload_json
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [...lookup, payload],
    );
  }

  async getBundle(query: ContextBundleLookup): Promise<ContextBundle | null> {
    return this.getContextJson<ContextBundle>(
      "context_bundles",
      `
        org_id = $1 AND snapshot_id = $2 AND principal_actor_type = $3
        AND principal_actor_id = $4 AND consumer_id = $5
      `,
      [
        query.org_id,
        query.snapshot_id,
        query.principal.actor_type,
        query.principal.actor_id,
        query.consumer_id,
      ],
    );
  }

  async putCheckpoint(checkpoint: ContextProjectionCheckpoint): Promise<void> {
    const validation = validateContextProjectionCheckpoint(checkpoint);
    requireContextValue(validation, "projection checkpoint");
    const stableCheckpoint = validation.success ? validation.data : checkpoint;
    await this.withTx(async (client) => {
      const current = await this.queryOne<{ payload_json: unknown }>(
        `
          SELECT payload_json FROM context_projection_checkpoints
          WHERE org_id = $1 AND projector_id = $2 AND generation = $3
        `,
        [
          stableCheckpoint.org_id,
          stableCheckpoint.projector_id,
          stableCheckpoint.generation,
        ],
        client,
      );
      if (current) {
        const stored = parseContextJson<ContextProjectionCheckpoint>(
          current.payload_json,
        );
        if (stored.algorithm_version !== stableCheckpoint.algorithm_version) {
          throw new Error(
            "Projection checkpoint algorithm cannot change within a generation",
          );
        }
        if (stored.sequence > stableCheckpoint.sequence) {
          throw new Error("Projection checkpoint cannot move backwards");
        }
        if (stored.sequence === stableCheckpoint.sequence) {
          if (
            canonicalContextJson(stored) !==
            canonicalContextJson(stableCheckpoint)
          ) {
            throw new Error(
              "Projection checkpoint cannot change at the same sequence",
            );
          }
          return;
        }
      }
      const payload = canonicalContextJson(stableCheckpoint);
      await this.execute(
        `
          INSERT INTO context_projection_checkpoints (
            org_id, projector_id, generation, algorithm_version,
            sequence, watermark, updated_at, payload_json
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (org_id, projector_id, generation) DO UPDATE SET
            algorithm_version = EXCLUDED.algorithm_version,
            sequence = EXCLUDED.sequence,
            watermark = EXCLUDED.watermark,
            updated_at = EXCLUDED.updated_at,
            payload_json = EXCLUDED.payload_json
        `,
        [
          stableCheckpoint.org_id,
          stableCheckpoint.projector_id,
          stableCheckpoint.generation,
          stableCheckpoint.algorithm_version,
          stableCheckpoint.sequence,
          stableCheckpoint.watermark,
          stableCheckpoint.updated_at,
          payload,
        ],
        client,
      );
    });
  }

  async getCheckpoint(
    orgId: string,
    projectorId: string,
    generation: string,
  ): Promise<ContextProjectionCheckpoint | null> {
    return this.getContextJson<ContextProjectionCheckpoint>(
      "context_projection_checkpoints",
      "org_id = $1 AND projector_id = $2 AND generation = $3",
      [orgId, projectorId, generation],
    );
  }

  async claimContextProjectionJobs(
    input: ClaimContextProjectionJobs,
  ): Promise<ContextProjectionJob[]> {
    assertProjectionClaim(input);
    return this.withTx(async (client) => {
      const rows = await this.query<{ id: string }>(
        `
          SELECT id FROM context_projection_outbox
          WHERE status = 'pending'
             OR (status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= $1::timestamptz))
             OR (status = 'running' AND lease_expires_at <= $1::timestamptz)
          ORDER BY created_at, id
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        `,
        [input.now, input.limit],
        client,
      );
      if (rows.length === 0) {
        return [];
      }
      const leaseExpiresAt = new Date(
        Date.parse(input.now) + input.lease_ms,
      ).toISOString();
      const ids = rows.map((row) => row.id);
      await this.execute(
        `
          UPDATE context_projection_outbox
          SET status = 'running', attempts = attempts + 1,
              lease_owner = $1, lease_expires_at = $2, next_retry_at = NULL,
              last_error = NULL, updated_at = $3
          WHERE id = ANY($4::text[])
        `,
        [input.owner, leaseExpiresAt, input.now, ids],
        client,
      );
      const jobs = await this.query<ContextProjectionJobRow>(
        `
          SELECT id, org_id, event_id, status, attempts, lease_owner,
                 lease_expires_at, next_retry_at, last_error, created_at, updated_at
          FROM context_projection_outbox WHERE id = ANY($1::text[])
        `,
        [ids],
        client,
      );
      const byId = new Map(
        jobs.map((job) => [job.id, toContextProjectionJob(job)] as const),
      );
      return ids.map((id) => byId.get(id)!);
    });
  }

  async completeContextProjectionJob(
    input: CompleteContextProjectionJob,
  ): Promise<boolean> {
    assertProjectionSettle(input.id, input.owner, input.completed_at);
    const rowCount = await this.execute(
      `
        UPDATE context_projection_outbox
        SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
            next_retry_at = NULL, last_error = NULL, updated_at = $1
        WHERE id = $2 AND status = 'running' AND lease_owner = $3
      `,
      [input.completed_at, input.id, input.owner],
    );
    return rowCount === 1;
  }

  async renewContextProjectionJob(input: RenewContextProjectionJob): Promise<boolean> {
    assertProjectionSettle(input.id, input.owner, input.now);
    if (!Number.isSafeInteger(input.lease_ms) || input.lease_ms < 1) throw new Error("Invalid Context projection lease renewal");
    return await this.execute(
      `UPDATE context_projection_outbox SET lease_expires_at = $1, updated_at = $2 WHERE id = $3 AND status = 'running' AND lease_owner = $4 AND lease_expires_at > $2::timestamptz`,
      [new Date(Date.parse(input.now) + input.lease_ms).toISOString(), input.now, input.id, input.owner],
    ) === 1;
  }

  async failContextProjectionJob(input: FailContextProjectionJob): Promise<boolean> {
    assertProjectionSettle(input.id, input.owner, input.failed_at);
    if (Number.isNaN(Date.parse(input.next_retry_at)) || !input.error_code.trim()) {
      throw new Error("Invalid Context projection failure");
    }
    const rowCount = await this.execute(
      `
        UPDATE context_projection_outbox
        SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
            next_retry_at = $1, last_error = $2, updated_at = $3
        WHERE id = $4 AND status = 'running' AND lease_owner = $5
      `,
      [
        input.next_retry_at,
        input.error_code.slice(0, 120),
        input.failed_at,
        input.id,
        input.owner,
      ],
    );
    return rowCount === 1;
  }

  async listContextProjectionJobs(orgId: string): Promise<ContextProjectionJob[]> {
    const rows = await this.query<ContextProjectionJobRow>(
      `
        SELECT id, org_id, event_id, status, attempts, lease_owner,
               lease_expires_at, next_retry_at, last_error, created_at, updated_at
        FROM context_projection_outbox WHERE org_id = $1 ORDER BY created_at, id
      `,
      [orgId],
    );
    return rows.map(toContextProjectionJob);
  }

  async putDisposition(decision: ArrangementDecision): Promise<void> {
    await this.putDispositionWithinTransaction(decision);
  }

  private async putDispositionWithinTransaction(
    decision: ArrangementDecision,
    client?: PoolClient,
  ): Promise<void> {
    await this.execute(
      `
        INSERT INTO message_dispositions (
          event_id, org_id, disposition, layer, reason_codes, score, decided_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (event_id) DO UPDATE SET
          org_id = EXCLUDED.org_id,
          disposition = EXCLUDED.disposition,
          layer = EXCLUDED.layer,
          reason_codes = EXCLUDED.reason_codes,
          score = EXCLUDED.score,
          decided_at = EXCLUDED.decided_at
      `,
      [
        decision.event_id,
        decision.org_id,
        decision.disposition,
        decision.layer,
        jsonb(decision.reason_codes),
        decision.score,
        decision.decided_at,
      ],
      client,
    );
    const row = await this.queryOne<{ thread_id: string | null }>(
      `SELECT thread_id FROM events WHERE id = $1`,
      [decision.event_id],
      client,
    );
    await this.refreshThreadHeadWithinTransaction(
      decision.org_id,
      row?.thread_id,
      client,
    );
  }

  async getDisposition(eventId: string): Promise<ArrangementDecision | null> {
    const row = await this.queryOne<DispositionRow>(
      `
        SELECT event_id, org_id, disposition, layer, reason_codes, score, decided_at
        FROM message_dispositions WHERE event_id = $1
      `,
      [eventId],
    );
    return row ? this.toDisposition(row) : null;
  }

  async listInbox(orgId: string, query?: InboxQuery): Promise<InboxItem[]> {
    if (query?.thread_ids && query.thread_ids.length === 0) {
      return [];
    }
    const { sql, params } = this.inboxSql(orgId, query);
    const rows = await this.query<InboxRow>(sql, params);
    const items = rows.map((row) => this.toInboxItem(row));
    if (inboxUsesNewestFirst(query)) {
      items.reverse();
    }
    return items;
  }

  async summarizeInbox(orgId: string): Promise<InboxSummary> {
    const latest = await this.queryOne<{ latest_at: unknown; latest_id: string }>(
      `
        SELECT e.ingested_at AS latest_at, e.id AS latest_id
        FROM events e
        JOIN message_dispositions d ON d.event_id = e.id
        WHERE e.org_id = $1
          AND d.disposition = 'current_work'
          AND ${isCurrentHeadSql("e")}
          AND ${notHiddenSql("$2", "e")}
        ORDER BY e.ingested_at DESC, e.id DESC
        LIMIT 1
      `,
      [orgId, orgId],
    );
    const counted = await this.queryOne<{ count: unknown }>(
      `
        SELECT COUNT(*)::int AS count
        FROM thread_heads th
        WHERE th.org_id = $1
          AND th.has_current_work = TRUE
          AND th.thread_id NOT IN (
            SELECT p.thread_id FROM conversation_prefs p
            WHERE p.org_id = $2 AND p.hidden = TRUE
          )
      `,
      [orgId, orgId],
    );
    const prefs = await this.queryOne<{
      pref_count: unknown;
      pref_updated_at: unknown;
    }>(
      `
        SELECT COUNT(*)::int AS pref_count,
               MAX(updated_at) AS pref_updated_at
        FROM conversation_prefs WHERE org_id = $1
      `,
      [orgId],
    );
    const work = await this.queryOne<{ work_updated_at: unknown }>(
      `
        SELECT MAX(updated_at) AS work_updated_at FROM (
          SELECT updated_at FROM work_items WHERE org_id = $1
          UNION ALL
          SELECT updated_at FROM work_deliveries WHERE org_id = $2
        ) work_times
      `,
      [orgId, orgId],
    );
    const count = asNumber(counted?.count ?? 0);
    return {
      count,
      digest: formatInboxDigest({
        count,
        latest_at: latest ? toIso(latest.latest_at) : "",
        latest_id: latest?.latest_id ?? "",
        pref_count: asNumber(prefs?.pref_count ?? 0),
        pref_updated_at: prefs?.pref_updated_at ? toIso(prefs.pref_updated_at) : "",
        work_updated_at: work?.work_updated_at ? toIso(work.work_updated_at) : "",
      }),
    };
  }

  async listConversationPrefs(orgId: string): Promise<ConversationPref[]> {
    const rows = await this.query<PrefRow>(
      `
        SELECT ${PREF_COLUMNS}
        FROM conversation_prefs WHERE org_id = $1
        ORDER BY pinned DESC, updated_at DESC
      `,
      [orgId],
    );
    return rows.map((row) => this.toPref(row));
  }

  async getConversationPref(
    orgId: string,
    threadId: string,
    client?: PoolClient,
  ): Promise<ConversationPref | null> {
    const row = await this.queryOne<PrefRow>(
      `
        SELECT ${PREF_COLUMNS}
        FROM conversation_prefs WHERE org_id = $1 AND thread_id = $2
      `,
      [orgId, threadId],
      client,
    );
    return row ? this.toPref(row) : null;
  }

  async putConversationPref(
    input: ConversationPrefPatch,
  ): Promise<ConversationPref> {
    return this.withTx(async (client) => {
      const current = await this.queryOne<PrefRow>(
        `
          SELECT ${PREF_COLUMNS}
          FROM conversation_prefs WHERE org_id = $1 AND thread_id = $2
        `,
        [input.org_id, input.thread_id],
        client,
      );
      const hidden =
        input.hidden !== undefined ? input.hidden : asBool(current?.hidden);
      const next: ConversationPref = {
        org_id: input.org_id,
        thread_id: input.thread_id,
        title: input.title !== undefined ? input.title : (current?.title ?? null),
        pinned:
          input.pinned !== undefined ? input.pinned : asBool(current?.pinned),
        hidden,
        hidden_reason: hidden
          ? input.hidden_reason !== undefined
            ? input.hidden_reason
            : normalizeHiddenReason(current?.hidden_reason) ??
              (input.hidden === true ? "human" : null)
          : null,
        last_read_at:
          input.last_read_at !== undefined
            ? input.last_read_at
            : toIsoOrNull(current?.last_read_at),
        last_read_external_id:
          input.last_read_external_id !== undefined
            ? input.last_read_external_id
            : (current?.last_read_external_id ?? null),
        updated_at: input.updated_at,
      };
      await this.execute(
        `
          INSERT INTO conversation_prefs (
            org_id, thread_id, title, pinned, hidden, hidden_reason,
            last_read_at, last_read_external_id, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (org_id, thread_id) DO UPDATE SET
            title = EXCLUDED.title,
            pinned = EXCLUDED.pinned,
            hidden = EXCLUDED.hidden,
            hidden_reason = EXCLUDED.hidden_reason,
            last_read_at = EXCLUDED.last_read_at,
            last_read_external_id = EXCLUDED.last_read_external_id,
            updated_at = EXCLUDED.updated_at
        `,
        [
          next.org_id,
          next.thread_id,
          next.title,
          next.pinned,
          next.hidden,
          next.hidden_reason,
          next.last_read_at,
          next.last_read_external_id,
          next.updated_at,
        ],
        client,
      );
      return next;
    });
  }

  async summarizeStore(orgId: string): Promise<StoreFootprint> {
    return this.storeFootprint(orgId);
  }

  async clearOperationalData(
    orgId: string,
    now: string,
  ): Promise<StoreClearResult> {
    return this.withTx(async (client) => {
      const before = await this.storeFootprint(orgId, client);
      await this.execute(`DELETE FROM work_deliveries WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM work_runs WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM work_items WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM context_bundles WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM context_snapshots WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM context_artifact_states WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM context_artifacts WHERE org_id = $1`, [orgId], client);
      await this.execute(
        `DELETE FROM context_projection_checkpoints WHERE org_id = $1`,
        [orgId],
        client,
      );
      await this.execute(
        `DELETE FROM context_projection_outbox WHERE org_id = $1`,
        [orgId],
        client,
      );
      await this.execute(
        `DELETE FROM message_dispositions WHERE org_id = $1`,
        [orgId],
        client,
      );
      await this.execute(
        `DELETE FROM conversation_prefs WHERE org_id = $1`,
        [orgId],
        client,
      );
      await this.execute(
        `
          DELETE FROM ingest_quarantines
          WHERE attempt_id IN (
            SELECT id FROM ingest_attempts WHERE org_id = $1
          )
        `,
        [orgId],
        client,
      );
      await this.execute(`DELETE FROM ingest_attempts WHERE org_id = $1`, [orgId], client);
      await this.execute(
        `DELETE FROM outbound_attempts WHERE org_id = $1`,
        [orgId],
        client,
      );
      await this.execute(`DELETE FROM source_heads WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM thread_heads WHERE org_id = $1`, [orgId], client);
      await this.execute(`DELETE FROM events WHERE org_id = $1`, [orgId], client);
      await this.execute(
        `
          DELETE FROM blobs
          WHERE content_hash NOT IN (
            SELECT content_hash FROM events WHERE content_hash IS NOT NULL
          )
        `,
        [],
        client,
      );
      await this.execute(
        `
          UPDATE connector_cursors
          SET cursor_value = NULL,
              cursor_version = cursor_version + 1,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = $1
          WHERE installation_id IN (
            SELECT id FROM connector_installations WHERE org_id = $2
          )
        `,
        [now, orgId],
        client,
      );
      await this.execute(
        `
          DELETE FROM connector_sync_state
          WHERE installation_id IN (
            SELECT id FROM connector_installations WHERE org_id = $1
          )
        `,
        [orgId],
        client,
      );
      await this.execute(
        `
          DELETE FROM connector_stream_members
          WHERE installation_id IN (
            SELECT id FROM connector_installations WHERE org_id = $1
          )
        `,
        [orgId],
        client,
      );
      await this.execute(
        `
          DELETE FROM connector_catalog_cursors
          WHERE installation_id IN (
            SELECT id FROM connector_installations WHERE org_id = $1
          )
        `,
        [orgId],
        client,
      );
      const after = await this.storeFootprint(orgId, client);
      return {
        cleared: {
          events: before.events,
          conversations: before.conversations,
          work_items: before.work_items,
          blobs: before.blobs,
          context_artifacts: before.context_artifacts,
          context_snapshots: before.context_snapshots,
          context_bundles: before.context_bundles,
          context_checkpoints: before.context_checkpoints,
        },
        kept: {
          recipes: after.recipes,
          connectors: after.connectors,
          executors: after.executors,
        },
      } satisfies StoreClearResult;
    });
  }

  private async storeFootprint(
    orgId: string,
    client?: PoolClient,
  ): Promise<StoreFootprint> {
    const count = (sql: string, params: unknown[]): Promise<number> =>
      this.queryOne<{ n: unknown }>(sql, params, client).then((row) =>
        asNumber(row?.n ?? 0),
      );
    return {
      events: await count(
        `SELECT COUNT(*)::int AS n FROM events WHERE org_id = $1`,
        [orgId],
      ),
      conversations: await count(
        `
          SELECT COUNT(DISTINCT thread_id)::int AS n
          FROM events
          WHERE org_id = $1 AND thread_id IS NOT NULL AND thread_id != ''
        `,
        [orgId],
      ),
      work_items: await count(
        `SELECT COUNT(*)::int AS n FROM work_items WHERE org_id = $1`,
        [orgId],
      ),
      blobs: await count(
        `
          SELECT COUNT(DISTINCT content_hash)::int AS n
          FROM events
          WHERE org_id = $1 AND content_hash IS NOT NULL
        `,
        [orgId],
      ),
      context_artifacts: await count(
        `SELECT COUNT(*)::int AS n FROM context_artifacts WHERE org_id = $1`,
        [orgId],
      ),
      context_snapshots: await count(
        `SELECT COUNT(*)::int AS n FROM context_snapshots WHERE org_id = $1`,
        [orgId],
      ),
      context_bundles: await count(
        `SELECT COUNT(*)::int AS n FROM context_bundles WHERE org_id = $1`,
        [orgId],
      ),
      context_checkpoints: await count(
        `SELECT COUNT(*)::int AS n FROM context_projection_checkpoints WHERE org_id = $1`,
        [orgId],
      ),
      recipes: await count(
        `SELECT COUNT(*)::int AS n FROM recipes WHERE org_id = $1`,
        [orgId],
      ),
      connectors: await count(
        `SELECT COUNT(*)::int AS n FROM connector_installations WHERE org_id = $1`,
        [orgId],
      ),
      executors: await count(
        `SELECT COUNT(*)::int AS n FROM executor_installations WHERE org_id = $1`,
        [orgId],
      ),
    };
  }

  async listRecipes(orgId: string): Promise<Recipe[]> {
    const rows = await this.query<RecipeRow>(
      `SELECT * FROM recipes WHERE org_id = $1 ORDER BY updated_at DESC, id`,
      [orgId],
    );
    return rows.map(toRecipe);
  }

  async getRecipe(orgId: string, id: string): Promise<Recipe | null> {
    const row = await this.queryOne<RecipeRow>(
      `SELECT * FROM recipes WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return row ? toRecipe(row) : null;
  }

  async putRecipe(recipe: Recipe): Promise<Recipe> {
    const trigger = recipeTriggerOf(recipe);
    await this.execute(
      `
        INSERT INTO recipes (
          id, org_id, name, match_json, executor_type, executor_config_json,
          can_write_back, include_context, enabled, trigger_kind,
          trigger_interval_ms, trigger_coalesce, max_concurrent, next_run_at, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          match_json = EXCLUDED.match_json,
          executor_type = EXCLUDED.executor_type,
          executor_config_json = EXCLUDED.executor_config_json,
          can_write_back = EXCLUDED.can_write_back,
          include_context = EXCLUDED.include_context,
          enabled = EXCLUDED.enabled,
          trigger_kind = EXCLUDED.trigger_kind,
          trigger_interval_ms = EXCLUDED.trigger_interval_ms,
          trigger_coalesce = EXCLUDED.trigger_coalesce,
          max_concurrent = EXCLUDED.max_concurrent,
          next_run_at = EXCLUDED.next_run_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        recipe.id,
        recipe.org_id,
        recipe.name,
        jsonb(recipe.match),
        recipe.executor_type,
        jsonb(recipe.executor_config),
        recipe.can_write_back,
        recipe.include_context,
        recipe.enabled,
        trigger.kind,
        trigger.kind === "pull" ? (trigger.interval_ms ?? null) : null,
        trigger.kind === "push" && trigger.coalesce !== false,
        recipe.max_concurrent ?? null,
        recipe.next_run_at ?? null,
        recipe.created_at,
        recipe.updated_at,
      ],
    );
    return recipe;
  }

  async deleteRecipe(orgId: string, id: string): Promise<boolean> {
    const rowCount = await this.execute(
      `DELETE FROM recipes WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return rowCount > 0;
  }

  async listWorkItems(orgId: string): Promise<WorkItem[]> {
    const rows = await this.query<WorkItemRow>(
      `SELECT * FROM work_items WHERE org_id = $1 ORDER BY updated_at DESC, id`,
      [orgId],
    );
    return rows.map(toWorkItem);
  }

  async getWorkItem(orgId: string, id: string): Promise<WorkItem | null> {
    const row = await this.queryOne<WorkItemRow>(
      `SELECT * FROM work_items WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return row ? toWorkItem(row) : null;
  }

  async getWorkItemByThread(
    orgId: string,
    threadId: string,
  ): Promise<WorkItem | null> {
    const row = await this.queryOne<WorkItemRow>(
      `SELECT * FROM work_items WHERE org_id = $1 AND thread_id = $2
       ORDER BY CASE WHEN status IN ('open', 'running', 'waiting_human') THEN 0 ELSE 1 END,
                created_at DESC, id DESC
       LIMIT 1`,
      [orgId, threadId],
    );
    return row ? toWorkItem(row) : null;
  }

  async putWorkItem(item: WorkItem): Promise<WorkItem> {
    await this.execute(
      `
        INSERT INTO work_items (
          id, org_id, thread_id, unit_key, head_event_id, record_class, thread_facet,
          status, recipe_id, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET
          thread_id = EXCLUDED.thread_id,
          unit_key = EXCLUDED.unit_key,
          head_event_id = EXCLUDED.head_event_id,
          record_class = EXCLUDED.record_class,
          thread_facet = EXCLUDED.thread_facet,
          status = EXCLUDED.status,
          recipe_id = EXCLUDED.recipe_id,
          updated_at = EXCLUDED.updated_at
      `,
      [
        item.id,
        item.org_id,
        item.thread_id,
        item.unit_key,
        item.head_event_id ?? null,
        item.record_class,
        item.thread_facet,
        item.status,
        item.recipe_id ?? null,
        item.created_at,
        item.updated_at,
      ],
    );
    return item;
  }

  async listWorkRuns(orgId: string, workItemId?: string): Promise<WorkRun[]> {
    const rows = workItemId
      ? await this.query<WorkRunRow>(
          `SELECT * FROM work_runs WHERE org_id = $1 AND work_item_id = $2
           ORDER BY updated_at DESC, id`,
          [orgId, workItemId],
        )
      : await this.query<WorkRunRow>(
          `SELECT * FROM work_runs WHERE org_id = $1 ORDER BY updated_at DESC, id`,
          [orgId],
        );
    return rows.map(toWorkRun);
  }

  async getWorkRun(orgId: string, id: string): Promise<WorkRun | null> {
    const row = await this.queryOne<WorkRunRow>(
      `SELECT * FROM work_runs WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return row ? toWorkRun(row) : null;
  }

  async getActiveWorkRun(
    orgId: string,
    workItemId: string,
  ): Promise<WorkRun | null> {
    const row = await this.queryOne<WorkRunRow>(
      `SELECT * FROM work_runs
       WHERE org_id = $1 AND work_item_id = $2
         AND status IN ('running', 'waiting_human')
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
      [orgId, workItemId],
    );
    return row ? toWorkRun(row) : null;
  }

  async putWorkRun(run: WorkRun): Promise<WorkRun> {
    await this.execute(
      `
        INSERT INTO work_runs (
          id, org_id, work_item_id, recipe_id, executor_type, external_run_id,
          agent_thread_id, status, result_json, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET
          recipe_id = EXCLUDED.recipe_id,
          executor_type = EXCLUDED.executor_type,
          external_run_id = EXCLUDED.external_run_id,
          agent_thread_id = EXCLUDED.agent_thread_id,
          status = EXCLUDED.status,
          result_json = EXCLUDED.result_json,
          updated_at = EXCLUDED.updated_at
      `,
      [
        run.id,
        run.org_id,
        run.work_item_id,
        run.recipe_id,
        run.executor_type,
        run.external_run_id ?? null,
        run.agent_thread_id ?? null,
        run.status,
        jsonb(run.result),
        run.created_at,
        run.updated_at,
      ],
    );
    return run;
  }

  async listWorkDeliveries(orgId: string): Promise<WorkDelivery[]> {
    const rows = await this.query<WorkDeliveryRow>(
      `SELECT * FROM work_deliveries WHERE org_id = $1 ORDER BY updated_at DESC, id`,
      [orgId],
    );
    return rows.map(toWorkDelivery);
  }

  async getWorkDelivery(orgId: string, id: string): Promise<WorkDelivery | null> {
    const row = await this.queryOne<WorkDeliveryRow>(
      `SELECT * FROM work_deliveries WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return row ? toWorkDelivery(row) : null;
  }

  async getWorkDeliveryByItem(
    orgId: string,
    workItemId: string,
  ): Promise<WorkDelivery | null> {
    const row = await this.queryOne<WorkDeliveryRow>(
      `SELECT * FROM work_deliveries WHERE org_id = $1 AND work_item_id = $2`,
      [orgId, workItemId],
    );
    return row ? toWorkDelivery(row) : null;
  }

  async putWorkDelivery(delivery: WorkDelivery): Promise<WorkDelivery> {
    await this.execute(
      `
        INSERT INTO work_deliveries (
          id, org_id, work_item_id, recipe_id, kind, unit_key, event_id,
          status, write_back, attempts, last_error, next_retry_at,
          payload_json, lease_expires_at, idempotency_key, channel_receipt_json,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
        ON CONFLICT (id) DO UPDATE SET
          recipe_id = EXCLUDED.recipe_id,
          kind = EXCLUDED.kind,
          unit_key = EXCLUDED.unit_key,
          event_id = EXCLUDED.event_id,
          status = EXCLUDED.status,
          write_back = EXCLUDED.write_back,
          attempts = EXCLUDED.attempts,
          last_error = EXCLUDED.last_error,
          next_retry_at = EXCLUDED.next_retry_at,
          payload_json = EXCLUDED.payload_json,
          lease_expires_at = EXCLUDED.lease_expires_at,
          idempotency_key = EXCLUDED.idempotency_key,
          channel_receipt_json = EXCLUDED.channel_receipt_json,
          updated_at = EXCLUDED.updated_at
      `,
      [
        delivery.id,
        delivery.org_id,
        delivery.work_item_id,
        delivery.recipe_id,
        delivery.kind,
        delivery.unit_key,
        delivery.event_id ?? null,
        delivery.status,
        delivery.write_back,
        delivery.attempts,
        delivery.last_error ?? null,
        delivery.next_retry_at ?? null,
        jsonb(delivery.payload),
        delivery.lease_expires_at ?? null,
        delivery.idempotency_key ?? null,
        jsonb(delivery.channel_receipt),
        delivery.created_at,
        delivery.updated_at,
      ],
    );
    return delivery;
  }

  async getUiPref(orgId: string, key: string): Promise<string | null> {
    const row = await this.queryOne<{ value: string }>(
      `SELECT value FROM ui_prefs WHERE org_id = $1 AND key = $2`,
      [orgId, key],
    );
    return row?.value ?? null;
  }

  async putUiPref(
    orgId: string,
    key: string,
    value: string,
    updatedAt: string,
  ): Promise<void> {
    await this.execute(
      `
        INSERT INTO ui_prefs (org_id, key, value, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (org_id, key) DO UPDATE SET
          value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at
      `,
      [orgId, key, value, updatedAt],
    );
  }

  async listExecutorInstallations(
    orgId: string,
  ): Promise<ExecutorInstallation[]> {
    const rows = await this.query<ExecutorRow>(
      `
        SELECT * FROM executor_installations
        WHERE org_id = $1 ORDER BY updated_at DESC, id
      `,
      [orgId],
    );
    return rows.map(toExecutorInstallation);
  }

  async getExecutorInstallation(
    orgId: string,
    id: string,
  ): Promise<ExecutorInstallation | null> {
    const row = await this.queryOne<ExecutorRow>(
      `SELECT * FROM executor_installations WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return row ? toExecutorInstallation(row) : null;
  }

  async putExecutorInstallation(
    installation: ExecutorInstallation,
  ): Promise<ExecutorInstallation> {
    await this.execute(
      `
        INSERT INTO executor_installations (
          id, org_id, kind, name, status, config_json, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          kind = EXCLUDED.kind,
          name = EXCLUDED.name,
          status = EXCLUDED.status,
          config_json = EXCLUDED.config_json,
          updated_at = EXCLUDED.updated_at
      `,
      [
        installation.id,
        installation.org_id,
        installation.kind,
        installation.name,
        installation.status,
        jsonb(installation.config),
        installation.created_at,
        installation.updated_at,
      ],
    );
    return installation;
  }

  async deleteExecutorInstallation(orgId: string, id: string): Promise<boolean> {
    const rowCount = await this.execute(
      `DELETE FROM executor_installations WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    return rowCount > 0;
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
      const params: unknown[] = [];
      const placeholders = chunk.map((hash) => {
        params.push(hash);
        return `$${params.length}`;
      });
      const rows = await this.query<BlobRow>(
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

  async append(input: NewEvent): Promise<EventRecord> {
    return this.insert({ ...input, operation: "create" });
  }

  async repointContentHash(input: RepointContentInput): Promise<number> {
    return this.withTx(async (client) => {
      const now = new Date().toISOString();
      await this.insertBlobRow(
        input.new_content_hash,
        input.content_media_type,
        input.content_byte_size,
        now,
        client,
      );
      for (const blob of input.extra_blobs ?? []) {
        await this.insertBlobRow(
          blob.content_hash,
          blob.media_type,
          blob.byte_size,
          now,
          client,
        );
      }
      const updated = await this.execute(
        `UPDATE events SET content_hash = $1 WHERE content_hash = $2`,
        [input.new_content_hash, input.old_content_hash],
        client,
      );
      if (input.old_content_hash !== input.new_content_hash) {
        await this.execute(
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

  private async insertBlobRow(
    contentHash: string,
    mediaType: string | undefined,
    byteSize: number | undefined,
    createdAt: string,
    client: PoolClient,
  ): Promise<void> {
    await this.execute(
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

  async commitIngest(request: IngestCommitRequest): Promise<EventRecord[]> {
    if (request.appends.length === 0 && request.dispositions.length === 0) {
      return [];
    }
    return this.withTx(async (client) => {
      const events: EventRecord[] = [];
      for (const input of request.appends) {
        events.push(
          await this.insertWithinTransaction(
            { ...input, operation: "create" },
            client,
          ),
        );
      }
      for (const decision of request.dispositions) {
        await this.putDispositionWithinTransaction(decision, client);
      }
      return events;
    });
  }

  async appendRevision(input: EventRevision): Promise<EventRecord> {
    return this.insert({ ...input, operation: "revise" });
  }

  async markTombstone(input: TombstoneEvent): Promise<EventRecord> {
    return this.withTx(async (client) => {
      const current = await this.findCurrent(input, client);
      return this.insertWithinTransaction(
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

  async createInstallation(
    input: NewConnectorInstallation,
  ): Promise<ConnectorInstallation> {
    const installation: ConnectorInstallation = {
      ...input,
      config: { ...input.config },
      updated_at: input.created_at,
    };
    await this.execute(
      `
        INSERT INTO connector_installations (
          id, org_id, connector_type, status, config_json, credentials_ref,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [
        installation.id,
        installation.org_id,
        installation.connector_type,
        installation.status,
        jsonb(installation.config),
        installation.credentials_ref ?? null,
        installation.created_at,
        installation.updated_at,
      ],
    );
    return installation;
  }

  async findInstallation(id: string): Promise<ConnectorInstallation | null> {
    const row = await this.queryOne<InstallationRow>(
      `
        SELECT id, org_id, connector_type, status, config_json, credentials_ref,
               created_at, updated_at
        FROM connector_installations WHERE id = $1
      `,
      [id],
    );
    return row ? this.toInstallation(row) : null;
  }

  async listInstallations(orgId: string): Promise<ConnectorInstallation[]> {
    const rows = await this.query<InstallationRow>(
      `
        SELECT id, org_id, connector_type, status, config_json, credentials_ref,
               created_at, updated_at
        FROM connector_installations WHERE org_id = $1 ORDER BY created_at DESC
      `,
      [orgId],
    );
    return rows.map((row) => this.toInstallation(row));
  }

  async setInstallationStatus(
    input: SetConnectorInstallationStatus,
  ): Promise<ConnectorInstallation | null> {
    const rowCount = await this.execute(
      `
        UPDATE connector_installations SET status = $1, updated_at = $2
        WHERE id = $3 AND org_id = $4
      `,
      [input.status, input.updated_at, input.id, input.org_id],
    );
    return rowCount === 1 ? this.findInstallation(input.id) : null;
  }

  async updateInstallationConfig(
    input: SetConnectorInstallationConfig,
  ): Promise<ConnectorInstallation | null> {
    const rowCount = await this.execute(
      `
        UPDATE connector_installations SET config_json = $1, updated_at = $2
        WHERE id = $3 AND org_id = $4
      `,
      [jsonb(input.config), input.updated_at, input.id, input.org_id],
    );
    return rowCount === 1 ? this.findInstallation(input.id) : null;
  }

  async deleteInstallation(id: string, orgId: string): Promise<boolean> {
    return this.withTx(async (client) => {
      const row = await this.queryOne<{ id: string }>(
        `SELECT id FROM connector_installations WHERE id = $1 AND org_id = $2`,
        [id, orgId],
        client,
      );
      if (!row) {
        return false;
      }
      await this.execute(
        `
          DELETE FROM ingest_quarantines
          WHERE attempt_id IN (
            SELECT id FROM ingest_attempts WHERE connector_installation_id = $1
          )
        `,
        [id],
        client,
      );
      await this.execute(
        `DELETE FROM ingest_attempts WHERE connector_installation_id = $1`,
        [id],
        client,
      );
      await this.execute(
        `DELETE FROM connector_cursors WHERE installation_id = $1`,
        [id],
        client,
      );
      await this.execute(
        `DELETE FROM connector_stream_members WHERE installation_id = $1`,
        [id],
        client,
      );
      await this.execute(
        `DELETE FROM connector_catalog_cursors WHERE installation_id = $1`,
        [id],
        client,
      );
      await this.execute(
        `DELETE FROM connector_sync_state WHERE installation_id = $1`,
        [id],
        client,
      );
      await this.execute(
        `DELETE FROM connector_installations WHERE id = $1 AND org_id = $2`,
        [id, orgId],
        client,
      );
      return true;
    });
  }

  async acquireLease(input: {
    installation_id: string;
    stream_key: string;
    lease_owner: string;
    now: string;
    lease_duration_ms: number;
  }): Promise<ConnectorLease | null> {
    return this.withTx(async (client) => {
      const installation = await this.queryOne<{
        status: ConnectorInstallation["status"];
      }>(
        `SELECT status FROM connector_installations WHERE id = $1`,
        [input.installation_id],
        client,
      );
      if (!installation || installation.status !== "enabled") {
        return null;
      }
      const leaseExpiresAt = new Date(
        new Date(input.now).getTime() + input.lease_duration_ms,
      ).toISOString();
      const updated = await this.queryOne<CursorRow>(
        `
          UPDATE connector_cursors
          SET lease_owner = $1, lease_expires_at = $2, updated_at = $3
          WHERE installation_id = $4 AND stream_key = $5
            AND (
              lease_owner IS NULL
              OR lease_owner = $1
              OR lease_expires_at IS NULL
              OR lease_expires_at <= $3::timestamptz
            )
          RETURNING ${CURSOR_COLUMNS}
        `,
        [
          input.lease_owner,
          leaseExpiresAt,
          input.now,
          input.installation_id,
          input.stream_key,
        ],
        client,
      );
      if (updated) {
        return this.toLease(updated);
      }
      const inserted = await this.queryOne<CursorRow>(
        `
          INSERT INTO connector_cursors (
            installation_id, stream_key, cursor_value, cursor_version,
            lease_owner, lease_expires_at, updated_at
          ) VALUES ($1, $2, NULL, 1, $3, $4, $5)
          ON CONFLICT (installation_id, stream_key) DO UPDATE SET
            lease_owner = EXCLUDED.lease_owner,
            lease_expires_at = EXCLUDED.lease_expires_at,
            updated_at = EXCLUDED.updated_at
          WHERE connector_cursors.lease_owner IS NULL
             OR connector_cursors.lease_owner = EXCLUDED.lease_owner
             OR connector_cursors.lease_expires_at IS NULL
             OR connector_cursors.lease_expires_at <= $5::timestamptz
          RETURNING ${CURSOR_COLUMNS}
        `,
        [
          input.installation_id,
          input.stream_key,
          input.lease_owner,
          leaseExpiresAt,
          input.now,
        ],
        client,
      );
      return inserted ? this.toLease(inserted) : null;
    });
  }

  async releaseLease(input: ReleaseConnectorLease): Promise<boolean> {
    const rowCount = await this.execute(
      `
        UPDATE connector_cursors
        SET lease_owner = NULL, lease_expires_at = NULL, updated_at = $1
        WHERE installation_id = $2 AND stream_key = $3 AND lease_owner = $4
      `,
      [
        input.now,
        input.installation_id,
        input.stream_key,
        input.lease_owner,
      ],
    );
    return rowCount === 1;
  }

  async resetCursor(
    input: ResetConnectorCursor,
  ): Promise<ConnectorStreamCursor | null> {
    return this.withTx(async (client) => {
      const cursor = await this.findCursorRow(
        input.installation_id,
        input.stream_key,
        client,
      );
      if (!cursor) {
        return null;
      }
      const leaseExpiresAt = toIsoOrNull(cursor.lease_expires_at);
      if (leaseExpiresAt && leaseExpiresAt > input.now) {
        throw new Error("Connector cursor is leased and cannot be reset");
      }
      await this.execute(
        `
          UPDATE connector_cursors
          SET cursor_value = NULL, cursor_version = $1, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = $2
          WHERE installation_id = $3 AND stream_key = $4
        `,
        [
          asNumber(cursor.cursor_version) + 1,
          input.now,
          input.installation_id,
          input.stream_key,
        ],
        client,
      );
      const next = await this.findCursorRow(
        input.installation_id,
        input.stream_key,
        client,
      );
      return next ? this.toCursor(next) : null;
    });
  }

  async beginAttempt(input: NewIngestAttempt): Promise<IngestAttempt> {
    await this.execute(
      `
        INSERT INTO ingest_attempts (
          id, org_id, connector_installation_id, stream_key, delivery_id,
          started_at, status
        ) VALUES ($1, $2, $3, $4, $5, $6, 'running')
      `,
      [
        input.id,
        input.org_id,
        input.connector_installation_id,
        input.stream_key,
        input.delivery_id,
        input.started_at,
      ],
    );
    return (await this.findAttempt(input.id))!;
  }

  async settleAttempt(input: SettleIngestAttempt): Promise<IngestAttempt> {
    return this.withTx(async (client) => {
      const cursor = await this.findCursorRow(
        input.installation_id,
        input.stream_key,
        client,
      );
      if (!cursor || cursor.lease_owner !== input.lease_owner) {
        throw new Error("Connector lease is not held by the attempt owner");
      }
      const status =
        input.retryable_failure_count === 0 ? "succeeded" : "failed";
      await this.execute(
        `
          UPDATE ingest_attempts
          SET finished_at = $1, status = $2, accepted_count = $3, duplicate_count = $4,
              quarantined_count = $5, retryable_failure_count = $6, error_code = $7
          WHERE id = $8
        `,
        [
          input.finished_at,
          status,
          input.accepted_count,
          input.duplicate_count,
          input.quarantined_count,
          input.retryable_failure_count,
          input.error_code ?? null,
          input.attempt_id,
        ],
        client,
      );
      for (const quarantine of input.quarantines) {
        await this.execute(
          `
            INSERT INTO ingest_quarantines (
              id, attempt_id, record_external_id, reason_code,
              safe_metadata_json, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            quarantine.id,
            input.attempt_id,
            quarantine.record_external_id,
            quarantine.reason_code,
            jsonb(quarantine.safe_metadata),
            quarantine.created_at,
          ],
          client,
        );
      }
      const advancesCursor =
        input.retryable_failure_count === 0 && input.next_cursor !== undefined;
      await this.execute(
        `
          UPDATE connector_cursors
          SET cursor_value = $1, cursor_version = $2, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = $3
          WHERE installation_id = $4 AND stream_key = $5
        `,
        [
          advancesCursor ? input.next_cursor : cursor.cursor_value,
          advancesCursor
            ? asNumber(cursor.cursor_version) + 1
            : asNumber(cursor.cursor_version),
          input.finished_at,
          input.installation_id,
          input.stream_key,
        ],
        client,
      );
      return (await this.findAttempt(input.attempt_id, client))!;
    });
  }

  async listAttempts(
    installationId: string,
    limit?: number,
  ): Promise<IngestAttempt[]> {
    const cap =
      typeof limit === "number" && Number.isInteger(limit) && limit > 0
        ? limit
        : undefined;
    const rows = cap
      ? await this.query<AttemptRow>(
          `
            SELECT id, org_id, connector_installation_id, stream_key, delivery_id,
                   started_at, finished_at, status, accepted_count, duplicate_count,
                   quarantined_count, retryable_failure_count, error_code
            FROM ingest_attempts
            WHERE connector_installation_id = $1
            ORDER BY started_at DESC, id DESC
            LIMIT $2
          `,
          [installationId, cap],
        )
      : await this.query<AttemptRow>(
          `
            SELECT id, org_id, connector_installation_id, stream_key, delivery_id,
                   started_at, finished_at, status, accepted_count, duplicate_count,
                   quarantined_count, retryable_failure_count, error_code
            FROM ingest_attempts
            WHERE connector_installation_id = $1
            ORDER BY started_at DESC, id DESC
          `,
          [installationId],
        );
    return rows.map((row) => this.toAttempt(row));
  }

  async latestAttempt(installationId: string): Promise<IngestAttempt | null> {
    const row = await this.queryOne<AttemptRow>(
      `
        SELECT id, org_id, connector_installation_id, stream_key, delivery_id,
               started_at, finished_at, status, accepted_count, duplicate_count,
               quarantined_count, retryable_failure_count, error_code
        FROM ingest_attempts
        WHERE connector_installation_id = $1
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      `,
      [installationId],
    );
    return row ? this.toAttempt(row) : null;
  }

  async pruneIngestAttempts(
    keepPerInstallation = 64,
    batchSize = 5_000,
    installationLimit = Number.POSITIVE_INFINITY,
  ): Promise<{ deleted: number }> {
    const keep =
      Number.isInteger(keepPerInstallation) && keepPerInstallation > 0
        ? keepPerInstallation
        : 64;
    const batch =
      Number.isInteger(batchSize) && batchSize > 0 ? batchSize : 5_000;
    const limit =
      Number.isInteger(installationLimit) && installationLimit > 0
        ? installationLimit
        : Number.POSITIVE_INFINITY;
    const installations = Number.isFinite(limit)
      ? await this.query<{ id: string }>(
          `
            SELECT connector_installation_id AS id
            FROM ingest_attempts
            GROUP BY connector_installation_id
            HAVING COUNT(*) > $1
            ORDER BY COUNT(*) DESC, connector_installation_id ASC
            LIMIT $2
          `,
          [keep, limit],
        )
      : await this.query<{ id: string }>(
          `
            SELECT connector_installation_id AS id
            FROM ingest_attempts
            GROUP BY connector_installation_id
            HAVING COUNT(*) > $1
            ORDER BY COUNT(*) DESC, connector_installation_id ASC
          `,
          [keep],
        );
    let deleted = 0;
    for (const installation of installations) {
      deleted += await this.withTx(async (client) => {
        await this.execute(
          `
            DELETE FROM ingest_quarantines
            WHERE attempt_id IN (
              SELECT doomed.id FROM (
                SELECT id FROM ingest_attempts
                WHERE connector_installation_id = $1
                  AND id NOT IN (
                    SELECT keepers.id FROM (
                      SELECT id FROM ingest_attempts
                      WHERE connector_installation_id = $2
                      ORDER BY started_at DESC, id DESC
                      LIMIT $3
                    ) keepers
                  )
                ORDER BY started_at ASC, id ASC
                LIMIT $4
              ) doomed
            )
          `,
          [installation.id, installation.id, keep, batch],
          client,
        );
        return this.execute(
          `
            DELETE FROM ingest_attempts
            WHERE id IN (
              SELECT doomed.id FROM (
                SELECT id FROM ingest_attempts
                WHERE connector_installation_id = $1
                  AND id NOT IN (
                    SELECT keepers.id FROM (
                      SELECT id FROM ingest_attempts
                      WHERE connector_installation_id = $2
                      ORDER BY started_at DESC, id DESC
                      LIMIT $3
                    ) keepers
                  )
                ORDER BY started_at ASC, id ASC
                LIMIT $4
              ) doomed
            )
          `,
          [installation.id, installation.id, keep, batch],
          client,
        );
      });
    }
    return { deleted };
  }

  async listQuarantines(installationId: string): Promise<IngestQuarantine[]> {
    const rows = await this.query<QuarantineRow>(
      `
        SELECT q.id, q.attempt_id, a.connector_installation_id, a.stream_key,
               q.record_external_id, q.reason_code, q.safe_metadata_json, q.created_at
        FROM ingest_quarantines q
        JOIN ingest_attempts a ON a.id = q.attempt_id
        WHERE a.connector_installation_id = $1 ORDER BY q.created_at DESC
      `,
      [installationId],
    );
    return rows.map((row) => this.toQuarantine(row));
  }

  async getCursor(
    installationId: string,
    streamKey: string,
  ): Promise<ConnectorStreamCursor | null> {
    const row = await this.findCursorRow(installationId, streamKey);
    return row ? this.toCursor(row) : null;
  }

  async getSyncCatalog(installationId: string): Promise<SyncCatalogView> {
    return this.loadSyncCatalog(installationId);
  }

  async applySyncCatalogPage(
    input: ApplySyncCatalogPageInput,
  ): Promise<SyncCatalogView> {
    return this.withTx(async (client) => {
      const current = await this.loadSyncCatalog(input.installation_id, client);
      const next = applySyncCatalogMembers(current, input);
      await this.execute(
        `DELETE FROM connector_stream_members WHERE installation_id = $1`,
        [input.installation_id],
        client,
      );
      for (const member of next.members) {
        await this.execute(
          `
            INSERT INTO connector_stream_members (
              installation_id, stream_key, thread_id, label, kind,
              generation, discovered_at, last_seen_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            member.installation_id,
            member.stream_key,
            member.thread_id ?? null,
            member.label ?? null,
            member.kind ?? null,
            member.generation,
            member.discovered_at,
            member.last_seen_at,
          ],
          client,
        );
      }
      if (next.catalog) {
        await this.execute(
          `
            INSERT INTO connector_catalog_cursors (
              installation_id, cursor_value, complete, generation, updated_at
            ) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (installation_id) DO UPDATE SET
              cursor_value = EXCLUDED.cursor_value,
              complete = EXCLUDED.complete,
              generation = EXCLUDED.generation,
              updated_at = EXCLUDED.updated_at
          `,
          [
            next.catalog.installation_id,
            next.catalog.cursor ?? null,
            next.catalog.complete,
            next.catalog.generation,
            next.catalog.updated_at,
          ],
          client,
        );
      }
      return next;
    });
  }

  async listSyncStates(installationId: string): Promise<SyncStreamState[]> {
    const rows = await this.query<SyncStateRow>(
      `
        SELECT installation_id, stream_key, phase, live_cursor, history_cursor,
               media_pending, idle_until, generation, updated_at
        FROM connector_sync_state
        WHERE installation_id = $1
        ORDER BY updated_at DESC, stream_key ASC
      `,
      [installationId],
    );
    return rows.map((row) => this.toSyncState(row));
  }

  async getSyncState(
    installationId: string,
    streamKey: string,
  ): Promise<SyncStreamState | null> {
    const row = await this.queryOne<SyncStateRow>(
      `
        SELECT installation_id, stream_key, phase, live_cursor, history_cursor,
               media_pending, idle_until, generation, updated_at
        FROM connector_sync_state
        WHERE installation_id = $1 AND stream_key = $2
      `,
      [installationId, streamKey],
    );
    return row ? this.toSyncState(row) : null;
  }

  async putSyncState(state: SyncStreamState): Promise<SyncStreamState> {
    await this.execute(
      `
        INSERT INTO connector_sync_state (
          installation_id, stream_key, phase, live_cursor, history_cursor,
          media_pending, idle_until, generation, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (installation_id, stream_key) DO UPDATE SET
          phase = EXCLUDED.phase,
          live_cursor = EXCLUDED.live_cursor,
          history_cursor = EXCLUDED.history_cursor,
          media_pending = EXCLUDED.media_pending,
          idle_until = EXCLUDED.idle_until,
          generation = EXCLUDED.generation,
          updated_at = EXCLUDED.updated_at
      `,
      [
        state.installation_id,
        state.stream_key,
        state.phase,
        state.live_cursor ?? null,
        state.history_cursor ?? null,
        state.media_pending,
        state.idle_until ?? null,
        state.generation,
        state.updated_at,
      ],
    );
    return { ...state };
  }

  private async transitionableArtifact(
    orgId: string,
    artifactId: string,
    client: PoolClient,
  ): Promise<ContextArtifactState> {
    const row = await this.queryOne<ArtifactStateRow>(
      `SELECT org_id, artifact_id, status, decided_at, superseded_by FROM context_artifact_states WHERE org_id = $1 AND artifact_id = $2 FOR UPDATE`,
      [orgId, artifactId],
      client,
    );
    const state = row ? artifactState(row) : null;
    if (!state || !["proposed", "needs_clarify"].includes(state.status)) {
      throw new Error("Context artifact is not transitionable");
    }
    return state;
  }

  private async withTx<T>(
    fn: (client: PoolClient) => Promise<T>,
    isolation?: "REPEATABLE READ",
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(
        isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : "BEGIN",
      );
      try {
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Keep the original error if rollback fails.
        }
        throw error;
      }
    } finally {
      client.release();
    }
  }

  private async query<T>(
    sql: string,
    params: unknown[] = [],
    client?: PoolClient,
  ): Promise<T[]> {
    const target = client ?? this.pool;
    const result = await target.query(sql, params);
    return result.rows as T[];
  }

  private async queryOne<T>(
    sql: string,
    params: unknown[] = [],
    client?: PoolClient,
  ): Promise<T | null> {
    const rows = await this.query<T>(sql, params, client);
    return rows[0] ?? null;
  }

  private async execute(
    sql: string,
    params: unknown[] = [],
    client?: PoolClient,
  ): Promise<number> {
    const target = client ?? this.pool;
    const result = await target.query(sql, params);
    return result.rowCount ?? 0;
  }

  private async getContextJson<T>(
    table: string,
    where: string,
    params: unknown[],
  ): Promise<T | null> {
    const row = await this.queryOne<{ payload_json: unknown }>(
      `SELECT payload_json FROM ${table} WHERE ${where}`,
      params,
    );
    return row ? parseContextJson<T>(row.payload_json) : null;
  }

  private async putImmutableContextJson(
    table: string,
    where: string,
    lookupParams: unknown[],
    payload: string,
    label: string,
    insertSql: string,
    insertParams: unknown[],
  ): Promise<void> {
    await this.withTx(async (client) => {
      const current = await this.queryOne<{ payload_json: unknown }>(
        `SELECT payload_json FROM ${table} WHERE ${where}`,
        lookupParams,
        client,
      );
      if (current) {
        if (canonicalContextJson(parseContextJson(current.payload_json)) !== payload) {
          throw new Error(`Cannot replace immutable context ${label}`);
        }
        return;
      }
      await this.execute(insertSql, insertParams, client);
    });
  }

  private async findCurrent(
    identity: SourceIdentity,
    client?: PoolClient,
  ): Promise<EventRecord | null> {
    const row = await this.queryOne<EventRow>(
      `
        SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
               e.content_hash, e.parent_event_id, e.thread_id, e.actor_id,
               e.required_scope_ids, e.occurred_at, e.ingested_at
        FROM source_heads h
        JOIN events e ON e.id = h.current_event_id
        WHERE h.org_id = $1 AND h.source = $2 AND h.external_id = $3
      `,
      [identity.org_id, identity.source, identity.external_id],
      client,
    );
    return row ? this.toEvent(row) : null;
  }

  private async loadSyncCatalog(
    installationId: string,
    client?: PoolClient,
  ): Promise<SyncCatalogView> {
    const memberRows = await this.query<StreamMemberRow>(
      `
        SELECT installation_id, stream_key, thread_id, label, kind,
               generation, discovered_at, last_seen_at
        FROM connector_stream_members
        WHERE installation_id = $1
        ORDER BY last_seen_at DESC, stream_key ASC
      `,
      [installationId],
      client,
    );
    const members = memberRows.map((row) => this.toStreamMember(row));
    const snapshot = await this.queryOne<CatalogCursorRow>(
      `
        SELECT installation_id, cursor_value, complete, generation, updated_at
        FROM connector_catalog_cursors
        WHERE installation_id = $1
      `,
      [installationId],
      client,
    );
    return {
      members,
      catalog: snapshot ? this.toCatalogSnapshot(snapshot) : null,
    };
  }

  private toStreamMember(row: StreamMemberRow): SyncCatalogMember {
    return {
      installation_id: row.installation_id,
      stream_key: row.stream_key,
      ...(row.thread_id ? { thread_id: row.thread_id } : {}),
      ...(row.label ? { label: row.label } : {}),
      ...(row.kind ? { kind: row.kind } : {}),
      generation: asNumber(row.generation),
      discovered_at: toIso(row.discovered_at),
      last_seen_at: toIso(row.last_seen_at),
    };
  }

  private toCatalogSnapshot(row: CatalogCursorRow): SyncCatalogSnapshot {
    return {
      installation_id: row.installation_id,
      ...(row.cursor_value ? { cursor: row.cursor_value } : {}),
      complete: asBool(row.complete),
      generation: asNumber(row.generation),
      updated_at: toIso(row.updated_at),
    };
  }

  private toSyncState(row: SyncStateRow): SyncStreamState {
    return {
      installation_id: row.installation_id,
      stream_key: row.stream_key,
      phase: row.phase,
      ...(row.live_cursor ? { live_cursor: row.live_cursor } : {}),
      ...(row.history_cursor ? { history_cursor: row.history_cursor } : {}),
      media_pending: asBool(row.media_pending),
      ...(row.idle_until ? { idle_until: toIso(row.idle_until) } : {}),
      generation: asNumber(row.generation),
      updated_at: toIso(row.updated_at),
    };
  }

  private async findCursorRow(
    installationId: string,
    streamKey: string,
    client?: PoolClient,
  ): Promise<CursorRow | null> {
    return this.queryOne<CursorRow>(
      `
        SELECT ${CURSOR_COLUMNS}
        FROM connector_cursors
        WHERE installation_id = $1 AND stream_key = $2
      `,
      [installationId, streamKey],
      client,
    );
  }

  private async findAttempt(
    id: string,
    client?: PoolClient,
  ): Promise<IngestAttempt | null> {
    const row = await this.queryOne<AttemptRow>(
      `
        SELECT id, org_id, connector_installation_id, stream_key, delivery_id,
               started_at, finished_at, status, accepted_count, duplicate_count,
               quarantined_count, retryable_failure_count, error_code
        FROM ingest_attempts WHERE id = $1
      `,
      [id],
      client,
    );
    return row ? this.toAttempt(row) : null;
  }

  private async insert(input: InsertEventInput): Promise<EventRecord> {
    return this.withTx((client) => this.insertWithinTransaction(input, client));
  }

  private async insertWithinTransaction(
    input: InsertEventInput,
    client: PoolClient,
  ): Promise<EventRecord> {
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
      occurred_at: input.occurred_at,
      ingested_at: new Date().toISOString(),
    };

    if (input.content_hash) {
      await this.insertBlobRow(
        input.content_hash,
        input.content_media_type,
        input.content_byte_size,
        event.ingested_at,
        client,
      );
    }
    for (const blob of input.extra_blobs ?? []) {
      await this.insertBlobRow(
        blob.content_hash,
        blob.media_type,
        blob.byte_size,
        event.ingested_at,
        client,
      );
    }

    await this.execute(
      `
        INSERT INTO events (
          id, org_id, source, external_id, operation, content_hash,
          parent_event_id, revision_id, occurred_at, ingested_at, thread_id,
          actor_id, required_scope_ids
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
      ],
      client,
    );
    const headUpdate =
      input.expected_head_id === null
        ? await this.execute(
            `
              INSERT INTO source_heads (
                org_id, source, external_id, current_event_id
              ) VALUES ($1, $2, $3, $4)
              ON CONFLICT (org_id, source, external_id) DO NOTHING
            `,
            [event.org_id, event.source, event.external_id, event.id],
            client,
          )
        : await this.execute(
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
    await this.execute(
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
    await this.refreshThreadHeadWithinTransaction(
      event.org_id,
      event.thread_id,
      client,
    );
    return event;
  }

  private async refreshThreadHeadWithinTransaction(
    orgId: string,
    threadId: string | null | undefined,
    client?: PoolClient,
  ): Promise<void> {
    const id = threadId?.trim();
    if (!id) {
      return;
    }
    const face = await this.queryOne<{
      face_event_id: string;
      face_occurred_at: unknown;
    }>(
      `
        SELECT e.id AS face_event_id, e.occurred_at AS face_occurred_at
        FROM message_dispositions d
        JOIN events e ON e.id = d.event_id
        WHERE e.org_id = $1
          AND e.thread_id = $2
          AND e.operation != 'tombstone'
          AND NOT (d.reason_codes ? 'thread_status')
        ORDER BY
          CASE WHEN ${isCurrentHeadSql("e")} THEN 0 ELSE 1 END,
          e.occurred_at DESC,
          e.id DESC
        LIMIT 1
      `,
      [orgId, id],
      client,
    );
    if (!face) {
      await this.execute(
        `DELETE FROM thread_heads WHERE org_id = $1 AND thread_id = $2`,
        [orgId, id],
        client,
      );
      return;
    }
    const currentWork = await this.queryOne<{ ok: number }>(
      `
        SELECT 1 AS ok
        FROM message_dispositions d2
        JOIN events e2 ON e2.id = d2.event_id
        WHERE e2.org_id = $1
          AND e2.thread_id = $2
          AND d2.disposition = 'current_work'
          AND ${isCurrentHeadSql("e2", "h2")}
        LIMIT 1
      `,
      [orgId, id],
      client,
    );
    await this.execute(
      `
        INSERT INTO thread_heads (
          org_id, thread_id, face_event_id, face_occurred_at, has_current_work
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (org_id, thread_id) DO UPDATE SET
          face_event_id = EXCLUDED.face_event_id,
          face_occurred_at = EXCLUDED.face_occurred_at,
          has_current_work = EXCLUDED.has_current_work
      `,
      [
        orgId,
        id,
        face.face_event_id,
        face.face_occurred_at,
        Boolean(currentWork),
      ],
      client,
    );
  }

  private inboxSql(
    orgId: string,
    query?: InboxQuery,
  ): { sql: string; params: unknown[] } {
    const params: unknown[] = [];
    const p = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const hiddenList = normalizeInboxListView(query?.list) === "hidden";
    const scoped = inboxScoped(query);
    if (query?.heads) {
      const inner = headsScanQuery(query);
      if (hiddenList) {
        return this.hiddenHeadsSql(orgId, query, inner, p, params);
      }
      const visible = this.inboxClauses(orgId, inner, "any", {}, p);
      if (!scoped) {
        visible.push(notHiddenSql(p(orgId), "e"));
      }
      const page = materialHeadsPageTail(query, p);
      return {
        sql: `
          SELECT ${INBOX_COLUMNS}
          FROM thread_heads th
          JOIN events e ON e.id = th.face_event_id
          JOIN message_dispositions d ON d.event_id = e.id
          WHERE th.has_current_work = TRUE
            AND ${visible.join(" AND ")}
          ${page.whereSql}
          ${page.orderSql}
        `,
        params,
      };
    }
    if (query?.siblings) {
      const clauses = this.inboxClauses(orgId, query, "any", {}, p);
      if (!scoped) {
        if (hiddenList) {
          clauses.push(`e.thread_id IN (${hiddenThreadIdSql(p(orgId))})`);
        } else {
          clauses.push(`e.thread_id IN (
          SELECT e2.thread_id
          FROM message_dispositions d2
          JOIN events e2 ON e2.id = d2.event_id
          WHERE d2.org_id = ${p(orgId)} AND d2.disposition = 'current_work'
            AND ${isCurrentHeadSql("e2", "h2")}
        )`);
          clauses.push(notHiddenSql(p(orgId), "e"));
        }
      }
      const tail = inboxTail(query, p);
      return {
        sql: `
          SELECT ${INBOX_COLUMNS}
          FROM message_dispositions d
          JOIN events e ON e.id = d.event_id
          WHERE ${clauses.join(" AND ")}
            AND ${isCurrentHeadSql("e")}
          ${tail.orderSql}
        `,
        params,
      };
    }
    if (hiddenList) {
      const clauses = this.inboxClauses(orgId, query, "any", {}, p);
      if (!scoped) {
        clauses.push(`e.thread_id IN (${hiddenThreadIdSql(p(orgId))})`);
      }
      const tail = inboxTail(query, p);
      return {
        sql: `
          SELECT ${INBOX_COLUMNS}
          FROM message_dispositions d
          JOIN events e ON e.id = d.event_id
          WHERE ${clauses.join(" AND ")}
            AND ${isCurrentHeadSql("e")}
          ${tail.orderSql}
        `,
        params,
      };
    }
    const clauses = this.inboxClauses(orgId, query, "current_work", {}, p);
    if (!scoped) {
      clauses.push(notHiddenSql(p(orgId), "e"));
    }
    const tail = inboxTail(query, p);
    return {
      sql: `
        SELECT ${INBOX_COLUMNS}
        FROM message_dispositions d
        JOIN events e ON e.id = d.event_id
        WHERE ${clauses.join(" AND ")}
          AND ${isCurrentHeadSql("e")}
        ${tail.orderSql}
      `,
      params,
    };
  }

  private hiddenHeadsSql(
    orgId: string,
    query: InboxQuery | undefined,
    inner: InboxQuery | undefined,
    p: (value: unknown) => string,
    params: unknown[],
  ): { sql: string; params: unknown[] } {
    const visible = this.inboxClauses(orgId, inner, "any", {}, p);
    const hidden = hiddenThreadIdSql(p(orgId));
    const page = materialHeadsPageTail(query, p);
    return {
      sql: `
        SELECT ${INBOX_COLUMNS}
        FROM thread_heads th
        JOIN events e ON e.id = th.face_event_id
        JOIN message_dispositions d ON d.event_id = e.id
        WHERE ${visible.join(" AND ")}
          AND e.thread_id IN (${hidden})
        ${page.whereSql}
        ${page.orderSql}
      `,
      params,
    };
  }

  private inboxClauses(
    orgId: string,
    query: InboxQuery | undefined,
    disposition: "current_work" | "any",
    tables: { event?: string; disposition?: string },
    p: (value: unknown) => string,
  ): string[] {
    const event = tables.event ?? "e";
    const decision = tables.disposition ?? "d";
    const clauses = [`${event}.org_id = ${p(orgId)}`];
    if (disposition === "current_work") {
      clauses.push(`${decision}.disposition = 'current_work'`);
    }
    if (query?.source) {
      clauses.push(`${event}.source = ${p(query.source)}`);
    }
    if (query?.target) {
      clauses.push(
        `(${event}.external_id = ${p(query.target)} OR ${event}.external_id LIKE ${p(threadExternalIdLike(query.target))} ESCAPE E'\\\\')`,
      );
    }
    if (query?.thread_ids && query.thread_ids.length > 0) {
      clauses.push(
        `${event}.thread_id IN (${query.thread_ids.map((id) => p(id)).join(", ")})`,
      );
    }
    if (query?.since) {
      clauses.push(
        `(${event}.ingested_at > ${p(query.since)} OR (${event}.ingested_at = ${p(query.since)} AND ${event}.id > ${p(query.since_id ?? "")}))`,
      );
    }
    if (query?.before) {
      clauses.push(
        `(${event}.occurred_at < ${p(query.before)} OR (${event}.occurred_at = ${p(query.before)} AND ${event}.id < ${p(query.before_id ?? "")}))`,
      );
    }
    return clauses;
  }

  private toInboxItem(row: InboxRow): InboxItem {
    return {
      decision: this.toDisposition({
        event_id: row.event_id,
        org_id: row.disposition_org_id,
        disposition: row.disposition,
        layer: row.layer,
        reason_codes: row.reason_codes,
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
        thread_id: row.thread_id,
        actor_id: row.actor_id,
        required_scope_ids: row.required_scope_ids,
        occurred_at: row.occurred_at,
        ingested_at: row.ingested_at,
      }),
    };
  }

  private toEvent(row: EventRow): EventRecord {
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
      occurred_at: toIso(row.occurred_at),
      ingested_at: toIso(row.ingested_at),
    };
  }

  private toPref(row: PrefRow): ConversationPref {
    const hidden = asBool(row.hidden);
    return {
      org_id: row.org_id,
      thread_id: row.thread_id,
      title: row.title,
      pinned: asBool(row.pinned),
      hidden,
      hidden_reason: hidden ? normalizeHiddenReason(row.hidden_reason) : null,
      last_read_at: toIsoOrNull(row.last_read_at),
      last_read_external_id: row.last_read_external_id,
      updated_at: toIso(row.updated_at),
    };
  }

  private toDisposition(row: DispositionRow): ArrangementDecision {
    return {
      event_id: row.event_id,
      org_id: row.org_id,
      disposition: row.disposition,
      layer: row.layer,
      reason_codes: asJson<string[]>(row.reason_codes),
      score: asNumber(row.score),
      decided_at: toIso(row.decided_at),
    };
  }

  private toInstallation(row: InstallationRow): ConnectorInstallation {
    return {
      id: row.id,
      org_id: row.org_id,
      connector_type: row.connector_type,
      status: row.status,
      config: asJson<ConnectorInstallation["config"]>(row.config_json),
      credentials_ref: row.credentials_ref ?? undefined,
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
    };
  }

  private toCursor(row: CursorRow): ConnectorStreamCursor {
    return {
      installation_id: row.installation_id,
      stream_key: row.stream_key,
      cursor: row.cursor_value ?? undefined,
      cursor_version: asNumber(row.cursor_version),
      updated_at: toIso(row.updated_at),
    };
  }

  private toLease(row: CursorRow): ConnectorLease {
    return {
      ...this.toCursor(row),
      lease_owner: row.lease_owner!,
      lease_expires_at: toIso(row.lease_expires_at),
    };
  }

  private toAttempt(row: AttemptRow): IngestAttempt {
    return {
      id: row.id,
      org_id: row.org_id,
      connector_installation_id: row.connector_installation_id,
      stream_key: row.stream_key,
      delivery_id: row.delivery_id,
      started_at: toIso(row.started_at),
      finished_at: toIsoOrUndefined(row.finished_at),
      status: row.status,
      accepted_count: asNumber(row.accepted_count),
      duplicate_count: asNumber(row.duplicate_count),
      quarantined_count: asNumber(row.quarantined_count),
      retryable_failure_count: asNumber(row.retryable_failure_count),
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
      safe_metadata: asJson<IngestQuarantine["safe_metadata"]>(
        row.safe_metadata_json,
      ),
      created_at: toIso(row.created_at),
    };
  }
}

function inboxUsesNewestFirst(query?: InboxQuery): boolean {
  return Boolean(normalizeInboxLimit(query?.limit));
}

function toContextProjectionJob(row: ContextProjectionJobRow): ContextProjectionJob {
  return {
    id: row.id,
    org_id: row.org_id,
    event_id: row.event_id,
    status: row.status,
    attempts: asNumber(row.attempts),
    ...(row.lease_owner ? { lease_owner: row.lease_owner } : {}),
    ...(row.lease_expires_at
      ? { lease_expires_at: toIso(row.lease_expires_at) }
      : {}),
    ...(row.next_retry_at ? { next_retry_at: toIso(row.next_retry_at) } : {}),
    ...(row.last_error ? { last_error: row.last_error } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function artifactState(row: ArtifactStateRow): ContextArtifactState {
  return {
    org_id: row.org_id,
    artifact_id: row.artifact_id,
    status: row.status,
    decided_at: row.decided_at,
    ...(row.superseded_by ? { superseded_by: row.superseded_by } : {}),
  };
}

function assertArtifactDecision(input: ContextArtifactDecision): void {
  if (!input?.org_id?.trim() || !input.artifact_id?.trim() || !["accepted", "rejected", "needs_clarify"].includes(input.status) || Number.isNaN(Date.parse(input.decided_at))) throw new Error("Invalid Context artifact decision");
}

function assertArtifactSupersession(input: ContextArtifactSupersession): void {
  if (!input?.org_id?.trim() || !input.artifact_id?.trim() || !input.replacement_id?.trim() || input.artifact_id === input.replacement_id || Number.isNaN(Date.parse(input.decided_at))) throw new Error("Invalid Context artifact supersession");
}

function assertProjectionClaim(input: ClaimContextProjectionJobs): void {
  if (
    !input?.owner?.trim()
    || Number.isNaN(Date.parse(input.now))
    || !Number.isSafeInteger(input.lease_ms)
    || input.lease_ms < 1
    || !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > 100
  ) {
    throw new Error("Invalid Context projection claim");
  }
}

function assertProjectionSettle(id: string, owner: string, at: string): void {
  if (!id?.trim() || !owner?.trim() || Number.isNaN(Date.parse(at))) {
    throw new Error("Invalid Context projection settlement");
  }
}

function headsPageTail(
  query: InboxQuery | undefined,
  p: (value: unknown) => string,
): {
  whereSql: string;
  orderSql: string;
} {
  let whereSql = "WHERE rn = 1";
  if (query?.before) {
    whereSql +=
      ` AND (occurred_at < ${p(query.before)} OR (occurred_at = ${p(query.before)} AND id < ${p(query.before_id ?? "")}))`;
  }
  const limit = normalizeInboxLimit(query?.limit);
  if (limit !== undefined) {
    return {
      whereSql,
      orderSql: `ORDER BY occurred_at DESC, id DESC LIMIT ${p(limit)}`,
    };
  }
  return {
    whereSql,
    orderSql: "ORDER BY occurred_at ASC, id ASC",
  };
}

function materialHeadsPageTail(
  query: InboxQuery | undefined,
  p: (value: unknown) => string,
): {
  whereSql: string;
  orderSql: string;
} {
  let whereSql = "";
  if (query?.before) {
    whereSql =
      `AND (e.occurred_at < ${p(query.before)} OR (e.occurred_at = ${p(query.before)} AND e.id < ${p(query.before_id ?? "")}))`;
  }
  const limit = normalizeInboxLimit(query?.limit);
  if (limit !== undefined) {
    return {
      whereSql,
      orderSql: `ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${p(limit)}`,
    };
  }
  return {
    whereSql,
    orderSql: "ORDER BY e.occurred_at ASC, e.id ASC",
  };
}

function isCurrentHeadSql(event = "e", heads = "h"): string {
  return `EXISTS (
    SELECT 1 FROM source_heads ${heads}
    WHERE ${heads}.current_event_id = ${event}.id
  )`;
}

function hiddenThreadIdSql(orgPlaceholder: string): string {
  return `SELECT thread_id FROM conversation_prefs WHERE org_id = ${orgPlaceholder} AND hidden = TRUE`;
}

function notHiddenSql(orgPlaceholder: string, event = "e"): string {
  return `${event}.thread_id NOT IN (SELECT pref.thread_id FROM conversation_prefs pref WHERE pref.org_id = ${orgPlaceholder} AND pref.hidden = TRUE)`;
}

function inboxScoped(query?: InboxQuery): boolean {
  return Boolean(query?.source || query?.target || query?.thread_ids);
}

function inboxTail(
  query: InboxQuery | undefined,
  p: (value: unknown) => string,
): {
  orderSql: string;
} {
  const limit = query?.heads ? undefined : normalizeInboxLimit(query?.limit);
  if (limit !== undefined) {
    return {
      orderSql: `ORDER BY e.occurred_at DESC, e.id DESC LIMIT ${p(limit)}`,
    };
  }
  return {
    orderSql: "ORDER BY e.occurred_at ASC, e.id ASC",
  };
}

interface ExecutorRow {
  id: string;
  org_id: string;
  kind: ExecutorInstallation["kind"];
  name: string;
  status: ExecutorInstallation["status"];
  config_json: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface RecipeRow {
  id: string;
  org_id: string;
  name: string;
  match_json: unknown;
  executor_type: string;
  executor_config_json: unknown;
  can_write_back: unknown;
  include_context: unknown;
  enabled: unknown;
  trigger_kind: string | null;
  trigger_interval_ms: number | null;
  trigger_coalesce: unknown;
  max_concurrent: number | null;
  next_run_at: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface WorkItemRow {
  id: string;
  org_id: string;
  thread_id: string;
  unit_key: string;
  head_event_id: string | null;
  record_class: WorkItem["record_class"];
  thread_facet: WorkItem["thread_facet"];
  status: WorkItem["status"];
  recipe_id: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface WorkDeliveryRow {
  id: string;
  org_id: string;
  work_item_id: string;
  recipe_id: string;
  kind: string;
  unit_key: string;
  event_id: string | null;
  status: string;
  write_back: string;
  attempts: number;
  last_error: string | null;
  next_retry_at: unknown;
  payload_json: unknown;
  lease_expires_at: unknown;
  idempotency_key: string | null;
  channel_receipt_json: unknown;
  created_at: unknown;
  updated_at: unknown;
}

interface WorkRunRow {
  id: string;
  org_id: string;
  work_item_id: string;
  recipe_id: string;
  executor_type: string;
  external_run_id: string | null;
  agent_thread_id: string | null;
  status: WorkRun["status"];
  result_json: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function toExecutorInstallation(row: ExecutorRow): ExecutorInstallation {
  return {
    id: row.id,
    org_id: row.org_id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    config: asJson<ExecutorInstallation["config"]>(row.config_json),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function toRecipe(row: RecipeRow): Recipe {
  const match = asJson<Recipe["match"]>(row.match_json);
  const kind = isRecipeTriggerKind(row.trigger_kind) ? row.trigger_kind : undefined;
  return {
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    match,
    trigger: recipeTriggerOf({
      match,
      trigger: kind
        ? {
            kind,
            ...(kind === "pull" && isPullIntervalMs(row.trigger_interval_ms)
              ? { interval_ms: row.trigger_interval_ms }
              : {}),
            ...(kind === "push"
              ? { coalesce: row.trigger_coalesce !== false && row.trigger_coalesce !== 0 }
              : {}),
          }
        : undefined,
    }),
    executor_type: row.executor_type,
    executor_config: asJson<Recipe["executor_config"]>(row.executor_config_json),
    can_write_back: asBool(row.can_write_back),
    include_context: asBool(row.include_context),
    enabled: asBool(row.enabled),
    ...(row.max_concurrent && row.max_concurrent > 0
      ? { max_concurrent: row.max_concurrent }
      : {}),
    ...(row.next_run_at ? { next_run_at: toIso(row.next_run_at) } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function toWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: row.id,
    org_id: row.org_id,
    thread_id: row.thread_id,
    unit_key: row.unit_key,
    head_event_id: row.head_event_id ?? undefined,
    record_class: row.record_class,
    thread_facet: row.thread_facet,
    status: row.status,
    recipe_id: row.recipe_id ?? undefined,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function toWorkRun(row: WorkRunRow): WorkRun {
  return {
    id: row.id,
    org_id: row.org_id,
    work_item_id: row.work_item_id,
    recipe_id: row.recipe_id,
    executor_type: row.executor_type,
    external_run_id: row.external_run_id ?? undefined,
    agent_thread_id: row.agent_thread_id ?? undefined,
    status: row.status,
    result: row.result_json
      ? asJson<WorkRun["result"]>(row.result_json)
      : undefined,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function toWorkDelivery(row: WorkDeliveryRow): WorkDelivery {
  const kind = isRecipeTriggerKind(row.kind) ? row.kind : "manual";
  return {
    id: row.id,
    org_id: row.org_id,
    work_item_id: row.work_item_id,
    recipe_id: row.recipe_id,
    kind,
    unit_key: row.unit_key,
    event_id: row.event_id ?? undefined,
    status: isWorkDeliveryStatus(row.status) ? row.status : "queued",
    write_back: isWorkWriteBackState(row.write_back) ? row.write_back : "pending",
    attempts: asNumber(row.attempts),
    last_error: row.last_error ?? undefined,
    next_retry_at: toIsoOrUndefined(row.next_retry_at),
    payload: parseDeliveryPayload(row.payload_json),
    lease_expires_at: toIsoOrUndefined(row.lease_expires_at),
    idempotency_key: row.idempotency_key ?? undefined,
    channel_receipt: parseChannelReceipt(row.channel_receipt_json),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function parseChannelReceipt(
  raw: unknown,
): WorkDelivery["channel_receipt"] | undefined {
  if (raw == null || raw === "") {
    return undefined;
  }
  try {
    const parsed = asJson<WorkDelivery["channel_receipt"]>(raw);
    if (!parsed || typeof parsed.accepted !== "boolean") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function parseDeliveryPayload(
  raw: unknown,
): WorkDelivery["payload"] | undefined {
  if (raw == null || raw === "") {
    return undefined;
  }
  try {
    const parsed = asJson<WorkDelivery["payload"]>(raw);
    if (!parsed || typeof parsed.summary !== "string") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function parseContextJson<T>(value: unknown): T {
  return asJson<T>(value);
}

/** node-pg encodes JS arrays as PG arrays; JSONB columns need JSON text. */
function jsonb(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function asJson<T>(value: unknown): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return value as T;
}

function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === "t" || value === "true";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  return toIso(value);
}

function toIsoOrUndefined(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  return toIso(value);
}

function requireContextValue(
  result: { success: true } | { success: false; issues: Array<{ message: string }> },
  label: string,
): void {
  if (!result.success) {
    throw new Error(
      `Invalid context ${label}: ${result.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
}
