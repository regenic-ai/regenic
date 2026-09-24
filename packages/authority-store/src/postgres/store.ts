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
  validateDailyDigestPolicy,
  validateProposal,
  validateDecision,
  validateReview,
  validateHandoff,
  assertHandoffTransition,
  validateStandard,
  validateStandardVersion,
  transitionStandardVersion as applyStandardVersionTransition,
  validateStandardGap,
  validateStandardGapConversion,
  validateAgentRun,
  startAgentRun as applyAgentRunStart,
  settleAgentRun as applyAgentRunSettlement,
  handoffAgentRun as applyAgentRunHandoff,
  cancelAgentRun as applyAgentRunCancellation,
  agentRunState,
  STANDARD_USAGE_SCHEMA_VERSION,
  validateStandardUsage,
  processSyncMetrics,
  recordSyncDuration,
  syncWorkPriority,
  validateSyncRunOptions,
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
  ContextArtifactProposedSupersession,
  ContextAuthorityRead,
  ContextAuthorityReader,
  ContextBundle,
  ContextBundleLookup,
  ContextProjectionCheckpoint,
  ContextProjectionJob,
  ContextProjectionOutboxStore,
  DailyDigestJob,
  DailyDigestJobStore,
  DailyDigestPolicy,
  DailyDigestPolicyStore,
  DailyDigestCoverageAlert,
  ProposalRecord,
  ProposalStatus,
  DecisionRecord,
  ReviewRecord,
  HandoffDirection,
  HandoffRecord,
  HandoffStatus,
  StandardRecord,
  StandardVersionRecord,
  StandardVersionState,
  StandardVersionTransition,
  StandardGapRecord,
  StandardGapStatus,
  AgentRunOutput,
  AgentRunRecord,
  AgentRunState,
  AgentRunStatus,
  StandardUsageRecord,
  StandardUsageSourceKind,
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
  ClaimSyncWork,
  CommandSyncRun,
  CommitSyncPage,
  CommitSyncPageResult,
  EnqueueSyncWork,
  ListSyncRunsQuery,
  NewSyncRun,
  RenewSyncWork,
  SettleSyncWork,
  SyncRun,
  SyncWorkIdentity,
  SyncWorkRecord,
  UnassignedSyncWorkQuery,
  WakeUnassignedSyncWork,
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
  direction_tags: unknown;
  weight_hints: unknown;
  attrs: unknown;
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

interface SyncRunRow {
  id: string;
  org_id: string;
  installation_id: string;
  mode: SyncRun["mode"];
  status: SyncRun["status"];
  options_json: unknown;
  total_work: number;
  completed_work: number;
  failed_work: number;
  accepted_count: number;
  started_at: unknown;
  finished_at: unknown;
  last_error: string | null;
  created_at: unknown;
  updated_at: unknown;
}

interface SyncWorkRow {
  id: string;
  run_id: string | null;
  installation_id: string;
  stream_key: string;
  lane: SyncWorkRecord["lane"];
  priority: number;
  next_due_at: unknown;
  status: SyncWorkRecord["status"];
  attempts: number;
  generation: number;
  lease_owner: string | null;
  lease_expires_at: unknown;
  last_error: string | null;
  created_at: unknown;
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

interface DailyDigestJobRow {
  id: string;
  org_id: string;
  utc_date: string;
  generation: string;
  status: DailyDigestJob["status"];
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
  direction_tags?: string[];
  weight_hints?: NewEvent["weight_hints"];
  attrs?: NewEvent["attrs"];
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
    ContextProjectionOutboxStore,
    DailyDigestJobStore,
    DailyDigestPolicyStore
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
               direction_tags, weight_hints, attrs,
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
                     e.required_scope_ids, e.direction_tags, e.weight_hints, e.attrs,
                     e.occurred_at, e.ingested_at,
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
                     e.required_scope_ids, e.direction_tags, e.weight_hints, e.attrs,
                     e.occurred_at, e.ingested_at,
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

