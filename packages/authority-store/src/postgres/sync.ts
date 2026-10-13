import type {
  ConnectorInstallation,
  SyncPhase,
  SyncRun,
  SyncWorkRecord,
  IngestAttempt,
  IngestQuarantine,
  NewConnectorInstallation,
  SetConnectorInstallationStatus,
  SetConnectorInstallationConfig,
  ConnectorLease,
  ReleaseConnectorLease,
  ResetConnectorCursor,
  ConnectorStreamCursor,
  NewIngestAttempt,
  SettleIngestAttempt,
  NewSyncRun,
  ListSyncRunsQuery,
  CommandSyncRun,
  EnqueueSyncWork,
  ClaimSyncWork,
  RenewSyncWork,
  SettleSyncWork,
  UnassignedSyncWorkQuery,
  SyncWorkIdentity,
  WakeUnassignedSyncWork,
  SyncCatalogView,
  SyncCatalogHead,
  ApplySyncCatalogPageInput,
  SyncPhaseHead,
  SyncStreamState,
  SyncWorkGap,
  SyncCatalogMember,
} from "@regenic/domain";
import type {
  PoolClient,
} from "pg";
import {
  validateSyncRunOptions,
  syncWorkPriority,
  SYNC_CATALOG_STREAM,
  applySyncCatalogMembers,
  catalogStreamKeysLeft,
  syncWorkEnsurePlan,
  dueSyncWorkId,
} from "@regenic/domain";
import {
  PgSql,
  asBool,
  asJson,
  asNumber,
  jsonb,
  toIso,
  toIsoOrNull,
} from "./sql";
import {
  parseContextJson,
  toCatalogSnapshot,
} from "./context-artifacts";

export const INGEST_ATTEMPT_KEEP_PER_INSTALLATION = 64;

export const INGEST_ATTEMPT_PRUNE_BATCH = 5_000;

export const INGEST_ATTEMPT_PRUNE_INSTALLATIONS = 25;

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

