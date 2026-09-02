import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
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
  ContextArtifactQuery,
  ContextArtifactStore,
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
  RepointContentInput,
  ResetConnectorCursor,
  ReleaseConnectorLease,
  SetConnectorInstallationConfig,
  SetConnectorInstallationStatus,
  SettleIngestAttempt,
  SourceIdentity,
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
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from "./migrations";

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
  required_scope_ids_json: string | null;
  occurred_at: string;
  ingested_at: string;
}

interface ContextEventRow extends EventRow {
  content_media_type: string | null;
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

interface StreamMemberRow {
  installation_id: string;
  stream_key: string;
  thread_id: string | null;
  label: string | null;
  kind: string | null;
  generation: number;
  discovered_at: string;
  last_seen_at: string;
}

interface CatalogCursorRow {
  installation_id: string;
  cursor_value: string | null;
  complete: number;
  generation: number;
  updated_at: string;
}

interface SyncStateRow {
  installation_id: string;
  stream_key: string;
  phase: SyncPhase;
  live_cursor: string | null;
  history_cursor: string | null;
  media_pending: number;
  idle_until: string | null;
  generation: number;
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

interface ContextProjectionJobRow {
  id: string;
  org_id: string;
  event_id: string;
  status: ContextProjectionJob["status"];
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface PrefRow {
  org_id: string;
  thread_id: string;
  title: string | null;
  pinned: number;
  hidden: number;
  hidden_reason: string | null;
  last_read_at: string | null;
  last_read_external_id: string | null;
  updated_at: string;
}

const PREF_COLUMNS = `
  org_id, thread_id, title, pinned, hidden, hidden_reason,
  last_read_at, last_read_external_id, updated_at
`;

const INBOX_COLUMNS = `
  d.event_id, d.org_id AS disposition_org_id, d.disposition, d.layer,
  d.reason_codes_json, d.score, d.decided_at,
  e.id, e.source, e.external_id, e.operation, e.content_hash,
  e.parent_event_id, e.thread_id, e.actor_id, e.required_scope_ids_json,
  e.occurred_at, e.ingested_at
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

export interface SqliteOpenOptions {
  readonly?: boolean;
}

export class SqliteAuthorityStore
  implements
    AuthorityStore,
    ConnectorRuntimeStore,
    WorkStore,
    ExecutorStore,
    ContextArtifactStore,
    ContextAuthorityReader,
    ContextProjectionOutboxStore
{
  private readonly database: Database.Database;
  readonly readonly: boolean;

  constructor(path: string, options: SqliteOpenOptions = {}) {
    this.readonly = options.readonly === true;
    mkdirSync(dirname(path), { recursive: true });
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
               parent_event_id, thread_id, actor_id, required_scope_ids_json,
               occurred_at, ingested_at
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
    const limit =
      typeof query?.limit === "number" &&
      Number.isInteger(query.limit) &&
      query.limit > 0
        ? query.limit
        : undefined;
    const rows = this.database
      .prepare(
        `
          SELECT id, org_id, source, external_id, operation, content_hash,
               parent_event_id, thread_id, actor_id, required_scope_ids_json,
               occurred_at, ingested_at
          FROM events WHERE ${clauses.join(" AND ")} ORDER BY sequence ASC
          ${limit === undefined ? "" : "LIMIT ?"}
        `,
      )
      .all(...(limit === undefined ? params : [...params, limit])) as EventRow[];
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
    const read = this.database.transaction(() => {
      const rows = this.database
        .prepare(
          threadId
            ? `
                 SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
                   e.content_hash, e.parent_event_id, e.thread_id, e.actor_id,
                   e.required_scope_ids_json, e.occurred_at, e.ingested_at,
                   b.media_type AS content_media_type
                 FROM events e
                 LEFT JOIN blobs b ON b.content_hash = e.content_hash
                 WHERE e.org_id = ? AND e.thread_id = ?
                 ORDER BY e.sequence ASC
          `
            : `
                 SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
                   e.content_hash, e.parent_event_id, e.thread_id, e.actor_id,
                   e.required_scope_ids_json, e.occurred_at, e.ingested_at,
                   b.media_type AS content_media_type
                 FROM events e
                 LEFT JOIN blobs b ON b.content_hash = e.content_hash
                 WHERE e.org_id = ?
                 ORDER BY e.sequence ASC
          `,
        )
        .all(...(threadId ? [orgId, threadId] : [orgId])) as ContextEventRow[];
      const lifecycleHeads = threadId
        ? (this.database
            .prepare(
              `
            SELECT sh.source, sh.external_id, sh.current_event_id AS head_event_id
            FROM source_heads sh
            WHERE sh.org_id = ?
              AND EXISTS (
                SELECT 1
                FROM events e
                WHERE e.org_id = sh.org_id
                  AND e.source = sh.source
                  AND e.external_id = sh.external_id
                  AND e.thread_id = ?
              )
            ORDER BY sh.source ASC, sh.external_id ASC
          `,
            )
            .all(orgId, threadId) as ContextAuthorityRead["lifecycle_heads"])
        : (this.database
            .prepare(
              `
            SELECT source, external_id, current_event_id AS head_event_id
            FROM source_heads
            WHERE org_id = ?
            ORDER BY source ASC, external_id ASC
          `,
            )
            .all(orgId) as ContextAuthorityRead["lifecycle_heads"]);
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
    });
    return read.deferred();
  }

  async putArtifact(artifact: ContextArtifact): Promise<ContextArtifact> {
    requireContextValue(validateContextArtifact(artifact), "artifact");
    this.assertWritable();
    const payload = canonicalContextJson(artifact);
    this.putImmutableContextJson(
      "context_artifacts",
      "org_id = ? AND id = ?",
      [artifact.org_id, artifact.id],
      payload,
      "artifact",
      `
        INSERT INTO context_artifacts (
          org_id, id, kind, status, generation, recorded_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
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
    return parseContextJson<ContextArtifact>(payload);
  }

  async getArtifact(orgId: string, id: string): Promise<ContextArtifact | null> {
    return this.getContextJson<ContextArtifact>(
      "context_artifacts",
      "org_id = ? AND id = ?",
      [orgId, id],
    );
  }

  async listArtifacts(query: ContextArtifactQuery): Promise<ContextArtifact[]> {
    const validation = validateContextArtifactQuery(query);
    requireContextValue(validation, "artifact query");
    const stableQuery = validation.success ? validation.data : query;
    const clauses = ["org_id = ?"];
    const params: unknown[] = [stableQuery.org_id];
    if (stableQuery.kinds) {
      if (stableQuery.kinds.length === 0) {
        return [];
      }
      clauses.push(`kind IN (${stableQuery.kinds.map(() => "?").join(", ")})`);
      params.push(...stableQuery.kinds);
    }
    if (stableQuery.statuses) {
      if (stableQuery.statuses.length === 0) {
        return [];
      }
      clauses.push(`status IN (${stableQuery.statuses.map(() => "?").join(", ")})`);
      params.push(...stableQuery.statuses);
    }
    if (stableQuery.generation) {
      clauses.push("generation = ?");
      params.push(stableQuery.generation);
    }
    const rows = this.database
      .prepare(
        `
          SELECT payload_json FROM context_artifacts
          WHERE ${clauses.join(" AND ")}
        `,
      )
      .all(...params) as Array<{ payload_json: string }>;
    return rows
      .map((row) => parseContextJson<ContextArtifact>(row.payload_json))
      .sort((left, right) => compareContextArtifactOrder(left, right))
      .slice(0, stableQuery.limit ?? Number.POSITIVE_INFINITY);
  }