  async supersedeProposedArtifact(input: ContextArtifactProposedSupersession): Promise<{ superseded: ContextArtifactState; replacement: ContextArtifactState }> {
    return this.withTx(async (client) => {
      const current = await this.queryOne<ArtifactStateRow>(`SELECT org_id, artifact_id, status, decided_at, superseded_by FROM context_artifact_states WHERE org_id = $1 AND artifact_id = $2 FOR UPDATE`, [input.org_id, input.artifact_id], client);
      const replacement = await this.transitionableArtifact(input.org_id, input.replacement_id, client);
      const artifacts = await this.query<{ id: string; payload_json: unknown }>(
        `SELECT id, payload_json FROM context_artifacts WHERE org_id = $1 AND id = ANY($2::text[])`,
        [input.org_id, [input.artifact_id, input.replacement_id]],
        client,
      );
      const byId = new Map(artifacts.map((row) => [row.id, parseContextJson<ContextArtifact>(row.payload_json)] as const));
      const currentArtifact = byId.get(input.artifact_id);
      const replacementArtifact = byId.get(input.replacement_id);
      if (!current || current.status !== "proposed" || !currentArtifact || !replacementArtifact || currentArtifact.kind !== "daily_digest" || replacementArtifact.kind !== "daily_digest" || replacementArtifact.supersedes_id !== input.artifact_id) throw new Error("Invalid proposed daily digest supersession");
      await this.execute(`UPDATE context_artifact_states SET status = 'superseded', decided_at = $1, superseded_by = $2 WHERE org_id = $3 AND artifact_id = $4`, [input.decided_at, input.replacement_id, input.org_id, input.artifact_id], client);
      await this.execute(`UPDATE context_artifact_states SET status = 'proposed', decided_at = $1, superseded_by = NULL WHERE org_id = $2 AND artifact_id = $3`, [input.decided_at, input.org_id, input.replacement_id], client);
      return {
        superseded: { ...artifactState(current), status: "superseded", decided_at: input.decided_at, superseded_by: input.replacement_id },
        replacement: { ...replacement, status: "proposed", decided_at: input.decided_at },
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

  async enqueueDailyDigestCatchUp(input: {
    org_id: string;
    through_utc_date: string;
    generation: string;
    created_at: string;
    max_days: number;
  }): Promise<DailyDigestJob[]> {
    assertDailyDigestCatchUp(input);
    return this.withTx(async (client) => {
      await this.query(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`daily-digest:${input.org_id}:${input.generation}`],
        client,
      );
      const cursor = await this.queryOne<{ last_scheduled_utc_date: string }>(
        `SELECT last_scheduled_utc_date FROM daily_digest_schedule_cursors
         WHERE org_id = $1 AND generation = $2`,
        [input.org_id, input.generation],
        client,
      );
      const dates = catchUpDates(cursor?.last_scheduled_utc_date, input.through_utc_date, input.max_days);
      const ids: string[] = [];
      for (const utcDate of dates) {
        const id = `daily-digest-job:${hashCanonicalContext([input.org_id, utcDate, input.generation])}`;
        await this.execute(
          `INSERT INTO daily_digest_jobs (
            id, org_id, utc_date, generation, status, attempts, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, 'pending', 0, $5, $5)
          ON CONFLICT (org_id, utc_date, generation) DO NOTHING`,
          [id, input.org_id, utcDate, input.generation, input.created_at],
          client,
        );
        ids.push(id);
      }
      const lastScheduled = dates.at(-1);
      if (lastScheduled) {
        await this.execute(
          `INSERT INTO daily_digest_schedule_cursors (
            org_id, generation, last_scheduled_utc_date, updated_at
          ) VALUES ($1, $2, $3, $4)
          ON CONFLICT (org_id, generation) DO UPDATE SET
            last_scheduled_utc_date = excluded.last_scheduled_utc_date,
            updated_at = excluded.updated_at`,
          [input.org_id, input.generation, lastScheduled, input.created_at],
          client,
        );
      }
      if (!ids.length) return [];
      const rows = await this.query<DailyDigestJobRow>(
        `SELECT id, org_id, utc_date, generation, status, attempts, lease_owner,
         lease_expires_at, next_retry_at, last_error, created_at, updated_at
         FROM daily_digest_jobs WHERE id = ANY($1::text[])`,
        [ids],
        client,
      );
      const byId = new Map(rows.map((row) => [row.id, toDailyDigestJob(row)] as const));
      return ids.map((id) => byId.get(id)!);
    });
  }

  async enqueueDailyDigestJob(input: {
    org_id: string; utc_date: string; generation: string; created_at: string;
  }): Promise<DailyDigestJob> {
    assertDailyDigestEnqueue(input);
    const id = `daily-digest-job:${hashCanonicalContext([input.org_id, input.utc_date, input.generation])}`;
    await this.execute(
      `INSERT INTO daily_digest_jobs (
        id, org_id, utc_date, generation, status, attempts, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'pending', 0, $5, $5)
      ON CONFLICT (org_id, utc_date, generation) DO NOTHING`,
      [id, input.org_id, input.utc_date, input.generation, input.created_at],
    );
    const row = await this.queryOne<DailyDigestJobRow>(
      `SELECT id, org_id, utc_date, generation, status, attempts, lease_owner,
       lease_expires_at, next_retry_at, last_error, created_at, updated_at
       FROM daily_digest_jobs WHERE id = $1`, [id],
    );
    return toDailyDigestJob(row!);
  }

  async claimDailyDigestJobs(input: {
    owner: string; now: string; lease_ms: number; limit: number;
  }): Promise<DailyDigestJob[]> {
    assertProjectionClaim(input);
    return this.withTx(async (client) => {
      const rows = await this.query<{ id: string }>(
        `SELECT id FROM daily_digest_jobs
         WHERE status = 'pending'
            OR (status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= $1::timestamptz))
            OR (status = 'running' AND lease_expires_at <= $1::timestamptz)
         ORDER BY created_at, id LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [input.now, input.limit], client,
      );
      if (!rows.length) return [];
      const ids = rows.map((row) => row.id);
      const expiresAt = new Date(Date.parse(input.now) + input.lease_ms).toISOString();
      await this.execute(
        `UPDATE daily_digest_jobs SET status = 'running', attempts = attempts + 1,
         lease_owner = $1, lease_expires_at = $2, next_retry_at = NULL,
         last_error = NULL, updated_at = $3 WHERE id = ANY($4::text[])`,
        [input.owner, expiresAt, input.now, ids], client,
      );
      const claimed = await this.query<DailyDigestJobRow>(
        `SELECT id, org_id, utc_date, generation, status, attempts, lease_owner,
         lease_expires_at, next_retry_at, last_error, created_at, updated_at
         FROM daily_digest_jobs WHERE id = ANY($1::text[])`, [ids], client,
      );
      const byId = new Map(claimed.map((row) => [row.id, toDailyDigestJob(row)] as const));
      return ids.map((id) => byId.get(id)!);
    });
  }

  async completeDailyDigestJob(input: { id: string; owner: string; completed_at: string }): Promise<boolean> {
    assertProjectionSettle(input.id, input.owner, input.completed_at);
    return await this.execute(
      `UPDATE daily_digest_jobs SET status = 'succeeded', lease_owner = NULL,
       lease_expires_at = NULL, next_retry_at = NULL, last_error = NULL, updated_at = $1
       WHERE id = $2 AND status = 'running' AND lease_owner = $3 AND lease_expires_at > $1::timestamptz`,
      [input.completed_at, input.id, input.owner],
    ) === 1;
  }

  async renewDailyDigestJob(input: { id: string; owner: string; now: string; lease_ms: number }): Promise<boolean> {
    assertProjectionSettle(input.id, input.owner, input.now);
    if (!Number.isSafeInteger(input.lease_ms) || input.lease_ms < 1) throw new Error("Invalid daily digest lease renewal");
    return await this.execute(
      `UPDATE daily_digest_jobs SET lease_expires_at = $1, updated_at = $2
       WHERE id = $3 AND status = 'running' AND lease_owner = $4 AND lease_expires_at > $2::timestamptz`,
      [new Date(Date.parse(input.now) + input.lease_ms).toISOString(), input.now, input.id, input.owner],
    ) === 1;
  }

  async failDailyDigestJob(input: {
    id: string; owner: string; failed_at: string; next_retry_at: string; error_code: string;
  }): Promise<boolean> {
    assertProjectionSettle(input.id, input.owner, input.failed_at);
    if (Number.isNaN(Date.parse(input.next_retry_at)) || !input.error_code.trim()) throw new Error("Invalid daily digest failure");
    return await this.execute(
      `UPDATE daily_digest_jobs SET status = 'failed', lease_owner = NULL,
       lease_expires_at = NULL, next_retry_at = $1, last_error = $2, updated_at = $3
       WHERE id = $4 AND status = 'running' AND lease_owner = $5 AND lease_expires_at > $3::timestamptz`,
      [input.next_retry_at, input.error_code.slice(0, 120), input.failed_at, input.id, input.owner],
    ) === 1;
  }

  async listDailyDigestJobs(orgId: string): Promise<DailyDigestJob[]> {
    const rows = await this.query<DailyDigestJobRow>(
      `SELECT id, org_id, utc_date, generation, status, attempts, lease_owner,
       lease_expires_at, next_retry_at, last_error, created_at, updated_at
      FROM daily_digest_jobs WHERE org_id = $1 ORDER BY utc_date, generation, id`, [orgId],
    );
    return rows.map(toDailyDigestJob);
  }

  async putDailyDigestCoverageAlert(alert: DailyDigestCoverageAlert): Promise<DailyDigestCoverageAlert> {
    await this.execute(`INSERT INTO daily_digest_coverage_alerts (id, org_id, local_date, generation, event_id, reason_code, status, created_at, resolved_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (org_id, local_date, generation, event_id, reason_code) DO NOTHING`, [alert.id, alert.org_id, alert.local_date, alert.generation, alert.event_id, alert.reason_code, alert.status, alert.created_at, alert.resolved_at ?? null]);
    const row = await this.queryOne<DailyDigestCoverageAlert>(`SELECT id, org_id, local_date, generation, event_id, reason_code, status, created_at, resolved_at FROM daily_digest_coverage_alerts WHERE org_id = $1 AND local_date = $2 AND generation = $3 AND event_id = $4 AND reason_code = $5`, [alert.org_id, alert.local_date, alert.generation, alert.event_id, alert.reason_code]);
    return row!;
  }

  async listDailyDigestCoverageAlerts(input: { org_id: string; status?: "open" | "resolved"; limit?: number }): Promise<DailyDigestCoverageAlert[]> {
    const limit = input.limit ?? 100;
    return this.query<DailyDigestCoverageAlert>(`SELECT id, org_id, local_date, generation, event_id, reason_code, status, created_at, resolved_at FROM daily_digest_coverage_alerts WHERE org_id = $1 ${input.status ? "AND status = $2" : ""} ORDER BY local_date, id LIMIT $${input.status ? 3 : 2}`, input.status ? [input.org_id, input.status, limit] : [input.org_id, limit]);
  }

  async resolveDailyDigestCoverageAlert(input: { org_id: string; alert_id: string; resolved_at: string }): Promise<DailyDigestCoverageAlert | null> {
    await this.execute(`UPDATE daily_digest_coverage_alerts SET status = 'resolved', resolved_at = $1 WHERE org_id = $2 AND id = $3 AND status = 'open'`, [input.resolved_at, input.org_id, input.alert_id]);
    return await this.queryOne<DailyDigestCoverageAlert>(`SELECT id, org_id, local_date, generation, event_id, reason_code, status, created_at, resolved_at FROM daily_digest_coverage_alerts WHERE org_id = $1 AND id = $2`, [input.org_id, input.alert_id]);
  }

  async putProposal(input: ProposalRecord): Promise<ProposalRecord> {
    const proposal = validateProposal(input);
    if (proposal.status !== "draft") throw new Error("New Proposal must be draft");
    await this.execute(`INSERT INTO proposals (id, org_id, status, source_digest_id, source_item_event_id, payload_json, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`, [proposal.id, proposal.org_id, proposal.status, proposal.source_digest_id ?? null, proposal.source_item_event_id ?? null, jsonb(proposal), proposal.created_at, proposal.updated_at]);
    const row = proposal.source_digest_id && proposal.source_item_event_id
      ? await this.queryOne<ProposalRow>(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = $1 AND source_digest_id = $2 AND source_item_event_id = $3`, [proposal.org_id, proposal.source_digest_id, proposal.source_item_event_id])
      : await this.queryOne<ProposalRow>(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = $1 AND id = $2`, [proposal.org_id, proposal.id]);
    return toProposal(row!);
  }

  async getProposal(orgId: string, proposalId: string): Promise<ProposalRecord | null> {
    const row = await this.queryOne<ProposalRow>(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = $1 AND id = $2`, [orgId, proposalId]);
    return row ? toProposal(row) : null;
  }

  async listProposals(input: { org_id: string; status?: ProposalStatus; limit?: number }): Promise<ProposalRecord[]> {
    const limit = input.limit ?? 100;
    const rows = await this.query<ProposalRow>(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = $1 ${input.status ? "AND status = $2" : ""} ORDER BY created_at, id LIMIT $${input.status ? 3 : 2}`, input.status ? [input.org_id, input.status, limit] : [input.org_id, limit]);
    return rows.map(toProposal);
  }

  async transitionProposal(input: { org_id: string; proposal_id: string; status: "submitted" | "in_review" | "rejected" | "withdrawn"; updated_at: string }): Promise<ProposalRecord | null> {
    return this.withTx(async (client) => {
      const row = await this.queryOne<ProposalRow>(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, input.proposal_id], client);
      if (!row) return null;
      const proposal = toProposal(row);
      const allowed = (proposal.status === "draft" && ["submitted", "withdrawn"].includes(input.status))
        || (proposal.status === "submitted" && ["in_review", "withdrawn"].includes(input.status))
        || (proposal.status === "in_review" && ["rejected", "withdrawn"].includes(input.status));
      if (!allowed) throw new Error("Invalid Proposal transition");
      const next = validateProposal({ ...proposal, status: input.status, updated_at: input.updated_at });
      await this.execute(`UPDATE proposals SET status = $1, updated_at = $2 WHERE org_id = $3 AND id = $4 AND status = $5`, [next.status, next.updated_at, input.org_id, input.proposal_id, proposal.status], client);
      return next;
    });
  }

  async commitProposalDecision(input: { org_id: string; proposal_id: string; decision: DecisionRecord }): Promise<{ proposal: ProposalRecord; decision: DecisionRecord }> {
    return this.withTx(async (client) => {
      const decision = validateDecision(input.decision);
      const proposal = await this.getProposalWithinTransaction(input.org_id, input.proposal_id, client, true);
      const existing = await this.queryOne<{ payload_json: unknown }>(`SELECT payload_json FROM decisions WHERE org_id = $1 AND proposal_id = $2`, [input.org_id, input.proposal_id], client);
      if (existing) {
        const stored = validateDecision(parseContextJson<DecisionRecord>(existing.payload_json));
        if (canonicalContextJson(stored) !== canonicalContextJson(decision)) throw new Error("Cannot replace immutable Decision");
        return { proposal: proposal!, decision: stored };
      }
      if (!proposal || proposal.status !== "in_review" || proposal.kind !== "decision"
        || decision.org_id !== input.org_id || decision.proposal_id !== proposal.id
        || decision.context_snapshot_id !== proposal.context_snapshot_id
        || decision.rights_level !== proposal.rights_level
        || canonicalContextJson(decision.standard_bindings) !== canonicalContextJson(proposal.standard_bindings)) {
        throw new Error("Invalid Proposal Decision commit");
      }
      await this.execute(`INSERT INTO decisions (id, org_id, proposal_id, status, payload_json, committed_at) VALUES ($1, $2, $3, $4, $5, $6)`, [decision.id, decision.org_id, decision.proposal_id, decision.status, jsonb(decision), decision.committed_at], client);
      await this.execute(`UPDATE proposals SET status = 'accepted', outcome_kind = 'decision', outcome_ref_id = $1, updated_at = $2 WHERE org_id = $3 AND id = $4 AND status = 'in_review'`, [decision.id, decision.committed_at, input.org_id, input.proposal_id], client);
      return {
        proposal: (await this.getProposalWithinTransaction(input.org_id, input.proposal_id, client))!,
        decision,
      };
    });
  }

  async getDecision(orgId: string, decisionId: string): Promise<DecisionRecord | null> {
    const row = await this.queryOne<{ payload_json: unknown }>(`SELECT payload_json FROM decisions WHERE org_id = $1 AND id = $2`, [orgId, decisionId]);
    return row ? validateDecision(parseContextJson<DecisionRecord>(row.payload_json)) : null;
  }

  async listDecisions(input: { org_id: string; limit?: number }): Promise<DecisionRecord[]> {
    const rows = await this.query<{ payload_json: unknown }>(`SELECT payload_json FROM decisions WHERE org_id = $1 ORDER BY committed_at, id LIMIT $2`, [input.org_id, input.limit ?? 100]);
    return rows.map((row) => validateDecision(parseContextJson<DecisionRecord>(row.payload_json)));
  }

  async putReview(input: ReviewRecord): Promise<ReviewRecord> {
    const review = validateReview(input);
    await this.execute(`INSERT INTO reviews (id, org_id, subject_kind, subject_id, payload_json, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`, [review.id, review.org_id, review.subject_kind, review.subject_id, jsonb(review), review.created_at]);
    const stored = await this.getReview(review.org_id, review.id);
    if (!stored || canonicalContextJson(stored) !== canonicalContextJson(review)) throw new Error("Cannot replace immutable Review");
    return stored;
  }

  async getReview(orgId: string, reviewId: string): Promise<ReviewRecord | null> {
    const row = await this.queryOne<{ payload_json: unknown }>(`SELECT payload_json FROM reviews WHERE org_id = $1 AND id = $2`, [orgId, reviewId]);
    return row ? validateReview(parseContextJson<ReviewRecord>(row.payload_json)) : null;
  }

  async listReviews(input: { org_id: string; subject_id?: string; limit?: number }): Promise<ReviewRecord[]> {
    const rows = await this.query<{ payload_json: unknown }>(`SELECT payload_json FROM reviews WHERE org_id = $1 ${input.subject_id ? "AND subject_id = $2" : ""} ORDER BY created_at, id LIMIT $${input.subject_id ? 3 : 2}`, input.subject_id ? [input.org_id, input.subject_id, input.limit ?? 100] : [input.org_id, input.limit ?? 100]);
    return rows.map((row) => validateReview(parseContextJson<ReviewRecord>(row.payload_json)));
  }

  async putHandoff(input: HandoffRecord): Promise<HandoffRecord> {
    const handoff = validateHandoff(input);
    if (handoff.status !== "open") throw new Error("New Handoff must be open");
    await this.execute(`INSERT INTO handoffs (id, org_id, direction, status, payload_json, created_at, resolved_at) VALUES ($1, $2, $3, $4, $5, $6, NULL) ON CONFLICT (id) DO NOTHING`, [handoff.id, handoff.org_id, handoff.direction, handoff.status, jsonb(handoff), handoff.created_at]);
    const row = await this.queryOne<HandoffRow>(`SELECT status, payload_json, resolved_at FROM handoffs WHERE org_id = $1 AND id = $2`, [handoff.org_id, handoff.id]);
    if (!row) throw new Error("Cannot replace immutable Handoff");
    const storedCreation = validateHandoff(parseContextJson<HandoffRecord>(row.payload_json));
    if (canonicalContextJson(storedCreation) !== canonicalContextJson({
      ...handoff, created_at: storedCreation.created_at,
    })) {
      throw new Error("Cannot replace immutable Handoff");
    }
    return toHandoff(row);
  }

  async getHandoff(orgId: string, handoffId: string): Promise<HandoffRecord | null> {
    const row = await this.queryOne<HandoffRow>(`SELECT status, payload_json, resolved_at FROM handoffs WHERE org_id = $1 AND id = $2`, [orgId, handoffId]);
    return row ? toHandoff(row) : null;
  }

  async listHandoffs(input: { org_id: string; status?: HandoffStatus; direction?: HandoffDirection; limit?: number }): Promise<HandoffRecord[]> {
    const conditions = ["org_id = $1"];
    const values: unknown[] = [input.org_id];
    if (input.status) { values.push(input.status); conditions.push(`status = $${values.length}`); }
    if (input.direction) { values.push(input.direction); conditions.push(`direction = $${values.length}`); }
    values.push(input.limit ?? 100);
    const rows = await this.query<HandoffRow>(`SELECT status, payload_json, resolved_at FROM handoffs WHERE ${conditions.join(" AND ")} ORDER BY created_at, id LIMIT $${values.length}`, values);
    return rows.map(toHandoff);
  }

  async transitionHandoff(input: { org_id: string; handoff_id: string; status: Exclude<HandoffStatus, "open">; transitioned_at: string }): Promise<HandoffRecord | null> {
    if (!input.org_id?.trim() || !input.handoff_id?.trim() || Number.isNaN(Date.parse(input.transitioned_at))) throw new Error("Invalid Handoff transition");
    return this.withTx(async (client) => {
      const row = await this.queryOne<HandoffRow>(`SELECT status, payload_json, resolved_at FROM handoffs WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, input.handoff_id], client);
      if (!row) return null;
      const current = toHandoff(row);
      assertHandoffTransition(current.status, input.status);
      const next = validateHandoff({
        ...current,
        status: input.status,
        ...(input.status === "resolved" ? { resolved_at: input.transitioned_at } : {}),
      });
      await this.execute(`UPDATE handoffs SET status = $1, resolved_at = $2 WHERE org_id = $3 AND id = $4 AND status = $5`, [next.status, next.resolved_at ?? null, input.org_id, input.handoff_id, current.status], client);
      return next;
    });
  }

  async commitProposalStandardVersion(input: { org_id: string; proposal_id: string; standard?: StandardRecord; version: StandardVersionRecord }): Promise<{ proposal: ProposalRecord; standard: StandardRecord; version: StandardVersionRecord }> {
    const version = validateStandardVersion(input.version);
    if (version.status !== "draft") throw new Error("New StandardVersion must be draft");
    return this.withTx(async (client) => {
      const proposal = await this.getProposalWithinTransaction(input.org_id, input.proposal_id, client, true);
      if (!proposal || !["new_standard", "revise_standard"].includes(proposal.kind)
        || version.org_id !== input.org_id || version.proposal_id !== proposal.id
        || !version.gate || version.gate.single_uncertainty !== proposal.single_uncertainty) {
        throw new Error("Invalid Proposal StandardVersion commit");
      }
      const existingRow = await this.queryOne<StandardVersionRow>(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = $1 AND proposal_id = $2`, [input.org_id, input.proposal_id], client);
      if (existingRow) {
        const storedCreation = validateStandardVersion(parseContextJson<StandardVersionRecord>(existingRow.payload_json));
        if (canonicalContextJson(storedCreation) !== canonicalContextJson({ ...version, created_at: storedCreation.created_at })) {
          throw new Error("Cannot replace immutable StandardVersion");
        }
        const standardRow = await this.queryOne<StandardRow>(`SELECT payload_json, current_version_id, citation_count FROM standards WHERE org_id = $1 AND id = $2`, [input.org_id, storedCreation.standard_id], client);
        if (!standardRow) throw new Error("Standard was not found");
        if (proposal.kind === "new_standard" && input.standard) {
          const storedStandard = validateStandard(parseContextJson<StandardRecord>(standardRow.payload_json));
          const attemptedStandard = validateStandard(input.standard);
          if (canonicalContextJson(storedStandard) !== canonicalContextJson({ ...attemptedStandard, created_at: storedStandard.created_at })) {
            throw new Error("Cannot replace immutable Standard");
          }
        }
        return { proposal, standard: toStandard(standardRow), version: toStandardVersion(existingRow) };
      }
      if (proposal.status !== "in_review") throw new Error("StandardVersion commit requires an in-review Proposal");
      let standard: StandardRecord;
      if (proposal.kind === "new_standard") {
        if (!input.standard) throw new Error("New Standard Proposal requires Standard identity");
        standard = validateStandard(input.standard);
        if (standard.org_id !== input.org_id || standard.id !== version.standard_id
          || standard.current_version_id || standard.citation_count !== 0
          || version.supersedes_version_id || version.gate.learning_output !== "new_standard"
          || canonicalContextJson(standard.created_by) !== canonicalContextJson(proposal.author)) {
          throw new Error("Invalid new Standard Proposal outcome");
        }
        await this.execute(`INSERT INTO standards (id, org_id, slug, payload_json, current_version_id, citation_count, created_at) VALUES ($1, $2, $3, $4, NULL, 0, $5)`, [standard.id, standard.org_id, standard.slug, jsonb(standard), standard.created_at], client);
      } else {
        const standardRow = await this.queryOne<StandardRow>(`SELECT payload_json, current_version_id, citation_count FROM standards WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, version.standard_id], client);
        standard = standardRow ? toStandard(standardRow) : null!;
        const supersedesId = version.supersedes_version_id;
        const supersededRow = supersedesId
          ? await this.queryOne<StandardVersionRow>(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = $1 AND id = $2`, [input.org_id, supersedesId], client)
          : null;
        const superseded = supersededRow ? toStandardVersion(supersededRow) : null;
        const pinned = proposal.standard_bindings.some((binding) =>
          binding.standard_id === version.standard_id && binding.version_id === supersedesId
        );
        if (!standard || !superseded || superseded.standard_id !== standard.id
          || superseded.status === "draft" || superseded.status === "deprecated"
          || standard.current_version_id !== supersedesId
          || !pinned || version.gate.learning_output !== "revision") {
          throw new Error("Invalid revised Standard Proposal outcome");
        }
      }
      await this.execute(`INSERT INTO standard_versions (id, org_id, standard_id, proposal_id, version, status, payload_json, state_json, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [version.id, version.org_id, version.standard_id, version.proposal_id, version.version, version.status, jsonb(version), jsonb(standardVersionState(version)), version.created_at], client);
      await this.execute(`UPDATE proposals SET status = 'accepted', outcome_kind = 'standard_version', outcome_ref_id = $1, updated_at = $2 WHERE org_id = $3 AND id = $4 AND status = 'in_review'`, [version.id, version.created_at, input.org_id, proposal.id], client);
      return {
        proposal: (await this.getProposalWithinTransaction(input.org_id, proposal.id, client))!,
        standard,
        version,
      };
    });
  }

  async getStandard(orgId: string, standardId: string): Promise<StandardRecord | null> {
    const row = await this.queryOne<StandardRow>(`SELECT payload_json, current_version_id, citation_count FROM standards WHERE org_id = $1 AND id = $2`, [orgId, standardId]);
    return row ? toStandard(row) : null;
  }

  async getStandardBySlug(orgId: string, slug: string): Promise<StandardRecord | null> {
    const row = await this.queryOne<StandardRow>(`SELECT payload_json, current_version_id, citation_count FROM standards WHERE org_id = $1 AND slug = $2`, [orgId, slug]);
    return row ? toStandard(row) : null;
  }

  async listStandards(input: {
    org_id: string;
    limit?: number;
    after_created_at?: string;
    after_id?: string;
  }): Promise<StandardRecord[]> {
    const hasCursor = !!input.after_created_at && !!input.after_id;
    const rows = await this.query<StandardRow>(
      `SELECT payload_json, current_version_id, citation_count FROM standards
       WHERE org_id = $1${hasCursor ? " AND (created_at > $2 OR (created_at = $2 AND id > $3))" : ""}
       ORDER BY created_at, id LIMIT $${hasCursor ? 4 : 2}`,
      hasCursor
        ? [input.org_id, input.after_created_at!, input.after_id!, input.limit ?? 100]
        : [input.org_id, input.limit ?? 100],
    );
    return rows.map(toStandard);
  }

  async getStandardVersion(orgId: string, versionId: string): Promise<StandardVersionRecord | null> {
    const row = await this.queryOne<StandardVersionRow>(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = $1 AND id = $2`, [orgId, versionId]);
    return row ? toStandardVersion(row) : null;
  }

  async listStandardVersions(input: { org_id: string; standard_id: string; limit?: number }): Promise<StandardVersionRecord[]> {
    const rows = await this.query<StandardVersionRow>(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = $1 AND standard_id = $2 ORDER BY created_at, id LIMIT $3`, [input.org_id, input.standard_id, input.limit ?? 100]);
    return rows.map(toStandardVersion);
  }

  async transitionStandardVersion(input: StandardVersionTransition): Promise<StandardVersionRecord | null> {
    return this.withTx(async (client) => {
      const row = await this.queryOne<StandardVersionRow>(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, input.version_id], client);
      if (!row) return null;
      const current = toStandardVersion(row);
      const standardRow = await this.queryOne<StandardRow>(`SELECT payload_json, current_version_id, citation_count FROM standards WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, current.standard_id], client);
      if (!standardRow) throw new Error("Standard was not found");
      const standard = toStandard(standardRow);
      if (input.superseded_by_version_id) {
        const replacementRow = await this.queryOne<StandardVersionRow>(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = $1 AND id = $2`, [input.org_id, input.superseded_by_version_id], client);
        const replacement = replacementRow ? toStandardVersion(replacementRow) : null;
        if (!replacement || replacement.standard_id !== current.standard_id || replacement.status !== "active") {
          throw new Error("StandardVersion replacement must be active in the same Standard");
        }
      }
      const next = applyStandardVersionTransition(current, standard, input);
      await this.execute(`UPDATE standard_versions SET status = $1, state_json = $2 WHERE org_id = $3 AND id = $4 AND status = $5`, [next.status, jsonb(standardVersionState(next)), input.org_id, input.version_id, current.status], client);
      if (next.status === "trial" || next.status === "active") {
        await this.execute(`UPDATE standards SET current_version_id = $1 WHERE org_id = $2 AND id = $3`, [next.id, input.org_id, standard.id], client);
      } else if (next.superseded_by_version_id) {
        await this.execute(`UPDATE standards SET current_version_id = $1 WHERE org_id = $2 AND id = $3 AND current_version_id = $4`, [next.superseded_by_version_id, input.org_id, standard.id, next.id], client);
      }
      return next;
    });
  }

  async putStandardGap(input: StandardGapRecord): Promise<StandardGapRecord> {
    const gap = validateStandardGap(input);
    if (gap.status !== "open") throw new Error("New StandardGap must be open");
    await this.execute(`INSERT INTO standard_gaps (id, org_id, source_kind, source_ref, status, payload_json, converted_proposal_id, created_at, updated_at) VALUES ($1, $2, $3, $4, 'open', $5, NULL, $6, $7) ON CONFLICT DO NOTHING`, [gap.id, gap.org_id, gap.source_kind, gap.source_ref, jsonb(gap), gap.created_at, gap.updated_at]);
    const row = await this.queryOne<StandardGapRow>(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = $1 AND source_kind = $2 AND source_ref = $3`, [gap.org_id, gap.source_kind, gap.source_ref]);
    if (!row) throw new Error("Cannot persist StandardGap");
    const storedCreation = validateStandardGap(parseContextJson<StandardGapRecord>(row.payload_json));
    if (canonicalContextJson(storedCreation) !== canonicalContextJson({
      ...gap,
      id: storedCreation.id,
      created_at: storedCreation.created_at,
      updated_at: storedCreation.updated_at,
    })) throw new Error("Cannot replace immutable StandardGap");
    return toStandardGap(row);
  }

  async getStandardGap(orgId: string, gapId: string): Promise<StandardGapRecord | null> {
    const row = await this.queryOne<StandardGapRow>(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = $1 AND id = $2`, [orgId, gapId]);
    return row ? toStandardGap(row) : null;
  }

  async listStandardGaps(input: { org_id: string; status?: StandardGapStatus; limit?: number }): Promise<StandardGapRecord[]> {
    const rows = await this.query<StandardGapRow>(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = $1 ${input.status ? "AND status = $2" : ""} ORDER BY created_at, id LIMIT $${input.status ? 3 : 2}`, input.status ? [input.org_id, input.status, input.limit ?? 100] : [input.org_id, input.limit ?? 100]);
    return rows.map(toStandardGap);
  }

  async convertStandardGap(input: { org_id: string; gap_id: string; proposal: ProposalRecord }): Promise<{ gap: StandardGapRecord; proposal: ProposalRecord }> {
    const proposal = validateProposal(input.proposal);
    return this.withTx(async (client) => {
      const gapRow = await this.queryOne<StandardGapRow>(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, input.gap_id], client);
      if (!gapRow) throw new Error("StandardGap was not found");
      const gap = toStandardGap(gapRow);
      if (gap.status === "converted") {
        if (gap.converted_proposal_id !== proposal.id) throw new Error("Cannot replace StandardGap Proposal");
        const proposalRow = await this.queryOne<ProposalRow>(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = $1 AND id = $2`, [input.org_id, proposal.id], client);
        if (!proposalRow) throw new Error("Converted StandardGap Proposal was not found");
        const storedCreation = validateProposal(parseContextJson<ProposalRecord>(proposalRow.payload_json));
        if (canonicalContextJson(storedCreation) !== canonicalContextJson({
          ...proposal,
          created_at: storedCreation.created_at,
          updated_at: storedCreation.updated_at,
        })) throw new Error("Cannot replace StandardGap Proposal");
        return { gap, proposal: toProposal(proposalRow) };
      }
      validateStandardGapConversion(gap, proposal);
      await this.execute(`INSERT INTO proposals (id, org_id, status, source_digest_id, source_item_event_id, payload_json, created_at, updated_at) VALUES ($1, $2, 'draft', NULL, NULL, $3, $4, $5)`, [proposal.id, proposal.org_id, jsonb(proposal), proposal.created_at, proposal.updated_at], client);
      await this.execute(`UPDATE standard_gaps SET status = 'converted', converted_proposal_id = $1, updated_at = $2 WHERE org_id = $3 AND id = $4 AND status = 'open'`, [proposal.id, proposal.created_at, input.org_id, input.gap_id], client);
      const convertedRow = await this.queryOne<StandardGapRow>(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = $1 AND id = $2`, [input.org_id, input.gap_id], client);
      return { gap: toStandardGap(convertedRow!), proposal };
    });
  }

  async dismissStandardGap(input: { org_id: string; gap_id: string; dismissed_at: string }): Promise<StandardGapRecord | null> {
    if (!input.org_id?.trim() || !input.gap_id?.trim() || Number.isNaN(Date.parse(input.dismissed_at))) throw new Error("Invalid StandardGap dismissal");
    return this.withTx(async (client) => {
      const row = await this.queryOne<StandardGapRow>(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, input.gap_id], client);
      if (!row) return null;
      const gap = toStandardGap(row);
      if (gap.status === "converted") throw new Error("Converted StandardGap cannot be dismissed");
      if (gap.status === "dismissed") return gap;
      if (Date.parse(input.dismissed_at) < Date.parse(gap.created_at)) throw new Error("Invalid StandardGap dismissal");
      await this.execute(`UPDATE standard_gaps SET status = 'dismissed', updated_at = $1 WHERE org_id = $2 AND id = $3 AND status = 'open'`, [input.dismissed_at, input.org_id, input.gap_id], client);
      return validateStandardGap({ ...gap, status: "dismissed", updated_at: input.dismissed_at });
    });
  }

  async putAgentRun(input: AgentRunRecord): Promise<AgentRunRecord> {
    const run = validateAgentRun(input);
    if (run.status !== "queued") throw new Error("New AgentRun must be queued");
    await this.execute(`INSERT INTO agent_runs (id, org_id, status, payload_json, state_json, created_at) VALUES ($1, $2, 'queued', $3, $4, $5) ON CONFLICT (id) DO NOTHING`, [run.id, run.org_id, jsonb(run), jsonb(agentRunState(run)), run.created_at]);
    const row = await this.queryOne<AgentRunRow>(`SELECT status, payload_json, state_json FROM agent_runs WHERE org_id = $1 AND id = $2`, [run.org_id, run.id]);
    if (!row) throw new Error("Cannot persist AgentRun");
    const storedCreation = validateAgentRun(parseContextJson<AgentRunRecord>(row.payload_json));
    if (canonicalContextJson(storedCreation) !== canonicalContextJson({ ...run, created_at: storedCreation.created_at })) {
      throw new Error("Cannot replace immutable AgentRun");
    }
    return toAgentRun(row);
  }

  async getAgentRun(orgId: string, runId: string): Promise<AgentRunRecord | null> {
    const row = await this.queryOne<AgentRunRow>(`SELECT status, payload_json, state_json FROM agent_runs WHERE org_id = $1 AND id = $2`, [orgId, runId]);
    return row ? toAgentRun(row) : null;
  }

  async listAgentRuns(input: { org_id: string; status?: AgentRunStatus; newest_first?: boolean; limit?: number }): Promise<AgentRunRecord[]> {
    const order = input.newest_first
      ? "ORDER BY (state_json->>'finished_at')::timestamptz DESC NULLS LAST, id DESC"
      : "ORDER BY created_at, id";
    const rows = await this.query<AgentRunRow>(`SELECT status, payload_json, state_json FROM agent_runs WHERE org_id = $1 ${input.status ? "AND status = $2" : ""} ${order} LIMIT $${input.status ? 3 : 2}`, input.status ? [input.org_id, input.status, input.limit ?? 100] : [input.org_id, input.limit ?? 100]);
    return rows.map(toAgentRun);
  }

  async startAgentRun(input: { org_id: string; run_id: string; started_at: string }): Promise<AgentRunRecord | null> {
    return this.withTx(async (client) => {
      const row = await this.getAgentRunWithinTransaction(input.org_id, input.run_id, client);
      if (!row) return null;
      const current = toAgentRun(row);
      if (current.status === "running") return current;
      const next = applyAgentRunStart(current, input.started_at);
      await this.updateAgentRunState(current, next, client);
      return next;
    });
  }

  async settleAgentRun(input: { org_id: string; run_id: string; status: "succeeded" | "failed"; output: AgentRunOutput; finished_at: string }): Promise<AgentRunRecord | null> {
    return this.withTx(async (client) => {
      const row = await this.getAgentRunWithinTransaction(input.org_id, input.run_id, client);
      if (!row) return null;
      const current = toAgentRun(row);
      if (current.status === input.status && canonicalContextJson(current.output) === canonicalContextJson(input.output)) return current;
      const next = applyAgentRunSettlement(current, input.status, input.output, input.finished_at);
      await this.updateAgentRunState(current, next, client);
      return next;
    });
  }

  async handoffAgentRun(input: { org_id: string; run_id: string; handoff: HandoffRecord; handed_off_at: string }): Promise<{ run: AgentRunRecord; handoff: HandoffRecord }> {
    const handoff = validateHandoff(input.handoff);
    return this.withTx(async (client) => {
      const runRow = await this.getAgentRunWithinTransaction(input.org_id, input.run_id, client);
      if (!runRow) throw new Error("AgentRun was not found");
      const current = toAgentRun(runRow);
      if (current.status === "handed_off") {
        if (current.handoff_id !== handoff.id) throw new Error("Cannot replace AgentRun Handoff");
        const handoffRow = await this.queryOne<HandoffRow>(`SELECT status, payload_json, resolved_at FROM handoffs WHERE org_id = $1 AND id = $2`, [input.org_id, handoff.id], client);
        if (!handoffRow) throw new Error("AgentRun Handoff was not found");
        const storedCreation = validateHandoff(parseContextJson<HandoffRecord>(handoffRow.payload_json));
        if (canonicalContextJson(storedCreation) !== canonicalContextJson({ ...handoff, created_at: storedCreation.created_at })) {
          throw new Error("Cannot replace AgentRun Handoff");
        }
        return { run: current, handoff: toHandoff(handoffRow) };
      }
      const next = applyAgentRunHandoff(current, handoff, input.handed_off_at);
      await this.execute(`INSERT INTO handoffs (id, org_id, direction, status, payload_json, created_at, resolved_at) VALUES ($1, $2, $3, 'open', $4, $5, NULL)`, [handoff.id, handoff.org_id, handoff.direction, jsonb(handoff), handoff.created_at], client);
      await this.updateAgentRunState(current, next, client);
      return { run: next, handoff };
    });
  }

  async cancelAgentRun(input: { org_id: string; run_id: string; cancelled_at: string }): Promise<AgentRunRecord | null> {
    return this.withTx(async (client) => {
      const row = await this.getAgentRunWithinTransaction(input.org_id, input.run_id, client);
      if (!row) return null;
      const current = toAgentRun(row);
      if (current.status === "cancelled") return current;
      const next = applyAgentRunCancellation(current, input.cancelled_at);
      await this.updateAgentRunState(current, next, client);
      return next;
    });
  }

  async projectStandardUsage(input: { org_id: string; source_kind: StandardUsageSourceKind; source_id: string }): Promise<StandardUsageRecord[]> {
    if (!input.org_id?.trim() || !input.source_id?.trim() || !["decision", "agent_run"].includes(input.source_kind)) {
      throw new Error("Invalid StandardUsage projection");
    }
    return this.withTx(async (client) => {
      let bindings: Array<{ standard_id: string; version_id: string }>;
      let contextSnapshotId: string;
      let citedAt: string;
      if (input.source_kind === "decision") {
        const row = await this.queryOne<{ payload_json: unknown }>(`SELECT payload_json FROM decisions WHERE org_id = $1 AND id = $2`, [input.org_id, input.source_id], client);
        if (!row) throw new Error("StandardUsage source Decision was not found");
        const decision = validateDecision(parseContextJson<DecisionRecord>(row.payload_json));
        bindings = decision.standard_bindings;
        contextSnapshotId = decision.context_snapshot_id;
        citedAt = decision.committed_at;
      } else {
        const row = await this.queryOne<AgentRunRow>(`SELECT status, payload_json, state_json FROM agent_runs WHERE org_id = $1 AND id = $2`, [input.org_id, input.source_id], client);
        if (!row) throw new Error("StandardUsage source AgentRun was not found");
        const run = toAgentRun(row);
        bindings = run.standard_bindings;
        contextSnapshotId = run.context_snapshot_id;
        citedAt = run.created_at;
      }
      for (const standardId of [...new Set(bindings.map(({ standard_id }) => standard_id))].sort()) {
        const locked = await this.queryOne<{ id: string }>(`SELECT id FROM standards WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, standardId], client);
        if (!locked) throw new Error("StandardUsage binding was not found");
      }
      const usages: StandardUsageRecord[] = [];
      for (const binding of bindings) {
        const standardRow = await this.queryOne<StandardRow>(`SELECT payload_json, current_version_id, citation_count FROM standards WHERE org_id = $1 AND id = $2`, [input.org_id, binding.standard_id], client);
        const versionRow = await this.queryOne<StandardVersionRow>(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = $1 AND id = $2`, [input.org_id, binding.version_id], client);
        const standard = standardRow ? toStandard(standardRow) : null;
        const version = versionRow ? toStandardVersion(versionRow) : null;
        if (!standard || !version || version.standard_id !== standard.id) {
          throw new Error("StandardUsage binding was not found");
        }
        const usage = validateStandardUsage({
          schema_version: STANDARD_USAGE_SCHEMA_VERSION,
          id: `standard-usage:${hashCanonicalContext([
            input.org_id, input.source_kind, input.source_id, standard.id, version.id,
          ])}`,
          org_id: input.org_id,
          standard_id: standard.id,
          version_id: version.id,
          source_kind: input.source_kind,
          source_id: input.source_id,
          context_snapshot_id: contextSnapshotId,
          cited_at: citedAt,
        });
        await this.execute(`INSERT INTO standard_usage (id, org_id, standard_id, version_id, source_kind, source_id, context_snapshot_id, cited_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`, [usage.id, usage.org_id, usage.standard_id, usage.version_id, usage.source_kind, usage.source_id, usage.context_snapshot_id, usage.cited_at], client);
        usages.push(usage);
      }
      for (const standardId of new Set(usages.map(({ standard_id }) => standard_id))) {
        await this.execute(`UPDATE standards SET citation_count = (SELECT COUNT(*) FROM standard_usage WHERE org_id = $1 AND standard_id = $2) WHERE org_id = $1 AND id = $2`, [input.org_id, standardId], client);
      }
      return usages;
    });
  }

  async listStandardUsage(input: { org_id: string; standard_id?: string; version_id?: string; source_kind?: StandardUsageSourceKind; newest_first?: boolean; limit?: number }): Promise<StandardUsageRecord[]> {
    const conditions = ["org_id = $1"];
    const values: unknown[] = [input.org_id];
    if (input.standard_id) { values.push(input.standard_id); conditions.push(`standard_id = $${values.length}`); }
    if (input.version_id) { values.push(input.version_id); conditions.push(`version_id = $${values.length}`); }
    if (input.source_kind) { values.push(input.source_kind); conditions.push(`source_kind = $${values.length}`); }
    values.push(input.limit ?? 100);
    const order = input.newest_first ? "cited_at DESC, id DESC" : "cited_at, id";
    const rows = await this.query<Omit<StandardUsageRecord, "schema_version">>(`SELECT id, org_id, standard_id, version_id, source_kind, source_id, context_snapshot_id, cited_at FROM standard_usage WHERE ${conditions.join(" AND ")} ORDER BY ${order} LIMIT $${values.length}`, values);
    return rows.map((row) => validateStandardUsage({
      schema_version: STANDARD_USAGE_SCHEMA_VERSION,
      ...row,
      cited_at: toIso(row.cited_at),
    }));
  }

  async countStandardUsage(input: { org_id: string; standard_id?: string; version_id?: string; source_kind?: StandardUsageSourceKind }): Promise<number> {
    const conditions = ["org_id = $1"];
    const values: unknown[] = [input.org_id];
    if (input.standard_id) { values.push(input.standard_id); conditions.push(`standard_id = $${values.length}`); }
    if (input.version_id) { values.push(input.version_id); conditions.push(`version_id = $${values.length}`); }
    if (input.source_kind) { values.push(input.source_kind); conditions.push(`source_kind = $${values.length}`); }
    const row = await this.queryOne<{ count: string }>(`SELECT COUNT(*) AS count FROM standard_usage WHERE ${conditions.join(" AND ")}`, values);
    return Number(row?.count ?? 0);
  }

  private async getProposalWithinTransaction(orgId: string, proposalId: string, client: PoolClient, lock = false): Promise<ProposalRecord | null> {
    const row = await this.queryOne<ProposalRow>(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`, [orgId, proposalId], client);
    return row ? toProposal(row) : null;
  }

  private async getAgentRunWithinTransaction(orgId: string, runId: string, client: PoolClient): Promise<AgentRunRow | null> {
    return this.queryOne<AgentRunRow>(`SELECT status, payload_json, state_json FROM agent_runs WHERE org_id = $1 AND id = $2 FOR UPDATE`, [orgId, runId], client);
  }

  private async updateAgentRunState(current: AgentRunRecord, next: AgentRunRecord, client: PoolClient): Promise<void> {
    const result = await client.query(`UPDATE agent_runs SET status = $1, state_json = $2 WHERE org_id = $3 AND id = $4 AND status = $5`, [next.status, jsonb(agentRunState(next)), current.org_id, current.id, current.status]);
    if (result.rowCount !== 1) throw new Error("AgentRun state changed concurrently");
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
    const hiddenCounted = await this.queryOne<{ count: unknown }>(
      `
        SELECT COUNT(*)::int AS count
        FROM thread_heads th
        WHERE th.org_id = $1
          AND th.thread_id IN (
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
      hidden_count: asNumber(hiddenCounted?.count ?? 0),
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
    return this.withTx((client) => this.putConversationPrefOn(client, input));
  }

  private async putConversationPrefOn(
    client: PoolClient,
    input: ConversationPrefPatch,
  ): Promise<ConversationPref> {
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
      await this.execute(
        `
          DELETE FROM connector_sync_work
          WHERE installation_id IN (
            SELECT id FROM connector_installations WHERE org_id = $1
          )
        `,
        [orgId],
        client,
      );
      await this.execute(`DELETE FROM sync_runs WHERE org_id = $1`, [orgId], client);
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

  async getDailyDigestPolicy(orgId: string): Promise<DailyDigestPolicy | null> {
    const value = await this.getUiPref(orgId, "daily_digest_policy_v1");
    return value ? validateDailyDigestPolicy(JSON.parse(value) as DailyDigestPolicy) : null;
  }

  async putDailyDigestPolicy(input: { org_id: string; policy: DailyDigestPolicy; updated_at: string }): Promise<DailyDigestPolicy> {
    const policy = validateDailyDigestPolicy(input.policy);
    if (!input.org_id.trim() || Number.isNaN(Date.parse(input.updated_at))) throw new Error("Invalid daily digest policy update");
    await this.putUiPref(input.org_id, "daily_digest_policy_v1", canonicalContextJson(policy), input.updated_at);
    return policy;
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
    return this.withTx((client) => this.commitIngestOn(client, request));
  }

  private async commitIngestOn(
    client: PoolClient,
    request: IngestCommitRequest,
  ): Promise<EventRecord[]> {
    if (request.appends.length === 0 && request.dispositions.length === 0) {
      return [];
    }
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
        `DELETE FROM connector_sync_work WHERE installation_id = $1`,
        [id],
        client,
      );
      await this.execute(
        `DELETE FROM sync_runs WHERE installation_id = $1`,
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
    await this.beginAttemptOn(undefined, input);
    return (await this.findAttempt(input.id))!;
  }

  async commitSyncPage(input: CommitSyncPage): Promise<CommitSyncPageResult> {
    const startedAt = Date.now();
    try {
      return await this.withTx(async (client) => {
        await this.beginAttemptOn(client, input.attempt);
        const events = input.ingest
          ? await this.commitIngestOn(client, input.ingest)
          : [];
        for (const pref of input.prefs ?? []) {
          await this.putConversationPrefOn(client, pref);
        }
        const attempt = await this.settleAttemptOn(client, input.settle);
        return { attempt, events };
      });
    } finally {
      recordSyncDuration(processSyncMetrics, "database_transaction_ms", startedAt, {
        operation: "commit_sync_page",
      });
    }
  }

  async settleAttempt(input: SettleIngestAttempt): Promise<IngestAttempt> {
    return this.withTx((client) => this.settleAttemptOn(client, input));
  }

  private async beginAttemptOn(
    client: PoolClient | undefined,
    input: NewIngestAttempt,
  ): Promise<void> {
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
      client,
    );
  }

  private async settleAttemptOn(
    client: PoolClient,
    input: SettleIngestAttempt,
  ): Promise<IngestAttempt> {
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

  async listCursors(
    installationId: string,
    streamKeys?: readonly string[],
  ): Promise<ConnectorStreamCursor[]> {
    if (streamKeys && streamKeys.length === 0) {
      return [];
    }
    const rows = streamKeys
      ? await this.query<CursorRow>(
          `
            SELECT ${CURSOR_COLUMNS}
            FROM connector_cursors
            WHERE installation_id = $1 AND stream_key = ANY($2::text[])
            ORDER BY stream_key
          `,
          [installationId, [...streamKeys]],
        )
      : await this.query<CursorRow>(
          `
            SELECT ${CURSOR_COLUMNS}
            FROM connector_cursors
            WHERE installation_id = $1
            ORDER BY stream_key
          `,
          [installationId],
        );
    return rows.map((row) => this.toCursor(row));
  }

  async createSyncRun(input: NewSyncRun): Promise<SyncRun> {
    validateSyncRunOptions(input.options ?? {});
    const installation = await this.queryOne<{ id: string }>(
      `SELECT id FROM connector_installations WHERE id = $1 AND org_id = $2`,
      [input.installation_id, input.org_id],
    );
    if (!installation) {
      throw new Error("Connector installation not found for sync run");
    }
    const row = await this.queryOne<SyncRunRow>(
      `
        INSERT INTO sync_runs (
          id, org_id, installation_id, mode, status, options_json,
          total_work, completed_work, failed_work, accepted_count,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, 'queued', $5, 0, 0, 0, 0, $6, $6)
        RETURNING *
      `,
      [
        input.id,
        input.org_id,
        input.installation_id,
        input.mode,
        jsonb(input.options ?? {}),
        input.now,
      ],
    );
    return this.toSyncRun(row!);
  }

  async getSyncRun(id: string, orgId: string): Promise<SyncRun | null> {
    const row = await this.queryOne<SyncRunRow>(
      `SELECT * FROM sync_runs WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    return row ? this.toSyncRun(row) : null;
  }

  async listSyncRuns(query: ListSyncRunsQuery): Promise<SyncRun[]> {
    const limit =
      Number.isInteger(query.limit) && Number(query.limit) > 0
        ? Math.min(Number(query.limit), 1_000)
        : 100;
    const rows = query.installation_id
      ? await this.query<SyncRunRow>(
          `
            SELECT * FROM sync_runs
            WHERE org_id = $1 AND installation_id = $2
            ORDER BY created_at DESC, id DESC LIMIT $3
          `,
          [query.org_id, query.installation_id, limit],
        )
      : await this.query<SyncRunRow>(
          `
            SELECT * FROM sync_runs
            WHERE org_id = $1
            ORDER BY created_at DESC, id DESC LIMIT $2
          `,
          [query.org_id, limit],
        );
    return rows.map((row) => this.toSyncRun(row));
  }

  async commandSyncRun(input: CommandSyncRun): Promise<SyncRun | null> {
    return this.withTx(async (client) => {
      const current = await this.queryOne<SyncRunRow>(
        `SELECT * FROM sync_runs WHERE id = $1 AND org_id = $2 FOR UPDATE`,
        [input.id, input.org_id],
        client,
      );
      if (!current) {
        return null;
      }
      if (
        input.command === "pause" &&
        (current.status === "queued" || current.status === "running")
      ) {
        await this.execute(
          `UPDATE sync_runs SET status = 'paused', updated_at = $1 WHERE id = $2`,
          [input.now, input.id],
          client,
        );
      } else if (
        input.command === "resume" &&
        current.status === "paused"
      ) {
        await this.execute(
          `
            UPDATE sync_runs
            SET status = 'queued', finished_at = NULL, updated_at = $1
            WHERE id = $2
          `,
          [input.now, input.id],
          client,
        );
      } else if (
        input.command === "cancel" &&
        (current.status === "queued" ||
          current.status === "running" ||
          current.status === "paused")
      ) {
        await this.execute(
          `
            UPDATE sync_runs
            SET status = 'cancelled', finished_at = $1, updated_at = $1
            WHERE id = $2
          `,
          [input.now, input.id],
          client,
        );
        await this.execute(
          `
            UPDATE connector_sync_work
            SET status = 'cancelled', lease_owner = NULL,
                lease_expires_at = NULL, updated_at = $1
            WHERE run_id = $2 AND status IN ('pending', 'running')
          `,
          [input.now, input.id],
          client,
        );
      }
      const next = await this.queryOne<SyncRunRow>(
        `SELECT * FROM sync_runs WHERE id = $1`,
        [input.id],
        client,
      );
      return next ? this.toSyncRun(next) : null;
    });
  }

  async enqueueSyncWork(input: EnqueueSyncWork): Promise<SyncWorkRecord> {
    return this.withTx((client) => this.enqueueSyncWorkOn(client, input));
  }

  async enqueueSyncWorkMany(
    inputs: readonly EnqueueSyncWork[],
  ): Promise<number> {
    if (inputs.length === 0) {
      return 0;
    }
    return this.withTx(async (client) => {
      for (const input of inputs) {
        await this.enqueueSyncWorkOn(client, input);
      }
      return inputs.length;
    });
  }

  private async enqueueSyncWorkOn(
    client: PoolClient,
    input: EnqueueSyncWork,
  ): Promise<SyncWorkRecord> {
    const current = await this.queryOne<SyncWorkRow>(
      `
        SELECT * FROM connector_sync_work
        WHERE installation_id = $1 AND stream_key = $2
          AND lane = $3 AND generation = $4
        FOR UPDATE
      `,
      [
        input.installation_id,
        input.stream_key,
        input.lane,
        input.generation,
      ],
      client,
    );
    if (current) {
      if (current.status !== "running") {
        const row = await this.queryOne<SyncWorkRow>(
          `
            UPDATE connector_sync_work
            SET run_id = COALESCE($1, run_id), priority = $2,
                next_due_at = $3, status = 'pending',
                lease_owner = NULL, lease_expires_at = NULL,
                last_error = NULL, updated_at = $4
            WHERE id = $5 RETURNING *
          `,
          [
            input.run_id ?? null,
            input.priority ?? syncWorkPriority(input.lane),
            input.next_due_at,
            input.now,
            current.id,
          ],
          client,
        );
        return this.toSyncWork(row!);
      }
      return this.toSyncWork(current);
    }
    if (input.run_id) {
      const run = await this.queryOne<{ id: string }>(
        `SELECT id FROM sync_runs WHERE id = $1`,
        [input.run_id],
        client,
      );
      if (!run) {
        throw new Error(`Sync run not found: ${input.run_id}`);
      }
    }
    const row = await this.queryOne<SyncWorkRow>(
      `
        INSERT INTO connector_sync_work (
          id, run_id, installation_id, stream_key, lane, priority,
          next_due_at, status, attempts, generation, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', 0, $8, $9, $9)
        RETURNING *
      `,
      [
        input.id,
        input.run_id ?? null,
        input.installation_id,
        input.stream_key,
        input.lane,
        input.priority ?? syncWorkPriority(input.lane),
        input.next_due_at,
        input.generation,
        input.now,
      ],
      client,
    );
    if (input.run_id) {
      await this.execute(
        `
          UPDATE sync_runs
          SET total_work = total_work + 1, updated_at = $1
          WHERE id = $2
        `,
        [input.now, input.run_id],
        client,
      );
    }
    return this.toSyncWork(row!);
  }

  async claimSyncWork(input: ClaimSyncWork): Promise<SyncWorkRecord[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      return [];
    }
    return this.withTx(async (client) => {
      const params: unknown[] = [input.now];
      const clauses = [
        `(
          (w.status = 'pending' AND w.next_due_at <= $1::timestamptz)
          OR
          (w.status = 'running' AND w.lease_expires_at <= $1::timestamptz)
        )`,
        `(w.run_id IS NULL OR r.status IN ('queued', 'running'))`,
      ];
      if (input.work_id) {
        params.push(input.work_id);
        clauses.push(`w.id = $${params.length}`);
      }
      if (input.installation_id) {
        params.push(input.installation_id);
        clauses.push(`w.installation_id = $${params.length}`);
      }
      if (input.lanes?.length) {
        params.push(input.lanes);
        clauses.push(`w.lane = ANY($${params.length}::text[])`);
      }
      if (input.unassigned) {
        clauses.push(`w.run_id IS NULL`);
      }
      params.push(Math.min(input.limit, 1_000));
      const limitParam = params.length;
      const candidates = await this.query<{ id: string }>(
        `
          SELECT w.id
          FROM connector_sync_work w
          LEFT JOIN sync_runs r ON r.id = w.run_id
          WHERE ${clauses.join(" AND ")}
          ORDER BY w.priority DESC, w.next_due_at, w.created_at, w.id
          LIMIT $${limitParam}
          FOR UPDATE OF w SKIP LOCKED
        `,
        params,
        client,
      );
      if (candidates.length === 0) {
        return [];
      }
      const ids = candidates.map((candidate) => candidate.id);
      const leaseExpiresAt = new Date(
        Date.parse(input.now) + input.lease_ms,
      ).toISOString();
      const rows = await this.query<SyncWorkRow>(
        `
          UPDATE connector_sync_work
          SET status = 'running', attempts = attempts + 1,
              lease_owner = $1, lease_expires_at = $2, updated_at = $3
          WHERE id = ANY($4::text[])
          RETURNING *
        `,
        [input.owner, leaseExpiresAt, input.now, ids],
        client,
      );
      await this.execute(
        `
          UPDATE sync_runs
          SET status = 'running',
              started_at = COALESCE(started_at, $1),
              updated_at = $1
          WHERE status = 'queued'
            AND id IN (
              SELECT DISTINCT run_id FROM connector_sync_work
              WHERE id = ANY($2::text[]) AND run_id IS NOT NULL
            )
        `,
        [input.now, ids],
        client,
      );
      const byId = new Map(rows.map((row) => [row.id, row] as const));
      return ids.map((id) => this.toSyncWork(byId.get(id)!));
    });
  }

  async renewSyncWork(input: RenewSyncWork): Promise<boolean> {
    const leaseExpiresAt = new Date(
      Date.parse(input.now) + input.lease_ms,
    ).toISOString();
    return (
      (await this.execute(
        `
          UPDATE connector_sync_work
          SET lease_expires_at = $1, updated_at = $2
          WHERE id = $3 AND status = 'running' AND lease_owner = $4
            AND lease_expires_at > $2::timestamptz
        `,
        [leaseExpiresAt, input.now, input.id, input.owner],
      )) === 1
    );
  }

  async settleSyncWork(
    input: SettleSyncWork,
  ): Promise<SyncWorkRecord | null> {
    return this.withTx(async (client) => {
      const current = await this.queryOne<SyncWorkRow>(
        `SELECT * FROM connector_sync_work WHERE id = $1 FOR UPDATE`,
        [input.id],
        client,
      );
      if (
        !current ||
        current.status !== "running" ||
        current.lease_owner !== input.owner
      ) {
        return null;
      }
      const status =
        input.outcome === "retry" ? "pending" : input.outcome;
      const row = await this.queryOne<SyncWorkRow>(
        `
          UPDATE connector_sync_work
          SET status = $1, next_due_at = $2, lease_owner = NULL,
              lease_expires_at = NULL, last_error = $3, updated_at = $4
          WHERE id = $5 AND status = 'running' AND lease_owner = $6
          RETURNING *
        `,
        [
          status,
          input.next_due_at ?? toIso(current.next_due_at),
          input.error_code ?? null,
          input.now,
          input.id,
          input.owner,
        ],
        client,
      );
      if (current.run_id && input.outcome !== "retry") {
        await this.execute(
          `
            UPDATE sync_runs
            SET completed_work = completed_work + $1,
                failed_work = failed_work + $2,
                accepted_count = accepted_count + $3,
                last_error = COALESCE($4, last_error),
                updated_at = $5
            WHERE id = $6 AND status != 'cancelled'
          `,
          [
            input.outcome === "succeeded" ? 1 : 0,
            input.outcome === "failed" ? 1 : 0,
            Math.max(0, input.accepted_count ?? 0),
            input.error_code ?? null,
            input.now,
            current.run_id,
          ],
          client,
        );
        const remaining = await this.queryOne<{ found: number }>(
          `
            SELECT 1 AS found FROM connector_sync_work
            WHERE run_id = $1 AND status IN ('pending', 'running')
            LIMIT 1
          `,
          [current.run_id],
          client,
        );
        if (!remaining) {
          await this.execute(
            `
              UPDATE sync_runs
              SET status = CASE
                    WHEN failed_work > 0 THEN 'failed'
                    ELSE 'succeeded'
                  END,
                  finished_at = $1, updated_at = $1
              WHERE id = $2 AND status NOT IN ('paused', 'cancelled')
            `,
            [input.now, current.run_id],
            client,
          );
        }
      }
      return row ? this.toSyncWork(row) : null;
    });
  }

  async hasUnassignedSyncWork(
    query: UnassignedSyncWorkQuery = {},
  ): Promise<boolean> {
    const { sql, params } = unassignedSyncWorkWhere(query);
    const row = await this.queryOne<{ found: number }>(
      `SELECT 1 AS found FROM connector_sync_work WHERE ${sql} LIMIT 1`,
      params,
    );
    return Boolean(row);
  }

  async listUnassignedSyncWorkIdentities(query: {
    installation_id: string;
  }): Promise<SyncWorkIdentity[]> {
    const { sql, params } = unassignedSyncWorkWhere({
      installation_id: query.installation_id,
    });
    const rows = await this.query<SyncWorkIdentity>(
      `
        SELECT stream_key, lane, generation
        FROM connector_sync_work
        WHERE ${sql}
      `,
      params,
    );
    return rows.map((row) => ({
      stream_key: row.stream_key,
      lane: row.lane,
      generation: row.generation,
    }));
  }

  async wakeUnassignedSyncWork(
    input: WakeUnassignedSyncWork,
  ): Promise<number> {
    const streamKeys = uniqueStreamKeys(input.stream_keys);
    if (streamKeys.length === 0) {
      return 0;
    }
    const keyPlaceholders = streamKeys
      .map((_, index) => `$${index + 4}`)
      .join(", ");
    return this.execute(
      `
        UPDATE connector_sync_work
        SET next_due_at = $1::timestamptz, updated_at = $2::timestamptz
        WHERE installation_id = $3
          AND run_id IS NULL
          AND status = 'pending'
          AND stream_key IN (${keyPlaceholders})
      `,
      [input.now, input.now, input.installation_id, ...streamKeys],
    );
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

  private toSyncRun(row: SyncRunRow): SyncRun {
    return {
      id: row.id,
      org_id: row.org_id,
      installation_id: row.installation_id,
      mode: row.mode,
      status: row.status,
      options: parseContextJson<SyncRun["options"]>(row.options_json),
      total_work: asNumber(row.total_work),
      completed_work: asNumber(row.completed_work),
      failed_work: asNumber(row.failed_work),
      accepted_count: asNumber(row.accepted_count),
      ...(row.started_at ? { started_at: toIso(row.started_at) } : {}),
      ...(row.finished_at ? { finished_at: toIso(row.finished_at) } : {}),
      ...(row.last_error ? { last_error: row.last_error } : {}),
      created_at: toIso(row.created_at),
      updated_at: toIso(row.updated_at),
    };
  }

  private toSyncWork(row: SyncWorkRow): SyncWorkRecord {
    return {
      id: row.id,
      ...(row.run_id ? { run_id: row.run_id } : {}),
      installation_id: row.installation_id,
      stream_key: row.stream_key,
      lane: row.lane,
      priority: asNumber(row.priority),
      next_due_at: toIso(row.next_due_at),
      status: row.status,
      attempts: asNumber(row.attempts),
      generation: asNumber(row.generation),
      ...(row.lease_owner ? { lease_owner: row.lease_owner } : {}),
      ...(row.lease_expires_at
        ? { lease_expires_at: toIso(row.lease_expires_at) }
        : {}),
      ...(row.last_error ? { last_error: row.last_error } : {}),
      created_at: toIso(row.created_at),
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
      direction_tags: input.direction_tags ? [...input.direction_tags] : undefined,
      weight_hints: input.weight_hints ? structuredClone(input.weight_hints) : undefined,
      attrs: input.attrs ? structuredClone(input.attrs) : undefined,
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
          actor_id, required_scope_ids, direction_tags, weight_hints, attrs
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
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
        jsonb(event.direction_tags),
        jsonb(event.weight_hints),
        jsonb(event.attrs),
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
        direction_tags: row.direction_tags,
        weight_hints: row.weight_hints,
        attrs: row.attrs,
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
      direction_tags: row.direction_tags
        ? asJson<string[]>(row.direction_tags)
        : undefined,
      weight_hints: row.weight_hints
        ? asJson<NewEvent["weight_hints"]>(row.weight_hints)
        : undefined,
      attrs: row.attrs ? asJson<NewEvent["attrs"]>(row.attrs) : undefined,
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

function toDailyDigestJob(row: DailyDigestJobRow): DailyDigestJob {
  return {
    id: row.id,
    org_id: row.org_id,
    utc_date: row.utc_date,
    generation: row.generation,
    status: row.status,
    attempts: asNumber(row.attempts),
    ...(row.lease_owner ? { lease_owner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { lease_expires_at: toIso(row.lease_expires_at) } : {}),
    ...(row.next_retry_at ? { next_retry_at: toIso(row.next_retry_at) } : {}),
    ...(row.last_error ? { last_error: row.last_error } : {}),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function assertDailyDigestEnqueue(input: {
  org_id: string;
  utc_date: string;
  generation: string;
  created_at: string;
}): void {
  if (
    !input.org_id?.trim()
    || !/^\d{4}-\d{2}-\d{2}$/.test(input.utc_date)
    || !input.generation?.trim()
    || Number.isNaN(Date.parse(input.created_at))
  ) {
    throw new Error("Invalid daily digest job");
  }
}

function assertDailyDigestCatchUp(input: {
  org_id: string;
  through_utc_date: string;
  generation: string;
  created_at: string;
  max_days: number;
}): void {
  assertDailyDigestEnqueue({
    org_id: input.org_id,
    utc_date: input.through_utc_date,
    generation: input.generation,
    created_at: input.created_at,
  });
  if (!Number.isSafeInteger(input.max_days) || input.max_days < 1 || input.max_days > 31) {
    throw new Error("Invalid daily digest catch-up limit");
  }
}

function catchUpDates(lastScheduled: string | undefined, throughDate: string, maxDays: number): string[] {
  const start = lastScheduled
    ? new Date(`${lastScheduled}T00:00:00.000Z`).getTime() + 86_400_000
    : new Date(`${throughDate}T00:00:00.000Z`).getTime();
  const end = new Date(`${throughDate}T00:00:00.000Z`).getTime();
  const dates: string[] = [];
  for (let timestamp = start; timestamp <= end && dates.length < maxDays; timestamp += 86_400_000) {
    dates.push(new Date(timestamp).toISOString().slice(0, 10));
  }
  return dates;
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

interface ProposalRow {
  status: ProposalStatus;
  payload_json: unknown;
  updated_at: unknown;
  outcome_kind: "standard_version" | "decision" | "claim" | "none" | null;
  outcome_ref_id: string | null;
}

interface HandoffRow {
  status: HandoffStatus;
  payload_json: unknown;
  resolved_at: unknown;
}

interface StandardRow {
  payload_json: unknown;
  current_version_id: string | null;
  citation_count: number;
}

interface StandardVersionRow {
  status: StandardVersionRecord["status"];
  payload_json: unknown;
  state_json: unknown;
}

interface StandardGapRow {
  status: StandardGapStatus;
  payload_json: unknown;
  converted_proposal_id: string | null;
  updated_at: unknown;
}

interface AgentRunRow {
  status: AgentRunStatus;
  payload_json: unknown;
  state_json: unknown;
}

function toAgentRun(row: AgentRunRow): AgentRunRecord {
  const run = parseContextJson<AgentRunRecord>(row.payload_json);
  const state = parseContextJson<AgentRunState>(row.state_json);
  return validateAgentRun({
    ...run,
    status: row.status,
    ...(state.output ? { output: state.output } : {}),
    ...(state.handoff_id ? { handoff_id: state.handoff_id } : {}),
    ...(state.started_at ? { started_at: state.started_at } : {}),
    ...(state.finished_at ? { finished_at: state.finished_at } : {}),
  });
}

function toStandardGap(row: StandardGapRow): StandardGapRecord {
  return validateStandardGap({
    ...parseContextJson<StandardGapRecord>(row.payload_json),
    status: row.status,
    updated_at: toIso(row.updated_at),
    ...(row.converted_proposal_id ? { converted_proposal_id: row.converted_proposal_id } : {}),
  });
}

function toStandard(row: StandardRow): StandardRecord {
  return validateStandard({
    ...parseContextJson<StandardRecord>(row.payload_json),
    ...(row.current_version_id ? { current_version_id: row.current_version_id } : {}),
    citation_count: Number(row.citation_count),
  });
}

function standardVersionState(version: StandardVersionRecord): StandardVersionState {
  return {
    status: version.status,
    ...(version.gate?.upgrade_evidence ? { upgrade_evidence: version.gate.upgrade_evidence } : {}),
    ...(version.published_at ? { published_at: version.published_at } : {}),
    ...(version.published_by ? { published_by: version.published_by } : {}),
    ...(version.deprecated_at ? { deprecated_at: version.deprecated_at } : {}),
    ...(version.deprecated_by ? { deprecated_by: version.deprecated_by } : {}),
    ...(version.deprecation_evidence ? { deprecation_evidence: version.deprecation_evidence } : {}),
    ...(version.superseded_by_version_id ? { superseded_by_version_id: version.superseded_by_version_id } : {}),
  };
}

function toStandardVersion(row: StandardVersionRow): StandardVersionRecord {
  const version = parseContextJson<StandardVersionRecord>(row.payload_json);
  const state = parseContextJson<StandardVersionState>(row.state_json);
  return validateStandardVersion({
    ...version,
    status: row.status,
    ...(version.gate && state.upgrade_evidence
      ? { gate: { ...version.gate, upgrade_evidence: state.upgrade_evidence } }
      : {}),
    ...(state.published_at ? { published_at: state.published_at } : {}),
    ...(state.published_by ? { published_by: state.published_by } : {}),
    ...(state.deprecated_at ? { deprecated_at: state.deprecated_at } : {}),
    ...(state.deprecated_by ? { deprecated_by: state.deprecated_by } : {}),
    ...(state.deprecation_evidence ? { deprecation_evidence: state.deprecation_evidence } : {}),
    ...(state.superseded_by_version_id ? { superseded_by_version_id: state.superseded_by_version_id } : {}),
  });
}

function toHandoff(row: HandoffRow): HandoffRecord {
  const resolvedAt = toIsoOrNull(row.resolved_at);
  return validateHandoff({
    ...parseContextJson<HandoffRecord>(row.payload_json),
    status: row.status,
    ...(resolvedAt ? { resolved_at: resolvedAt } : {}),
  });
}

function toProposal(row: ProposalRow): ProposalRecord {
  const proposal = validateProposal({
    ...parseContextJson<ProposalRecord>(row.payload_json),
    status: row.status,
    updated_at: toIso(row.updated_at),
  });
  return {
    ...proposal,
    ...(row.outcome_kind
      ? { outcome_ref: { outcome_kind: row.outcome_kind, ...(row.outcome_ref_id ? { ref_id: row.outcome_ref_id } : {}) } }
      : {}),
  };
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

function unassignedSyncWorkWhere(
  query: UnassignedSyncWorkQuery,
): { sql: string; params: unknown[] } {
  const clauses = ["run_id IS NULL", "status IN ('pending', 'running')"];
  const params: unknown[] = [];
  if (query.installation_id) {
    params.push(query.installation_id);
    clauses.push(`installation_id = $${params.length}`);
  }
  if (query.lanes?.length) {
    const slots = query.lanes.map((lane) => {
      params.push(lane);
      return `$${params.length}`;
    });
    clauses.push(`lane IN (${slots.join(", ")})`);
  }
  return { sql: clauses.join(" AND "), params };
}

function uniqueStreamKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
}