export interface CatalogCursorRow {
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

const CURSOR_COLUMNS = `
  installation_id, stream_key, cursor_value, cursor_version,
  lease_owner, lease_expires_at, updated_at
`;

export async function createInstallation(db: PgSql, input: NewConnectorInstallation): Promise<ConnectorInstallation> {
    const installation: ConnectorInstallation = {
      ...input,
      config: { ...input.config },
      updated_at: input.created_at,
    };
    await db.execute(
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

export async function findInstallation(db: PgSql, id: string): Promise<ConnectorInstallation | null> {
    const row = await db.queryOne<InstallationRow>(
      `
        SELECT id, org_id, connector_type, status, config_json, credentials_ref,
               created_at, updated_at
        FROM connector_installations WHERE id = $1
      `,
      [id],
    );
    return row ? toInstallation(db, row) : null;
  }

export async function listInstallations(db: PgSql, orgId: string): Promise<ConnectorInstallation[]> {
    const rows = await db.query<InstallationRow>(
      `
        SELECT id, org_id, connector_type, status, config_json, credentials_ref,
               created_at, updated_at
        FROM connector_installations WHERE org_id = $1 ORDER BY created_at DESC
      `,
      [orgId],
    );
    return rows.map((row) => toInstallation(db, row));
  }

export async function setInstallationStatus(db: PgSql, input: SetConnectorInstallationStatus): Promise<ConnectorInstallation | null> {
    const rowCount = await db.execute(
      `
        UPDATE connector_installations SET status = $1, updated_at = $2
        WHERE id = $3 AND org_id = $4
      `,
      [input.status, input.updated_at, input.id, input.org_id],
    );
    return rowCount === 1 ? findInstallation(db, input.id) : null;
  }

export async function updateInstallationConfig(db: PgSql, input: SetConnectorInstallationConfig): Promise<ConnectorInstallation | null> {
    const rowCount = await db.execute(
      `
        UPDATE connector_installations SET config_json = $1, updated_at = $2
        WHERE id = $3 AND org_id = $4
      `,
      [jsonb(input.config), input.updated_at, input.id, input.org_id],
    );
    return rowCount === 1 ? findInstallation(db, input.id) : null;
  }

export async function deleteInstallation(db: PgSql, id: string, orgId: string): Promise<boolean> {
    return db.withTx(async (client) => {
      const row = await db.queryOne<{ id: string }>(
        `SELECT id FROM connector_installations WHERE id = $1 AND org_id = $2`,
        [id, orgId],
        client,
      );
      if (!row) {
        return false;
      }
      await db.execute(
        `
          DELETE FROM ingest_quarantines
          WHERE attempt_id IN (
            SELECT id FROM ingest_attempts WHERE connector_installation_id = $1
          )
        `,
        [id],
        client,
      );
      await db.execute(
        `DELETE FROM ingest_attempts WHERE connector_installation_id = $1`,
        [id],
        client,
      );
      await db.execute(
        `DELETE FROM connector_cursors WHERE installation_id = $1`,
        [id],
        client,
      );
      await db.execute(
        `DELETE FROM connector_stream_members WHERE installation_id = $1`,
        [id],
        client,
      );
      await db.execute(
        `DELETE FROM connector_catalog_cursors WHERE installation_id = $1`,
        [id],
        client,
      );
      await db.execute(
        `DELETE FROM connector_sync_state WHERE installation_id = $1`,
        [id],
        client,
      );
      await db.execute(
        `DELETE FROM connector_sync_work WHERE installation_id = $1`,
        [id],
        client,
      );
      await db.execute(
        `DELETE FROM sync_runs WHERE installation_id = $1`,
        [id],
        client,
      );
      await db.execute(
        `DELETE FROM connector_installations WHERE id = $1 AND org_id = $2`,
        [id, orgId],
        client,
      );
      return true;
    });
  }

export async function acquireLease(db: PgSql, input: {
    installation_id: string;
    stream_key: string;
    lease_owner: string;
    now: string;
    lease_duration_ms: number;
    preempt?: boolean;
  }): Promise<ConnectorLease | null> {
    return db.withTx(async (client) => {
      const installation = await db.queryOne<{
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
      const updated = await db.queryOne<CursorRow>(
        `
          UPDATE connector_cursors
          SET lease_owner = $1, lease_expires_at = $2, updated_at = $3
          WHERE installation_id = $4 AND stream_key = $5
            AND (
              $6::boolean
              OR lease_owner IS NULL
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
          input.preempt === true,
        ],
        client,
      );
      if (updated) {
        return toLease(db, updated);
      }
      const inserted = await db.queryOne<CursorRow>(
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
      return inserted ? toLease(db, inserted) : null;
    });
  }

export async function releaseLease(db: PgSql, input: ReleaseConnectorLease): Promise<boolean> {
    const rowCount = await db.execute(
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

export async function resetCursor(db: PgSql, input: ResetConnectorCursor): Promise<ConnectorStreamCursor | null> {
    return db.withTx(async (client) => {
      const cursor = await findCursorRow(db, 
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
      await db.execute(
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
      const next = await findCursorRow(db, 
        input.installation_id,
        input.stream_key,
        client,
      );
      return next ? toCursor(db, next) : null;
    });
  }

export async function beginAttempt(db: PgSql, input: NewIngestAttempt): Promise<IngestAttempt> {
    await beginAttemptOn(db, undefined, input);
    return (await findAttempt(db, input.id))!;
  }

export async function settleAttempt(db: PgSql, input: SettleIngestAttempt): Promise<IngestAttempt> {
    return db.withTx((client) => settleAttemptOn(db, client, input));
  }

export async function beginAttemptOn(db: PgSql, client: PoolClient | undefined, input: NewIngestAttempt): Promise<void> {
    await db.execute(
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

export async function settleAttemptOn(db: PgSql, client: PoolClient, input: SettleIngestAttempt): Promise<IngestAttempt> {
    const cursor = await findCursorRow(db, 
      input.installation_id,
      input.stream_key,
      client,
    );
    if (!cursor || cursor.lease_owner !== input.lease_owner) {
      throw new Error("Connector lease is not held by the attempt owner");
    }
    const status =
      input.retryable_failure_count === 0 ? "succeeded" : "failed";
    await db.execute(
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
      await db.execute(
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
    const updated = await db.execute(
      `
        UPDATE connector_cursors
        SET cursor_value = $1, cursor_version = $2, lease_owner = NULL,
            lease_expires_at = NULL, updated_at = $3
        WHERE installation_id = $4 AND stream_key = $5 AND lease_owner = $6
      `,
      [
        advancesCursor ? input.next_cursor : cursor.cursor_value,
        advancesCursor
          ? asNumber(cursor.cursor_version) + 1
          : asNumber(cursor.cursor_version),
        input.finished_at,
        input.installation_id,
        input.stream_key,
        input.lease_owner,
      ],
      client,
    );
    if (updated !== 1) {
      throw new Error("Connector lease is not held by the attempt owner");
    }
    return (await findAttempt(db, input.attempt_id, client))!;
  }

export async function listAttempts(db: PgSql, installationId: string, limit?: number): Promise<IngestAttempt[]> {
    const cap =
      typeof limit === "number" && Number.isInteger(limit) && limit > 0
        ? limit
        : undefined;
    const rows = cap
      ? await db.query<AttemptRow>(
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
      : await db.query<AttemptRow>(
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
    return rows.map((row) => toAttempt(db, row));
  }

export async function latestAttempt(db: PgSql, installationId: string): Promise<IngestAttempt | null> {
    const row = await db.queryOne<AttemptRow>(
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
    return row ? toAttempt(db, row) : null;
  }

export async function pruneIngestAttempts(db: PgSql, keepPerInstallation = 64, batchSize = 5_000, installationLimit = Number.POSITIVE_INFINITY): Promise<{ deleted: number }> {
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
      ? await db.query<{ id: string }>(
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
      : await db.query<{ id: string }>(
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
      deleted += await db.withTx(async (client) => {
        await db.execute(
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
        return db.execute(
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

export async function listQuarantines(db: PgSql, installationId: string): Promise<IngestQuarantine[]> {
    const rows = await db.query<QuarantineRow>(
      `
        SELECT q.id, q.attempt_id, a.connector_installation_id, a.stream_key,
               q.record_external_id, q.reason_code, q.safe_metadata_json, q.created_at
        FROM ingest_quarantines q
        JOIN ingest_attempts a ON a.id = q.attempt_id
        WHERE a.connector_installation_id = $1 ORDER BY q.created_at DESC
      `,
      [installationId],
    );
    return rows.map((row) => toQuarantine(db, row));
  }

export async function getCursor(db: PgSql, installationId: string, streamKey: string): Promise<ConnectorStreamCursor | null> {
    const row = await findCursorRow(db, installationId, streamKey);
    return row ? toCursor(db, row) : null;
  }

export async function listCursors(db: PgSql, installationId: string, streamKeys?: readonly string[]): Promise<ConnectorStreamCursor[]> {
    if (streamKeys && streamKeys.length === 0) {
      return [];
    }
    const rows = streamKeys
      ? await db.query<CursorRow>(
          `
            SELECT ${CURSOR_COLUMNS}
            FROM connector_cursors
            WHERE installation_id = $1 AND stream_key = ANY($2::text[])
            ORDER BY stream_key
          `,
          [installationId, [...streamKeys]],
        )
      : await db.query<CursorRow>(
          `
            SELECT ${CURSOR_COLUMNS}
            FROM connector_cursors
            WHERE installation_id = $1
            ORDER BY stream_key
          `,
          [installationId],
        );
    return rows.map((row) => toCursor(db, row));
  }

export async function createSyncRun(db: PgSql, input: NewSyncRun): Promise<SyncRun> {
    validateSyncRunOptions(input.options ?? {});
    const installation = await db.queryOne<{ id: string }>(
      `SELECT id FROM connector_installations WHERE id = $1 AND org_id = $2`,
      [input.installation_id, input.org_id],
    );
    if (!installation) {
      throw new Error("Connector installation not found for sync run");
    }
    const row = await db.queryOne<SyncRunRow>(
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
    return toSyncRun(db, row!);
  }

export async function getSyncRun(db: PgSql, id: string, orgId: string): Promise<SyncRun | null> {
    const row = await db.queryOne<SyncRunRow>(
      `SELECT * FROM sync_runs WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    return row ? toSyncRun(db, row) : null;
  }

export async function listSyncRuns(db: PgSql, query: ListSyncRunsQuery): Promise<SyncRun[]> {
    const limit =
      Number.isInteger(query.limit) && Number(query.limit) > 0
        ? Math.min(Number(query.limit), 1_000)
        : 100;
    const rows = query.installation_id
      ? await db.query<SyncRunRow>(
          `
            SELECT * FROM sync_runs
            WHERE org_id = $1 AND installation_id = $2
            ORDER BY created_at DESC, id DESC LIMIT $3
          `,
          [query.org_id, query.installation_id, limit],
        )
      : await db.query<SyncRunRow>(
          `
            SELECT * FROM sync_runs
            WHERE org_id = $1
            ORDER BY created_at DESC, id DESC LIMIT $2
          `,
          [query.org_id, limit],
        );
    return rows.map((row) => toSyncRun(db, row));
  }

export async function commandSyncRun(db: PgSql, input: CommandSyncRun): Promise<SyncRun | null> {
    return db.withTx(async (client) => {
      const current = await db.queryOne<SyncRunRow>(
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
        await db.execute(
          `UPDATE sync_runs SET status = 'paused', updated_at = $1 WHERE id = $2`,
          [input.now, input.id],
          client,
        );
      } else if (
        input.command === "resume" &&
        current.status === "paused"
      ) {
        await db.execute(
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
        await db.execute(
          `
            UPDATE sync_runs
            SET status = 'cancelled', finished_at = $1, updated_at = $1
            WHERE id = $2
          `,
          [input.now, input.id],
          client,
        );
        await db.execute(
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
      const next = await db.queryOne<SyncRunRow>(
        `SELECT * FROM sync_runs WHERE id = $1`,
        [input.id],
        client,
      );
      return next ? toSyncRun(db, next) : null;
    });
  }

export async function enqueueSyncWork(db: PgSql, input: EnqueueSyncWork): Promise<SyncWorkRecord> {
    return db.withTx((client) => enqueueSyncWorkOn(db, client, input));
  }

export async function enqueueSyncWorkMany(db: PgSql, inputs: readonly EnqueueSyncWork[]): Promise<number> {
    if (inputs.length === 0) {
      return 0;
    }
    return db.withTx(async (client) => {
      for (const input of inputs) {
        await enqueueSyncWorkOn(db, client, input);
      }
      return inputs.length;
    });
  }

async function enqueueSyncWorkOn(db: PgSql, client: PoolClient, input: EnqueueSyncWork): Promise<SyncWorkRecord> {
    const current = await db.queryOne<SyncWorkRow>(
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
        const row = await db.queryOne<SyncWorkRow>(
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
        return toSyncWork(db, row!);
      }
      return toSyncWork(db, current);
    }
    if (input.run_id) {
      const run = await db.queryOne<{ id: string }>(
        `SELECT id FROM sync_runs WHERE id = $1`,
        [input.run_id],
        client,
      );
      if (!run) {
        throw new Error(`Sync run not found: ${input.run_id}`);
      }
    }
    const row = await db.queryOne<SyncWorkRow>(
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
      await db.execute(
        `
          UPDATE sync_runs
          SET total_work = total_work + 1, updated_at = $1
          WHERE id = $2
        `,
        [input.now, input.run_id],
        client,
      );
    }
    return toSyncWork(db, row!);
  }

export async function claimSyncWork(db: PgSql, input: ClaimSyncWork): Promise<SyncWorkRecord[]> {
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      return [];
    }
    return db.withTx(async (client) => {
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
      const candidates = await db.query<{ id: string }>(
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
      const rows = await db.query<SyncWorkRow>(
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
      await db.execute(
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
      return ids.map((id) => toSyncWork(db, byId.get(id)!));
    });
  }

export async function renewSyncWork(db: PgSql, input: RenewSyncWork): Promise<boolean> {
    const leaseExpiresAt = new Date(
      Date.parse(input.now) + input.lease_ms,
    ).toISOString();
    return (
      (await db.execute(
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

export async function settleSyncWork(db: PgSql, input: SettleSyncWork): Promise<SyncWorkRecord | null> {
    return db.withTx(async (client) => {
      const current = await db.queryOne<SyncWorkRow>(
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
      const row = await db.queryOne<SyncWorkRow>(
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
        await db.execute(
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
        const remaining = await db.queryOne<{ found: number }>(
          `
            SELECT 1 AS found FROM connector_sync_work
            WHERE run_id = $1 AND status IN ('pending', 'running')
            LIMIT 1
          `,
          [current.run_id],
          client,
        );
        if (!remaining) {
          await db.execute(
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
      return row ? toSyncWork(db, row) : null;
    });
  }

export async function hasUnassignedSyncWork(db: PgSql, query: UnassignedSyncWorkQuery = {}): Promise<boolean> {
    const { sql, params } = unassignedSyncWorkWhere(query);
    const row = await db.queryOne<{ found: number }>(
      `SELECT 1 AS found FROM connector_sync_work WHERE ${sql} LIMIT 1`,
      params,
    );
    return Boolean(row);
  }

export async function listUnassignedSyncWorkIdentities(db: PgSql, query: {
    installation_id: string;
  }): Promise<SyncWorkIdentity[]> {
    const { sql, params } = unassignedSyncWorkWhere({
      installation_id: query.installation_id,
    });
    const rows = await db.query<SyncWorkIdentity>(
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

export async function wakeUnassignedSyncWork(db: PgSql, input: WakeUnassignedSyncWork): Promise<number> {
    const streamKeys = uniqueStreamKeys(input.stream_keys);
    if (streamKeys.length === 0) {
      return 0;
    }
    const keyPlaceholders = streamKeys
      .map((_, index) => `$${index + 4}`)
      .join(", ");
    return db.execute(
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

export async function getSyncCatalog(db: PgSql, installationId: string): Promise<SyncCatalogView> {
    return loadSyncCatalog(db, installationId);
  }

export async function getSyncCatalogHead(db: PgSql, installationId: string): Promise<SyncCatalogHead> {
    const count = await db.queryOne<{ n: string | number }>(
      `
        SELECT COUNT(*) AS n
        FROM connector_stream_members
        WHERE installation_id = $1 AND stream_key <> $2
      `,
      [installationId, SYNC_CATALOG_STREAM],
    );
    const cursor = await db.queryOne<{
      complete: unknown;
      generation: number;
      updated_at: unknown;
    }>(
      `
        SELECT complete, generation, updated_at
        FROM connector_catalog_cursors
        WHERE installation_id = $1
      `,
      [installationId],
    );
    return {
      member_count: Number(count?.n ?? 0),
      has_cursor: cursor != null,
      complete: cursor ? asBool(cursor.complete) : false,
      generation: cursor ? asNumber(cursor.generation) : 1,
      ...(cursor ? { updated_at: toIso(cursor.updated_at) } : {}),
    };
  }

export async function applySyncCatalogPage(db: PgSql, input: ApplySyncCatalogPageInput): Promise<SyncCatalogView> {
    return db.withTx(async (client) => {
      const current = await loadSyncCatalog(db, input.installation_id, client);
      const next = applySyncCatalogMembers(current, input);
      await db.execute(
        `DELETE FROM connector_stream_members WHERE installation_id = $1`,
        [input.installation_id],
        client,
      );
      for (const member of next.members) {
        await db.execute(
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
        await db.execute(
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
      if (input.complete) {
        await dropStreamsLeftCatalog(db, 
          client,
          input.installation_id,
          catalogStreamKeysLeft(current, next),
          input.now,
        );
      }
      return next;
    });
  }

export async function listSyncPhaseHeads(db: PgSql, installationId: string): Promise<SyncPhaseHead[]> {
    const rows = await db.query<{
      stream_key: string;
      phase: SyncPhase;
      media_pending: boolean;
      generation: number;
      idle_until: string | null;
    }>(
      `
        SELECT stream_key, phase, media_pending, generation, idle_until
        FROM connector_sync_state
        WHERE installation_id = $1
      `,
      [installationId],
    );
    return rows.map((row) => ({
      stream_key: row.stream_key,
      phase: row.phase,
      media_pending: Boolean(row.media_pending),
      generation: Number(row.generation),
      idle_until: row.idle_until ?? undefined,
    }));
  }

export async function listSyncStates(db: PgSql, installationId: string): Promise<SyncStreamState[]> {
    const rows = await db.query<SyncStateRow>(
      `
        SELECT installation_id, stream_key, phase, live_cursor, history_cursor,
               media_pending, idle_until, generation, updated_at
        FROM connector_sync_state
        WHERE installation_id = $1
        ORDER BY updated_at DESC, stream_key ASC
      `,
      [installationId],
    );
    return rows.map((row) => toSyncState(db, row));
  }

export async function getSyncState(db: PgSql, installationId: string, streamKey: string): Promise<SyncStreamState | null> {
    const row = await db.queryOne<SyncStateRow>(
      `
        SELECT installation_id, stream_key, phase, live_cursor, history_cursor,
               media_pending, idle_until, generation, updated_at
        FROM connector_sync_state
        WHERE installation_id = $1 AND stream_key = $2
      `,
      [installationId, streamKey],
    );
    return row ? toSyncState(db, row) : null;
  }

export async function putSyncState(db: PgSql, state: SyncStreamState): Promise<SyncStreamState> {
    await db.withTx(async (client) => {
      if (
        await streamOutsideCompleteCatalog(db, 
          client,
          state.installation_id,
          state.stream_key,
        )
      ) {
        await dropStreamsLeftCatalog(db, 
          client,
          state.installation_id,
          [state.stream_key],
          state.updated_at,
        );
        return;
      }
      await client.query(
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
      await ensureOwedSyncWork(db, client, state);
    });
    return { ...state };
  }

async function streamOutsideCompleteCatalog(db: PgSql, client: PoolClient, installationId: string, streamKey: string): Promise<boolean> {
    const cursor = await client.query<{ complete: unknown }>(
      `
        SELECT complete
        FROM connector_catalog_cursors
        WHERE installation_id = $1
      `,
      [installationId],
    );
    if (!asBool(cursor.rows[0]?.complete)) {
      return false;
    }
    const member = await client.query(
      `
        SELECT 1
        FROM connector_stream_members
        WHERE installation_id = $1 AND stream_key = $2
      `,
      [installationId, streamKey],
    );
    return (member.rowCount ?? 0) === 0;
  }

async function dropStreamsLeftCatalog(db: PgSql, client: PoolClient, installationId: string, streamKeys: readonly string[], now: string): Promise<void> {
    if (streamKeys.length === 0) {
      return;
    }
    await client.query(
      `
        DELETE FROM connector_sync_state
        WHERE installation_id = $1 AND stream_key = ANY($2::text[])
      `,
      [installationId, streamKeys],
    );
    await client.query(
      `
        UPDATE connector_sync_work
        SET status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = $3
        WHERE installation_id = $1
          AND run_id IS NULL
          AND status IN ('pending', 'running')
          AND stream_key = ANY($2::text[])
      `,
      [installationId, streamKeys, now],
    );
  }

async function ensureOwedSyncWork(db: PgSql, client: PoolClient, state: SyncStreamState): Promise<void> {
    const existing = await client.query<{
      lane: SyncWorkGap["missing_lane"];
      status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
      run_id: string | null;
    }>(
      `
        SELECT lane, status, run_id
        FROM connector_sync_work
        WHERE installation_id = $1 AND stream_key = $2 AND generation = $3
      `,
      [state.installation_id, state.stream_key, state.generation],
    );
    const plan = syncWorkEnsurePlan({ state, existing: existing.rows });
    for (const lane of plan.enqueue) {
      await client.query(
        `
          INSERT INTO connector_sync_work (
            id, run_id, installation_id, stream_key, lane, priority,
            next_due_at, status, attempts, generation, created_at, updated_at
          ) VALUES ($1, NULL, $2, $3, $4, $5, $6, 'pending', 0, $7, $8, $8)
          ON CONFLICT (installation_id, stream_key, lane, generation) DO UPDATE SET
            status = 'pending',
            next_due_at = EXCLUDED.next_due_at,
            run_id = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = NULL,
            updated_at = EXCLUDED.updated_at
          WHERE connector_sync_work.run_id IS NULL
            AND connector_sync_work.status NOT IN ('pending', 'running')
        `,
        [
          dueSyncWorkId(
            state.installation_id,
            state.stream_key,
            lane,
            state.generation,
          ),
          state.installation_id,
          state.stream_key,
          lane,
          syncWorkPriority(lane),
          state.updated_at,
          state.generation,
          state.updated_at,
        ],
      );
    }
    for (const lane of plan.cancel) {
      await client.query(
        `
          UPDATE connector_sync_work
          SET status = 'cancelled',
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = $1
          WHERE installation_id = $2 AND stream_key = $3 AND generation = $4
            AND lane = $5 AND run_id IS NULL AND status = 'pending'
        `,
        [
          state.updated_at,
          state.installation_id,
          state.stream_key,
          state.generation,
          lane,
        ],
      );
    }
  }

async function loadSyncCatalog(db: PgSql, installationId: string, client?: PoolClient): Promise<SyncCatalogView> {
    const memberRows = await db.query<StreamMemberRow>(
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
    const members = memberRows.map((row) => toStreamMember(db, row));
    const snapshot = await db.queryOne<CatalogCursorRow>(
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
      catalog: snapshot ? toCatalogSnapshot(db, snapshot) : null,
    };
  }

function toStreamMember(db: PgSql, row: StreamMemberRow): SyncCatalogMember {
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

function toSyncState(db: PgSql, row: SyncStateRow): SyncStreamState {
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

function toSyncRun(db: PgSql, row: SyncRunRow): SyncRun {
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

function toSyncWork(db: PgSql, row: SyncWorkRow): SyncWorkRecord {
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

async function findCursorRow(db: PgSql, installationId: string, streamKey: string, client?: PoolClient): Promise<CursorRow | null> {
    return db.queryOne<CursorRow>(
      `
        SELECT ${CURSOR_COLUMNS}
        FROM connector_cursors
        WHERE installation_id = $1 AND stream_key = $2
      `,
      [installationId, streamKey],
      client,
    );
  }

async function findAttempt(db: PgSql, id: string, client?: PoolClient): Promise<IngestAttempt | null> {
    const row = await db.queryOne<AttemptRow>(
      `
        SELECT id, org_id, connector_installation_id, stream_key, delivery_id,
               started_at, finished_at, status, accepted_count, duplicate_count,
               quarantined_count, retryable_failure_count, error_code
        FROM ingest_attempts WHERE id = $1
      `,
      [id],
      client,
    );
    return row ? toAttempt(db, row) : null;
  }

function toInstallation(db: PgSql, row: InstallationRow): ConnectorInstallation {
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

function toCursor(db: PgSql, row: CursorRow): ConnectorStreamCursor {
    return {
      installation_id: row.installation_id,
      stream_key: row.stream_key,
      cursor: row.cursor_value ?? undefined,
      cursor_version: asNumber(row.cursor_version),
      updated_at: toIso(row.updated_at),
    };
  }

function toLease(db: PgSql, row: CursorRow): ConnectorLease {
    return {
      ...toCursor(db, row),
      lease_owner: row.lease_owner!,
      lease_expires_at: toIso(row.lease_expires_at),
    };
  }

function toAttempt(db: PgSql, row: AttemptRow): IngestAttempt {
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

function toQuarantine(db: PgSql, row: QuarantineRow): IngestQuarantine {
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

export function toIsoOrUndefined(value: unknown): string | undefined {
  if (value == null) {
    return undefined;
  }
  return toIso(value);
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