  async putSnapshot(snapshot: ContextSnapshot): Promise<void> {
    requireContextValue(validateContextSnapshot(snapshot), "snapshot");
    this.assertWritable();
    const payload = canonicalContextJson(snapshot);
    this.putImmutableContextJson(
      "context_snapshots",
      "org_id = ? AND id = ?",
      [snapshot.org_id, snapshot.id],
      payload,
      "snapshot",
      "INSERT INTO context_snapshots (org_id, id, payload_json) VALUES (?, ?, ?)",
      [snapshot.org_id, snapshot.id, payload],
    );
  }

  async getSnapshot(orgId: string, id: string): Promise<ContextSnapshot | null> {
    return this.getContextJson<ContextSnapshot>(
      "context_snapshots",
      "org_id = ? AND id = ?",
      [orgId, id],
    );
  }

  async putBundle(bundle: ContextBundle): Promise<void> {
    requireContextValue(validateContextBundle(bundle), "bundle");
    this.assertWritable();
    const payload = canonicalContextJson(bundle);
    const lookup = [
      bundle.org_id,
      bundle.snapshot_id,
      bundle.principal.actor_type,
      bundle.principal.actor_id,
      bundle.consumer_id,
    ];
    this.putImmutableContextJson(
      "context_bundles",
      `
        org_id = ? AND snapshot_id = ? AND principal_actor_type = ?
        AND principal_actor_id = ? AND consumer_id = ?
      `,
      lookup,
      payload,
      "bundle",
      `
        INSERT INTO context_bundles (
          org_id, snapshot_id, principal_actor_type, principal_actor_id,
          consumer_id, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [...lookup, payload],
    );
  }

  async getBundle(query: ContextBundleLookup): Promise<ContextBundle | null> {
    return this.getContextJson<ContextBundle>(
      "context_bundles",
      `
        org_id = ? AND snapshot_id = ? AND principal_actor_type = ?
        AND principal_actor_id = ? AND consumer_id = ?
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
    this.assertWritable();
    const transaction = this.database.transaction(() => {
      const current = this.database
        .prepare(
          `
            SELECT payload_json FROM context_projection_checkpoints
            WHERE org_id = ? AND projector_id = ? AND generation = ?
          `,
        )
        .get(
          stableCheckpoint.org_id,
          stableCheckpoint.projector_id,
          stableCheckpoint.generation,
        ) as { payload_json: string } | undefined;
      if (current) {
        const stored = parseContextJson<ContextProjectionCheckpoint>(current.payload_json);
        if (stored.algorithm_version !== stableCheckpoint.algorithm_version) {
          throw new Error("Projection checkpoint algorithm cannot change within a generation");
        }
        if (stored.sequence > stableCheckpoint.sequence) {
          throw new Error("Projection checkpoint cannot move backwards");
        }
        if (stored.sequence === stableCheckpoint.sequence) {
          if (current.payload_json !== canonicalContextJson(stableCheckpoint)) {
            throw new Error("Projection checkpoint cannot change at the same sequence");
          }
          return;
        }
      }
      const payload = canonicalContextJson(stableCheckpoint);
      this.database
        .prepare(
          `
            INSERT INTO context_projection_checkpoints (
              org_id, projector_id, generation, algorithm_version,
              sequence, watermark, updated_at, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(org_id, projector_id, generation) DO UPDATE SET
              algorithm_version = excluded.algorithm_version,
              sequence = excluded.sequence,
              watermark = excluded.watermark,
              updated_at = excluded.updated_at,
              payload_json = excluded.payload_json
          `,
        )
        .run(
          stableCheckpoint.org_id,
          stableCheckpoint.projector_id,
          stableCheckpoint.generation,
          stableCheckpoint.algorithm_version,
          stableCheckpoint.sequence,
          stableCheckpoint.watermark,
          stableCheckpoint.updated_at,
          payload,
        );
    });
    transaction.immediate();
  }

  async getCheckpoint(
    orgId: string,
    projectorId: string,
    generation: string,
  ): Promise<ContextProjectionCheckpoint | null> {
    return this.getContextJson<ContextProjectionCheckpoint>(
      "context_projection_checkpoints",
      "org_id = ? AND projector_id = ? AND generation = ?",
      [orgId, projectorId, generation],
    );
  }

  async claimContextProjectionJobs(
    input: ClaimContextProjectionJobs,
  ): Promise<ContextProjectionJob[]> {
    this.assertWritable();
    assertProjectionClaim(input);
    return this.database.transaction(() => {
      const rows = this.database.prepare(
        `
          SELECT id FROM context_projection_outbox
          WHERE status = 'pending'
             OR (status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= ?))
             OR (status = 'running' AND lease_expires_at <= ?)
          ORDER BY created_at, id
          LIMIT ?
        `,
      ).all(input.now, input.now, input.limit) as Array<{ id: string }>;
      const leaseExpiresAt = new Date(Date.parse(input.now) + input.lease_ms).toISOString();
      for (const row of rows) {
        this.database.prepare(
          `
            UPDATE context_projection_outbox
            SET status = 'running', attempts = attempts + 1,
                lease_owner = ?, lease_expires_at = ?, next_retry_at = NULL,
                last_error = NULL, updated_at = ?
            WHERE id = ?
          `,
        ).run(input.owner, leaseExpiresAt, input.now, row.id);
      }
      return rows.map((row) => this.getContextProjectionJob(row.id)!);
    }).immediate();
  }

  async completeContextProjectionJob(
    input: CompleteContextProjectionJob,
  ): Promise<boolean> {
    this.assertWritable();
    assertProjectionSettle(input.id, input.owner, input.completed_at);
    return this.database.prepare(
      `
        UPDATE context_projection_outbox
        SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
            next_retry_at = NULL, last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
      `,
    ).run(input.completed_at, input.id, input.owner).changes === 1;
  }

  async failContextProjectionJob(input: FailContextProjectionJob): Promise<boolean> {
    this.assertWritable();
    assertProjectionSettle(input.id, input.owner, input.failed_at);
    if (Number.isNaN(Date.parse(input.next_retry_at)) || !input.error_code.trim()) {
      throw new Error("Invalid Context projection failure");
    }
    return this.database.prepare(
      `
        UPDATE context_projection_outbox
        SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
            next_retry_at = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
      `,
    ).run(input.next_retry_at, input.error_code.slice(0, 120), input.failed_at, input.id, input.owner).changes === 1;
  }

  async listContextProjectionJobs(orgId: string): Promise<ContextProjectionJob[]> {
    return (this.database.prepare(
      `
        SELECT id, org_id, event_id, status, attempts, lease_owner,
               lease_expires_at, next_retry_at, last_error, created_at, updated_at
        FROM context_projection_outbox WHERE org_id = ? ORDER BY created_at, id
      `,
    ).all(orgId) as ContextProjectionJobRow[]).map(toContextProjectionJob);
  }

  private getContextProjectionJob(id: string): ContextProjectionJob | null {
    const row = this.database.prepare(
      `
        SELECT id, org_id, event_id, status, attempts, lease_owner,
               lease_expires_at, next_retry_at, last_error, created_at, updated_at
        FROM context_projection_outbox WHERE id = ?
      `,
    ).get(id) as ContextProjectionJobRow | undefined;
    return row ? toContextProjectionJob(row) : null;
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
            AND ${notHiddenSql("e")}
          ORDER BY e.ingested_at DESC, e.id DESC
          LIMIT 1
        `,
      )
      .get(orgId, orgId) as { latest_at: string; latest_id: string } | undefined;
    const counted = this.database
      .prepare(
        `
          SELECT COUNT(*) AS count FROM (
            SELECT e.thread_id AS thread_id
            FROM events e
            JOIN message_dispositions d ON d.event_id = e.id
            WHERE e.org_id = ?
              AND ${isCurrentHeadSql("e")}
              AND ${notHiddenSql("e")}
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
      .get(orgId, orgId) as { count: number };
    const prefs = this.database
      .prepare(
        `
          SELECT COUNT(*) AS pref_count,
                 COALESCE(MAX(updated_at), '') AS pref_updated_at
          FROM conversation_prefs WHERE org_id = ?
        `,
      )
      .get(orgId) as { pref_count: number; pref_updated_at: string };
    const work = this.database
      .prepare(
        `
          SELECT COALESCE(MAX(updated_at), '') AS work_updated_at FROM (
            SELECT updated_at FROM work_items WHERE org_id = ?
            UNION ALL
            SELECT updated_at FROM work_deliveries WHERE org_id = ?
          )
        `,
      )
      .get(orgId, orgId) as { work_updated_at: string };
    return {
      count: counted.count,
      digest: formatInboxDigest({
        count: counted.count,
        latest_at: latest?.latest_at ?? "",
        latest_id: latest?.latest_id ?? "",
        pref_count: prefs.pref_count,
        pref_updated_at: prefs.pref_updated_at,
        work_updated_at: work.work_updated_at,
      }),
    };
  }

  async listConversationPrefs(orgId: string): Promise<ConversationPref[]> {
    const rows = this.database
      .prepare(
        `
          SELECT ${PREF_COLUMNS}
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
          SELECT ${PREF_COLUMNS}
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
            SELECT ${PREF_COLUMNS}
            FROM conversation_prefs WHERE org_id = ? AND thread_id = ?
          `,
        )
        .get(input.org_id, input.thread_id) as PrefRow | undefined;
      const hidden =
        input.hidden !== undefined ? input.hidden : Boolean(current?.hidden);
      const next: ConversationPref = {
        org_id: input.org_id,
        thread_id: input.thread_id,
        title: input.title !== undefined ? input.title : (current?.title ?? null),
        pinned:
          input.pinned !== undefined
            ? input.pinned
            : Boolean(current?.pinned),
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
            : (current?.last_read_at ?? null),
        last_read_external_id:
          input.last_read_external_id !== undefined
            ? input.last_read_external_id
            : (current?.last_read_external_id ?? null),
        updated_at: input.updated_at,
      };
      this.database
        .prepare(
          `
            INSERT INTO conversation_prefs (
              org_id, thread_id, title, pinned, hidden, hidden_reason,
              last_read_at, last_read_external_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(org_id, thread_id) DO UPDATE SET
              title = excluded.title,
              pinned = excluded.pinned,
              hidden = excluded.hidden,
              hidden_reason = excluded.hidden_reason,
              last_read_at = excluded.last_read_at,
              last_read_external_id = excluded.last_read_external_id,
              updated_at = excluded.updated_at
          `,
        )
        .run(
          next.org_id,
          next.thread_id,
          next.title,
          next.pinned ? 1 : 0,
          next.hidden ? 1 : 0,
          next.hidden_reason,
          next.last_read_at,
          next.last_read_external_id,
          next.updated_at,
        );
      return next;
    });
    return transaction.immediate();
  }

  async summarizeStore(orgId: string): Promise<StoreFootprint> {
    return this.storeFootprint(orgId);
  }

  async clearOperationalData(
    orgId: string,
    now: string,
  ): Promise<StoreClearResult> {
    this.assertWritable();
    const transaction = this.database.transaction(() => {
      this.database.pragma("defer_foreign_keys = ON");
      const before = this.storeFootprint(orgId);
      this.database.prepare(`DELETE FROM work_deliveries WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM work_runs WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM work_items WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM context_bundles WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM context_snapshots WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM context_artifacts WHERE org_id = ?`).run(orgId);
      this.database
        .prepare(`DELETE FROM context_projection_checkpoints WHERE org_id = ?`)
        .run(orgId);
      this.database
        .prepare(`DELETE FROM context_projection_outbox WHERE org_id = ?`)
        .run(orgId);
      this.database
        .prepare(`DELETE FROM message_dispositions WHERE org_id = ?`)
        .run(orgId);
      this.database
        .prepare(`DELETE FROM conversation_prefs WHERE org_id = ?`)
        .run(orgId);
      this.database
        .prepare(
          `
            DELETE FROM ingest_quarantines
            WHERE attempt_id IN (
              SELECT id FROM ingest_attempts WHERE org_id = ?
            )
          `,
        )
        .run(orgId);
      this.database
        .prepare(`DELETE FROM ingest_attempts WHERE org_id = ?`)
        .run(orgId);
      this.database.prepare(`DELETE FROM source_heads WHERE org_id = ?`).run(orgId);
      this.database.prepare(`DELETE FROM events WHERE org_id = ?`).run(orgId);
      this.database
        .prepare(
          `
            DELETE FROM blobs
            WHERE content_hash NOT IN (
              SELECT content_hash FROM events WHERE content_hash IS NOT NULL
            )
          `,
        )
        .run();
      this.database
        .prepare(
          `
            UPDATE connector_cursors
            SET cursor_value = NULL,
                cursor_version = cursor_version + 1,
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = ?
            WHERE installation_id IN (
              SELECT id FROM connector_installations WHERE org_id = ?
            )
          `,
        )
        .run(now, orgId);
      this.database
        .prepare(
          `
            DELETE FROM connector_sync_state
            WHERE installation_id IN (
              SELECT id FROM connector_installations WHERE org_id = ?
            )
          `,
        )
        .run(orgId);
      this.database
        .prepare(
          `
            DELETE FROM connector_stream_members
            WHERE installation_id IN (
              SELECT id FROM connector_installations WHERE org_id = ?
            )
          `,
        )
        .run(orgId);
      this.database
        .prepare(
          `
            DELETE FROM connector_catalog_cursors
            WHERE installation_id IN (
              SELECT id FROM connector_installations WHERE org_id = ?
            )
          `,
        )
        .run(orgId);
      const after = this.storeFootprint(orgId);
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
    return transaction.immediate();
  }

  private storeFootprint(orgId: string): StoreFootprint {
    const count = (sql: string, ...params: unknown[]): number =>
      (this.database.prepare(sql).get(...params) as { n: number }).n;
    return {
      events: count(`SELECT COUNT(*) AS n FROM events WHERE org_id = ?`, orgId),
      conversations: count(
        `
          SELECT COUNT(DISTINCT thread_id) AS n
          FROM events
          WHERE org_id = ? AND thread_id IS NOT NULL AND thread_id != ''
        `,
        orgId,
      ),
      work_items: count(
        `SELECT COUNT(*) AS n FROM work_items WHERE org_id = ?`,
        orgId,
      ),
      blobs: count(
        `
          SELECT COUNT(DISTINCT content_hash) AS n
          FROM events
          WHERE org_id = ? AND content_hash IS NOT NULL
        `,
        orgId,
      ),
      context_artifacts: count(
        `SELECT COUNT(*) AS n FROM context_artifacts WHERE org_id = ?`,
        orgId,
      ),
      context_snapshots: count(
        `SELECT COUNT(*) AS n FROM context_snapshots WHERE org_id = ?`,
        orgId,
      ),
      context_bundles: count(
        `SELECT COUNT(*) AS n FROM context_bundles WHERE org_id = ?`,
        orgId,
      ),
      context_checkpoints: count(
        `SELECT COUNT(*) AS n FROM context_projection_checkpoints WHERE org_id = ?`,
        orgId,
      ),
      recipes: count(`SELECT COUNT(*) AS n FROM recipes WHERE org_id = ?`, orgId),
      connectors: count(
        `SELECT COUNT(*) AS n FROM connector_installations WHERE org_id = ?`,
        orgId,
      ),
      executors: count(
        `SELECT COUNT(*) AS n FROM executor_installations WHERE org_id = ?`,
        orgId,
      ),
    };
  }

  async listRecipes(orgId: string): Promise<Recipe[]> {
    const rows = this.database
      .prepare(
        `SELECT * FROM recipes WHERE org_id = ? ORDER BY updated_at DESC, id`,
      )
      .all(orgId) as RecipeRow[];
    return rows.map(toRecipe);
  }

  async getRecipe(orgId: string, id: string): Promise<Recipe | null> {
    const row = this.database
      .prepare(`SELECT * FROM recipes WHERE org_id = ? AND id = ?`)
      .get(orgId, id) as RecipeRow | undefined;
    return row ? toRecipe(row) : null;
  }

  async putRecipe(recipe: Recipe): Promise<Recipe> {
    this.assertWritable();
    const trigger = recipeTriggerOf(recipe);
    this.database
      .prepare(
        `
          INSERT INTO recipes (
            id, org_id, name, match_json, executor_type, executor_config_json,
            can_write_back, include_context, enabled, trigger_kind,
            trigger_interval_ms, trigger_coalesce, next_run_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            match_json = excluded.match_json,
            executor_type = excluded.executor_type,
            executor_config_json = excluded.executor_config_json,
            can_write_back = excluded.can_write_back,
            include_context = excluded.include_context,
            enabled = excluded.enabled,
            trigger_kind = excluded.trigger_kind,
            trigger_interval_ms = excluded.trigger_interval_ms,
            trigger_coalesce = excluded.trigger_coalesce,
            next_run_at = excluded.next_run_at,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        recipe.id,
        recipe.org_id,
        recipe.name,
        JSON.stringify(recipe.match),
        recipe.executor_type,
        JSON.stringify(recipe.executor_config),
        recipe.can_write_back ? 1 : 0,
        recipe.include_context ? 1 : 0,
        recipe.enabled ? 1 : 0,
        trigger.kind,
        trigger.kind === "pull" ? (trigger.interval_ms ?? null) : null,
        trigger.kind === "push" && trigger.coalesce !== false ? 1 : 0,
        recipe.next_run_at ?? null,
        recipe.created_at,
        recipe.updated_at,
      );
    return recipe;
  }

  async deleteRecipe(orgId: string, id: string): Promise<boolean> {
    this.assertWritable();
    const result = this.database
      .prepare(`DELETE FROM recipes WHERE org_id = ? AND id = ?`)
      .run(orgId, id);
    return result.changes > 0;
  }

  async listWorkItems(orgId: string): Promise<WorkItem[]> {
    const rows = this.database
      .prepare(
        `SELECT * FROM work_items WHERE org_id = ? ORDER BY updated_at DESC, id`,
      )
      .all(orgId) as WorkItemRow[];
    return rows.map(toWorkItem);
  }

  async getWorkItem(orgId: string, id: string): Promise<WorkItem | null> {
    const row = this.database
      .prepare(`SELECT * FROM work_items WHERE org_id = ? AND id = ?`)
      .get(orgId, id) as WorkItemRow | undefined;
    return row ? toWorkItem(row) : null;
  }

  async getWorkItemByThread(
    orgId: string,
    threadId: string,
  ): Promise<WorkItem | null> {
    const row = this.database
      .prepare(
        `SELECT * FROM work_items WHERE org_id = ? AND thread_id = ?
         ORDER BY CASE WHEN status IN ('open', 'running', 'waiting_human') THEN 0 ELSE 1 END,
                  created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(orgId, threadId) as WorkItemRow | undefined;
    return row ? toWorkItem(row) : null;
  }

  async putWorkItem(item: WorkItem): Promise<WorkItem> {
    this.assertWritable();
    this.database
      .prepare(
        `
          INSERT INTO work_items (
            id, org_id, thread_id, unit_key, head_event_id, record_class, thread_facet,
            status, recipe_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            thread_id = excluded.thread_id,
            unit_key = excluded.unit_key,
            head_event_id = excluded.head_event_id,
            record_class = excluded.record_class,
            thread_facet = excluded.thread_facet,
            status = excluded.status,
            recipe_id = excluded.recipe_id,
            updated_at = excluded.updated_at
        `,
      )
      .run(
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
      );
    return item;
  }

  async listWorkRuns(orgId: string, workItemId?: string): Promise<WorkRun[]> {
    const rows = workItemId
      ? (this.database
          .prepare(
            `SELECT * FROM work_runs WHERE org_id = ? AND work_item_id = ?
             ORDER BY updated_at DESC, id`,
          )
          .all(orgId, workItemId) as WorkRunRow[])
      : (this.database
          .prepare(
            `SELECT * FROM work_runs WHERE org_id = ? ORDER BY updated_at DESC, id`,
          )
          .all(orgId) as WorkRunRow[]);
    return rows.map(toWorkRun);
  }

  async getWorkRun(orgId: string, id: string): Promise<WorkRun | null> {
    const row = this.database
      .prepare(`SELECT * FROM work_runs WHERE org_id = ? AND id = ?`)
      .get(orgId, id) as WorkRunRow | undefined;
    return row ? toWorkRun(row) : null;
  }

  async getActiveWorkRun(
    orgId: string,
    workItemId: string,
  ): Promise<WorkRun | null> {
    const row = this.database
      .prepare(
        `SELECT * FROM work_runs
         WHERE org_id = ? AND work_item_id = ?
           AND status IN ('running', 'waiting_human')
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
      )
      .get(orgId, workItemId) as WorkRunRow | undefined;
    return row ? toWorkRun(row) : null;
  }

  async putWorkRun(run: WorkRun): Promise<WorkRun> {
    this.assertWritable();
    this.database
      .prepare(
        `
          INSERT INTO work_runs (
            id, org_id, work_item_id, recipe_id, executor_type, external_run_id,
            agent_thread_id, status, result_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            recipe_id = excluded.recipe_id,
            executor_type = excluded.executor_type,
            external_run_id = excluded.external_run_id,
            agent_thread_id = excluded.agent_thread_id,
            status = excluded.status,
            result_json = excluded.result_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        run.id,
        run.org_id,
        run.work_item_id,
        run.recipe_id,
        run.executor_type,
        run.external_run_id ?? null,
        run.agent_thread_id ?? null,
        run.status,
        run.result ? JSON.stringify(run.result) : null,
        run.created_at,
        run.updated_at,
      );
    return run;
  }

  async listWorkDeliveries(orgId: string): Promise<WorkDelivery[]> {
    const rows = this.database
      .prepare(
        `SELECT * FROM work_deliveries WHERE org_id = ? ORDER BY updated_at DESC, id`,
      )
      .all(orgId) as WorkDeliveryRow[];
    return rows.map(toWorkDelivery);
  }

  async getWorkDelivery(orgId: string, id: string): Promise<WorkDelivery | null> {
    const row = this.database
      .prepare(`SELECT * FROM work_deliveries WHERE org_id = ? AND id = ?`)
      .get(orgId, id) as WorkDeliveryRow | undefined;
    return row ? toWorkDelivery(row) : null;
  }

  async getWorkDeliveryByItem(
    orgId: string,
    workItemId: string,
  ): Promise<WorkDelivery | null> {
    const row = this.database
      .prepare(
        `SELECT * FROM work_deliveries WHERE org_id = ? AND work_item_id = ?`,
      )
      .get(orgId, workItemId) as WorkDeliveryRow | undefined;
    return row ? toWorkDelivery(row) : null;
  }

  async putWorkDelivery(delivery: WorkDelivery): Promise<WorkDelivery> {
    this.assertWritable();
    this.database
      .prepare(
        `
          INSERT INTO work_deliveries (
            id, org_id, work_item_id, recipe_id, kind, unit_key, event_id,
            status, write_back, attempts, last_error, next_retry_at,
            payload_json, lease_expires_at, idempotency_key, channel_receipt_json,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            recipe_id = excluded.recipe_id,
            kind = excluded.kind,
            unit_key = excluded.unit_key,
            event_id = excluded.event_id,
            status = excluded.status,
            write_back = excluded.write_back,
            attempts = excluded.attempts,
            last_error = excluded.last_error,
            next_retry_at = excluded.next_retry_at,
            payload_json = excluded.payload_json,
            lease_expires_at = excluded.lease_expires_at,
            idempotency_key = excluded.idempotency_key,
            channel_receipt_json = excluded.channel_receipt_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
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
        delivery.payload ? JSON.stringify(delivery.payload) : null,
        delivery.lease_expires_at ?? null,
        delivery.idempotency_key ?? null,
        delivery.channel_receipt ? JSON.stringify(delivery.channel_receipt) : null,
        delivery.created_at,
        delivery.updated_at,
      );
    return delivery;
  }

  async getUiPref(orgId: string, key: string): Promise<string | null> {
    const row = this.database
      .prepare(`SELECT value FROM ui_prefs WHERE org_id = ? AND key = ?`)
      .get(orgId, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async putUiPref(
    orgId: string,
    key: string,
    value: string,
    updatedAt: string,
  ): Promise<void> {
    this.assertWritable();
    this.database
      .prepare(
        `
          INSERT INTO ui_prefs (org_id, key, value, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(org_id, key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        `,
      )
      .run(orgId, key, value, updatedAt);
  }

  async listExecutorInstallations(
    orgId: string,
  ): Promise<ExecutorInstallation[]> {
    const rows = this.database
      .prepare(
        `
          SELECT * FROM executor_installations
          WHERE org_id = ? ORDER BY updated_at DESC, id
        `,
      )
      .all(orgId) as ExecutorRow[];
    return rows.map(toExecutorInstallation);
  }

  async getExecutorInstallation(
    orgId: string,
    id: string,
  ): Promise<ExecutorInstallation | null> {
    const row = this.database
      .prepare(
        `SELECT * FROM executor_installations WHERE org_id = ? AND id = ?`,
      )
      .get(orgId, id) as ExecutorRow | undefined;
    return row ? toExecutorInstallation(row) : null;
  }

  async putExecutorInstallation(
    installation: ExecutorInstallation,
  ): Promise<ExecutorInstallation> {
    this.assertWritable();
    this.database
      .prepare(
        `
          INSERT INTO executor_installations (
            id, org_id, kind, name, status, config_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            name = excluded.name,
            status = excluded.status,
            config_json = excluded.config_json,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        installation.id,
        installation.org_id,
        installation.kind,
        installation.name,
        installation.status,
        JSON.stringify(installation.config),
        installation.created_at,
        installation.updated_at,
      );
    return installation;
  }

  async deleteExecutorInstallation(orgId: string, id: string): Promise<boolean> {
    this.assertWritable();
    const result = this.database
      .prepare(`DELETE FROM executor_installations WHERE org_id = ? AND id = ?`)
      .run(orgId, id);
    return result.changes > 0;
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

  async repointContentHash(input: RepointContentInput): Promise<number> {
    this.assertWritable();
    return this.database.transaction(() => {
      const now = new Date().toISOString();
      this.insertBlobRow(
        input.new_content_hash,
        input.content_media_type,
        input.content_byte_size,
        now,
      );
      for (const blob of input.extra_blobs ?? []) {
        this.insertBlobRow(
          blob.content_hash,
          blob.media_type,
          blob.byte_size,
          now,
        );
      }
      const updated = this.database
        .prepare(`UPDATE events SET content_hash = ? WHERE content_hash = ?`)
        .run(input.new_content_hash, input.old_content_hash);
      if (input.old_content_hash !== input.new_content_hash) {
        this.database
          .prepare(
            `
              DELETE FROM blobs
              WHERE content_hash = ?
                AND content_hash NOT IN (
                  SELECT content_hash FROM events WHERE content_hash IS NOT NULL
                )
            `,
          )
          .run(input.old_content_hash);
      }
      return updated.changes;
    }).immediate();
  }

  async vacuumStore(): Promise<void> {
    this.assertWritable();
    this.database.exec("VACUUM");
  }

  private insertBlobRow(
    contentHash: string,
    mediaType: string | undefined,
    byteSize: number | undefined,
    createdAt: string,
  ): void {
    this.database
      .prepare(
        `
          INSERT OR IGNORE INTO blobs (
            content_hash, media_type, byte_size, created_at
          ) VALUES (?, ?, ?, ?)
        `,
      )
      .run(contentHash, mediaType ?? "application/octet-stream", byteSize ?? 0, createdAt);
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
        .prepare(`DELETE FROM connector_stream_members WHERE installation_id = ?`)
        .run(id);
      this.database
        .prepare(`DELETE FROM connector_catalog_cursors WHERE installation_id = ?`)
        .run(id);
      this.database
        .prepare(`DELETE FROM connector_sync_state WHERE installation_id = ?`)
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

  async listAttempts(
    installationId: string,
    limit?: number,
  ): Promise<IngestAttempt[]> {
    const cap =
      typeof limit === "number" && Number.isInteger(limit) && limit > 0
        ? limit
        : undefined;
    const rows = cap
      ? (this.database
          .prepare(
            `
              SELECT id, org_id, connector_installation_id, stream_key, delivery_id,
                     started_at, finished_at, status, accepted_count, duplicate_count,
                     quarantined_count, retryable_failure_count, error_code
              FROM ingest_attempts
              WHERE connector_installation_id = ?
              ORDER BY started_at DESC, id DESC
              LIMIT ?
            `,
          )
          .all(installationId, cap) as AttemptRow[])
      : (this.database
          .prepare(
            `
              SELECT id, org_id, connector_installation_id, stream_key, delivery_id,
                     started_at, finished_at, status, accepted_count, duplicate_count,
                     quarantined_count, retryable_failure_count, error_code
              FROM ingest_attempts
              WHERE connector_installation_id = ?
              ORDER BY started_at DESC, id DESC
            `,
          )
          .all(installationId) as AttemptRow[]);
    return rows.map((row) => this.toAttempt(row));
  }

  async latestAttempt(installationId: string): Promise<IngestAttempt | null> {
    const row = this.database
      .prepare(
        `
          SELECT id, org_id, connector_installation_id, stream_key, delivery_id,
                 started_at, finished_at, status, accepted_count, duplicate_count,
                 quarantined_count, retryable_failure_count, error_code
          FROM ingest_attempts
          WHERE connector_installation_id = ?
          ORDER BY started_at DESC, id DESC
          LIMIT 1
        `,
      )
      .get(installationId) as AttemptRow | undefined;
    return row ? this.toAttempt(row) : null;
  }

  async pruneIngestAttempts(
    keepPerInstallation = 64,
    batchSize = 5_000,
    installationLimit = Number.POSITIVE_INFINITY,
  ): Promise<{ deleted: number }> {
    this.assertWritable();
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
    const installations = this.database
      .prepare(
        `
          SELECT connector_installation_id AS id
          FROM ingest_attempts
          GROUP BY connector_installation_id
          HAVING COUNT(*) > ?
          ORDER BY COUNT(*) DESC, connector_installation_id ASC
          LIMIT ?
        `,
      )
      .all(keep, Number.isFinite(limit) ? limit : -1) as Array<{ id: string }>;
    const deleteQuarantines = this.database.prepare(
      `
        DELETE FROM ingest_quarantines
        WHERE attempt_id IN (
          SELECT id FROM (
            SELECT id FROM ingest_attempts
            WHERE connector_installation_id = ?
              AND id NOT IN (
                SELECT id FROM (
                  SELECT id FROM ingest_attempts
                  WHERE connector_installation_id = ?
                  ORDER BY started_at DESC, id DESC
                  LIMIT ?
                )
              )
            ORDER BY started_at ASC, id ASC
            LIMIT ?
          )
        )
      `,
    );
    const deleteAttempts = this.database.prepare(
      `
        DELETE FROM ingest_attempts
        WHERE id IN (
          SELECT id FROM (
            SELECT id FROM ingest_attempts
            WHERE connector_installation_id = ?
              AND id NOT IN (
                SELECT id FROM (
                  SELECT id FROM ingest_attempts
                  WHERE connector_installation_id = ?
                  ORDER BY started_at DESC, id DESC
                  LIMIT ?
                )
              )
            ORDER BY started_at ASC, id ASC
            LIMIT ?
          )
        )
      `,
    );
    let deleted = 0;
    for (const installation of installations) {
      this.database
        .transaction(() => {
          deleteQuarantines.run(
            installation.id,
            installation.id,
            keep,
            batch,
          );
          deleted += deleteAttempts.run(
            installation.id,
            installation.id,
            keep,
            batch,
          ).changes;
        })
        .immediate();
    }
    return { deleted };
  }

  async checkpointWal(): Promise<void> {
    this.assertWritable();
    this.database.pragma("wal_checkpoint(PASSIVE)");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = this.database.pragma("wal_checkpoint(TRUNCATE)") as Array<{
        busy: number;
      }>;
      if ((result[0]?.busy ?? 1) === 0) {
        return;
      }
      await delay(25 * (attempt + 1));
    }
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

  async getSyncCatalog(installationId: string): Promise<SyncCatalogView> {
    return this.loadSyncCatalog(installationId);
  }

  async applySyncCatalogPage(
    input: ApplySyncCatalogPageInput,
  ): Promise<SyncCatalogView> {
    this.assertWritable();
    const apply = this.database.transaction(() => {
      const current = this.loadSyncCatalog(input.installation_id);
      const next = applySyncCatalogMembers(current, input);
      this.database
        .prepare(`DELETE FROM connector_stream_members WHERE installation_id = ?`)
        .run(input.installation_id);
      const insert = this.database.prepare(
        `
          INSERT INTO connector_stream_members (
            installation_id, stream_key, thread_id, label, kind,
            generation, discovered_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      );
      for (const member of next.members) {
        insert.run(
          member.installation_id,
          member.stream_key,
          member.thread_id ?? null,
          member.label ?? null,
          member.kind ?? null,
          member.generation,
          member.discovered_at,
          member.last_seen_at,
        );
      }
      if (next.catalog) {
        this.database
          .prepare(
            `
              INSERT INTO connector_catalog_cursors (
                installation_id, cursor_value, complete, generation, updated_at
              ) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(installation_id) DO UPDATE SET
                cursor_value = excluded.cursor_value,
                complete = excluded.complete,
                generation = excluded.generation,
                updated_at = excluded.updated_at
            `,
          )
          .run(
            next.catalog.installation_id,
            next.catalog.cursor ?? null,
            next.catalog.complete ? 1 : 0,
            next.catalog.generation,
            next.catalog.updated_at,
          );
      }
      return next;
    });
    return apply.immediate();
  }

  async listSyncStates(installationId: string): Promise<SyncStreamState[]> {
    const rows = this.database
      .prepare(
        `
          SELECT installation_id, stream_key, phase, live_cursor, history_cursor,
                 media_pending, idle_until, generation, updated_at
          FROM connector_sync_state
          WHERE installation_id = ?
          ORDER BY updated_at DESC, stream_key ASC
        `,
      )
      .all(installationId) as SyncStateRow[];
    return rows.map((row) => this.toSyncState(row));
  }

  async getSyncState(
    installationId: string,
    streamKey: string,
  ): Promise<SyncStreamState | null> {
    const row = this.database
      .prepare(
        `
          SELECT installation_id, stream_key, phase, live_cursor, history_cursor,
                 media_pending, idle_until, generation, updated_at
          FROM connector_sync_state
          WHERE installation_id = ? AND stream_key = ?
        `,
      )
      .get(installationId, streamKey) as SyncStateRow | undefined;
    return row ? this.toSyncState(row) : null;
  }

  async putSyncState(state: SyncStreamState): Promise<SyncStreamState> {
    this.assertWritable();
    this.database
      .prepare(
        `
          INSERT INTO connector_sync_state (
            installation_id, stream_key, phase, live_cursor, history_cursor,
            media_pending, idle_until, generation, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(installation_id, stream_key) DO UPDATE SET
            phase = excluded.phase,
            live_cursor = excluded.live_cursor,
            history_cursor = excluded.history_cursor,
            media_pending = excluded.media_pending,
            idle_until = excluded.idle_until,
            generation = excluded.generation,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        state.installation_id,
        state.stream_key,
        state.phase,
        state.live_cursor ?? null,
        state.history_cursor ?? null,
        state.media_pending ? 1 : 0,
        state.idle_until ?? null,
        state.generation,
        state.updated_at,
      );
    return { ...state };
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
      if (migration.version === 10) {
        this.database.pragma("foreign_keys = OFF");
      }
      try {
        applyMigration.immediate();
      } finally {
        if (migration.version === 10) {
          this.database.pragma("foreign_keys = ON");
        }
      }
    }
  }

  private getContextJson<T>(
    table: string,
    where: string,
    params: unknown[],
  ): T | null {
    const row = this.database
      .prepare(`SELECT payload_json FROM ${table} WHERE ${where}`)
      .get(...params) as { payload_json: string } | undefined;
    return row ? parseContextJson<T>(row.payload_json) : null;
  }

  private putImmutableContextJson(
    table: string,
    where: string,
    lookupParams: unknown[],
    payload: string,
    label: string,
    insertSql: string,
    insertParams: unknown[],
  ): void {
    const transaction = this.database.transaction(() => {
      const current = this.database
        .prepare(`SELECT payload_json FROM ${table} WHERE ${where}`)
        .get(...lookupParams) as { payload_json: string } | undefined;
      if (current) {
        if (current.payload_json !== payload) {
          throw new Error(`Cannot replace immutable context ${label}`);
        }
        return;
      }
      this.database.prepare(insertSql).run(...insertParams);
    });
    transaction.immediate();
  }

  private findCurrent(identity: SourceIdentity): EventRecord | null {
    const row = this.database
      .prepare(
        `
          SELECT e.id, e.org_id, e.source, e.external_id, e.operation,
               e.content_hash, e.parent_event_id, e.thread_id, e.actor_id,
               e.required_scope_ids_json, e.occurred_at, e.ingested_at
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

  private loadSyncCatalog(installationId: string): SyncCatalogView {
    const members = (
      this.database
        .prepare(
          `
            SELECT installation_id, stream_key, thread_id, label, kind,
                   generation, discovered_at, last_seen_at
            FROM connector_stream_members
            WHERE installation_id = ?
            ORDER BY last_seen_at DESC, stream_key ASC
          `,
        )
        .all(installationId) as StreamMemberRow[]
    ).map((row) => this.toStreamMember(row));
    const snapshot = this.database
      .prepare(
        `
          SELECT installation_id, cursor_value, complete, generation, updated_at
          FROM connector_catalog_cursors
          WHERE installation_id = ?
        `,
      )
      .get(installationId) as CatalogCursorRow | undefined;
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
      generation: row.generation,
      discovered_at: row.discovered_at,
      last_seen_at: row.last_seen_at,
    };
  }

  private toCatalogSnapshot(row: CatalogCursorRow): SyncCatalogSnapshot {
    return {
      installation_id: row.installation_id,
      ...(row.cursor_value ? { cursor: row.cursor_value } : {}),
      complete: row.complete === 1,
      generation: row.generation,
      updated_at: row.updated_at,
    };
  }

  private toSyncState(row: SyncStateRow): SyncStreamState {
    return {
      installation_id: row.installation_id,
      stream_key: row.stream_key,
      phase: row.phase,
      ...(row.live_cursor ? { live_cursor: row.live_cursor } : {}),
      ...(row.history_cursor ? { history_cursor: row.history_cursor } : {}),
      media_pending: row.media_pending === 1,
      ...(row.idle_until ? { idle_until: row.idle_until } : {}),
      generation: row.generation,
      updated_at: row.updated_at,
    };
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
      thread_id: input.thread_id,
      actor_id: input.actor_id,
      required_scope_ids: input.required_scope_ids
        ? [...input.required_scope_ids]
        : undefined,
      occurred_at: input.occurred_at,
      ingested_at: new Date().toISOString(),
    };

    if (input.content_hash) {
      this.insertBlobRow(
        input.content_hash,
        input.content_media_type,
        input.content_byte_size,
        event.ingested_at,
      );
    }
    for (const blob of input.extra_blobs ?? []) {
      this.insertBlobRow(
        blob.content_hash,
        blob.media_type,
        blob.byte_size,
        event.ingested_at,
      );
    }

    this.database
      .prepare(
        `
          INSERT INTO events (
            id, org_id, source, external_id, operation, content_hash,
            parent_event_id, revision_id, occurred_at, ingested_at, thread_id,
            actor_id, required_scope_ids_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        event.thread_id ?? conversationId(event.source, event.external_id, event.id),
        event.actor_id ?? null,
        event.required_scope_ids
          ? JSON.stringify(event.required_scope_ids)
          : null,
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
    this.database
      .prepare(
        `
          INSERT INTO context_projection_outbox (
            id, org_id, event_id, status, attempts, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', 0, ?, ?)
        `,
      )
      .run(`context-projection:${event.id}`, event.org_id, event.id, event.ingested_at, event.ingested_at);
    return event;
  }

  private inboxSql(
    orgId: string,
    query?: InboxQuery,
  ): { sql: string; params: unknown[] } {
    const hiddenList = normalizeInboxListView(query?.list) === "hidden";
    const scoped = inboxScoped(query);
    if (query?.heads) {
      const inner = headsScanQuery(query);
      if (hiddenList) {
        return this.hiddenHeadsSql(orgId, query, inner);
      }
      const visible = this.inboxClauses(orgId, inner, "any");
      const current = this.inboxClauses(orgId, inner, "current_work", {
        event: "e2",
        disposition: "d2",
      });
      if (!scoped) {
        visible.clauses.push(notHiddenSql("e"));
        visible.params.push(orgId);
        current.clauses.push(notHiddenSql("e2"));
        current.params.push(orgId);
      }
      const page = headsPageTail(query);
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
          ${page.whereSql}
          ${page.orderSql}
        `,
        params: [...visible.params, ...current.params, ...page.params],
      };
    }
    if (query?.siblings) {
      const { clauses, params } = this.inboxClauses(orgId, query, "any");
      if (!scoped) {
        if (hiddenList) {
          const hidden = hiddenThreadIdSql(orgId);
          clauses.push(`e.thread_id IN (${hidden.sql})`);
          params.push(...hidden.params);
        } else {
          clauses.push(`e.thread_id IN (
          SELECT e2.thread_id
          FROM message_dispositions d2
          JOIN events e2 ON e2.id = d2.event_id
          WHERE d2.org_id = ? AND d2.disposition = 'current_work'
            AND ${isCurrentHeadSql("e2", "h2")}
        )`);
          params.push(orgId);
          clauses.push(notHiddenSql("e"));
          params.push(orgId);
        }
      }
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
    if (hiddenList) {
      const { clauses, params } = this.inboxClauses(orgId, query, "any");
      if (!scoped) {
        const hidden = hiddenThreadIdSql(orgId);
        clauses.push(`e.thread_id IN (${hidden.sql})`);
        params.push(...hidden.params);
      }
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
    const { clauses, params } = this.inboxClauses(orgId, query, "current_work");
    if (!scoped) {
      clauses.push(notHiddenSql("e"));
      params.push(orgId);
    }
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

  private hiddenHeadsSql(
    orgId: string,
    query?: InboxQuery,
    inner: InboxQuery | undefined = headsScanQuery(query),
  ): { sql: string; params: unknown[] } {
    const visible = this.inboxClauses(orgId, inner, "any");
    const hidden = hiddenThreadIdSql(orgId);
    const page = headsPageTail(query);
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
            AND d.reason_codes_json NOT LIKE '%thread_status%'
            AND e.operation != 'tombstone'
            AND e.thread_id IN (${hidden.sql})
        ) ranked
        ${page.whereSql}
        ${page.orderSql}
      `,
      params: [...visible.params, ...hidden.params, ...page.params],
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
        thread_id: row.thread_id,
        actor_id: row.actor_id,
        required_scope_ids_json: row.required_scope_ids_json,
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
      thread_id: row.thread_id ?? undefined,
      actor_id: row.actor_id ?? undefined,
      required_scope_ids: row.required_scope_ids_json
        ? (JSON.parse(row.required_scope_ids_json) as string[])
        : undefined,
      occurred_at: row.occurred_at,
      ingested_at: row.ingested_at,
    };
  }

  private toPref(row: PrefRow): ConversationPref {
    const hidden = row.hidden === 1;
    return {
      org_id: row.org_id,
      thread_id: row.thread_id,
      title: row.title,
      pinned: row.pinned === 1,
      hidden,
      hidden_reason: hidden ? normalizeHiddenReason(row.hidden_reason) : null,
      last_read_at: row.last_read_at,
      last_read_external_id: row.last_read_external_id,
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
  return Boolean(normalizeInboxLimit(query?.limit));
}

function toContextProjectionJob(row: ContextProjectionJobRow): ContextProjectionJob {
  return {
    id: row.id,
    org_id: row.org_id,
    event_id: row.event_id,
    status: row.status,
    attempts: row.attempts,
    ...(row.lease_owner ? { lease_owner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { lease_expires_at: row.lease_expires_at } : {}),
    ...(row.next_retry_at ? { next_retry_at: row.next_retry_at } : {}),
    ...(row.last_error ? { last_error: row.last_error } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
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

function headsPageTail(query?: InboxQuery): {
  whereSql: string;
  orderSql: string;
  params: unknown[];
} {
  const params: unknown[] = [];
  let whereSql = "WHERE rn = 1";
  if (query?.before) {
    whereSql +=
      " AND (occurred_at < ? OR (occurred_at = ? AND id < ?))";
    params.push(query.before, query.before, query.before_id ?? "");
  }
  const limit = normalizeInboxLimit(query?.limit);
  if (limit !== undefined) {
    return {
      whereSql,
      orderSql: "ORDER BY occurred_at DESC, id DESC LIMIT ?",
      params: [...params, limit],
    };
  }
  return {
    whereSql,
    orderSql: "ORDER BY occurred_at ASC, id ASC",
    params,
  };
}

function isCurrentHeadSql(event = "e", heads = "h"): string {
  return `EXISTS (
    SELECT 1 FROM source_heads ${heads}
    WHERE ${heads}.current_event_id = ${event}.id
  )`;
}

function hiddenThreadIdSql(orgId: string): { sql: string; params: unknown[] } {
  return {
    sql: `SELECT thread_id FROM conversation_prefs WHERE org_id = ? AND hidden = 1`,
    params: [orgId],
  };
}

function notHiddenSql(event = "e"): string {
  return `${event}.thread_id NOT IN (SELECT p.thread_id FROM conversation_prefs p WHERE p.org_id = ? AND p.hidden = 1)`;
}

function inboxScoped(query?: InboxQuery): boolean {
  return Boolean(query?.source || query?.target || query?.thread_ids);
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

interface ExecutorRow {
  id: string;
  org_id: string;
  kind: ExecutorInstallation["kind"];
  name: string;
  status: ExecutorInstallation["status"];
  config_json: string;
  created_at: string;
  updated_at: string;
}

interface RecipeRow {
  id: string;
  org_id: string;
  name: string;
  match_json: string;
  executor_type: string;
  executor_config_json: string;
  can_write_back: number;
  include_context: number;
  enabled: number;
  trigger_kind: string | null;
  trigger_interval_ms: number | null;
  trigger_coalesce: number | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
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
  next_retry_at: string | null;
  payload_json: string | null;
  lease_expires_at: string | null;
  idempotency_key: string | null;
  channel_receipt_json: string | null;
  created_at: string;
  updated_at: string;
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
  result_json: string | null;
  created_at: string;
  updated_at: string;
}

function toExecutorInstallation(row: ExecutorRow): ExecutorInstallation {
  return {
    id: row.id,
    org_id: row.org_id,
    kind: row.kind,
    name: row.name,
    status: row.status,
    config: JSON.parse(row.config_json) as ExecutorInstallation["config"],
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toRecipe(row: RecipeRow): Recipe {
  const match = JSON.parse(row.match_json) as Recipe["match"];
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
            ...(kind === "push" ? { coalesce: row.trigger_coalesce !== 0 } : {}),
          }
        : undefined,
    }),
    executor_type: row.executor_type,
    executor_config: JSON.parse(row.executor_config_json) as Recipe["executor_config"],
    can_write_back: row.can_write_back === 1,
    include_context: row.include_context === 1,
    enabled: row.enabled === 1,
    ...(row.next_run_at ? { next_run_at: row.next_run_at } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
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
    created_at: row.created_at,
    updated_at: row.updated_at,
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
      ? (JSON.parse(row.result_json) as WorkRun["result"])
      : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
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
    attempts: row.attempts,
    last_error: row.last_error ?? undefined,
    next_retry_at: row.next_retry_at ?? undefined,
    payload: parseDeliveryPayload(row.payload_json),
    lease_expires_at: row.lease_expires_at ?? undefined,
    idempotency_key: row.idempotency_key ?? undefined,
    channel_receipt: parseChannelReceipt(row.channel_receipt_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseChannelReceipt(
  raw: string | null,
): WorkDelivery["channel_receipt"] | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as WorkDelivery["channel_receipt"];
    if (!parsed || typeof parsed.accepted !== "boolean") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function parseDeliveryPayload(
  raw: string | null,
): WorkDelivery["payload"] | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as WorkDelivery["payload"];
    if (!parsed || typeof parsed.summary !== "string") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseContextJson<T>(value: string): T {
  return JSON.parse(value) as T;
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


function compareContextArtifactOrder(left: ContextArtifact, right: ContextArtifact): number {
  const leftKey = `${left.recorded_at}\u0000${left.id}`;
  const rightKey = `${right.recorded_at}\u0000${right.id}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}