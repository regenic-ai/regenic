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
  CommitSyncPage,
  CommitSyncPageResult,
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
import Database from "better-sqlite3";
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
  commitIngestUnlocked,
} from "./events";
import {
  putConversationPrefUnlocked,
} from "./inbox";
import {
  toCatalogSnapshot,
} from "./context-artifacts";

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

export interface CatalogCursorRow {
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

interface SyncRunRow {
  id: string;
  org_id: string;
  installation_id: string;
  mode: SyncRun["mode"];
  status: SyncRun["status"];
  options_json: string;
  total_work: number;
  completed_work: number;
  failed_work: number;
  accepted_count: number;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface SyncWorkRow {
  id: string;
  run_id: string | null;
  installation_id: string;
  stream_key: string;
  lane: SyncWorkRecord["lane"];
  priority: number;
  next_due_at: string;
  status: SyncWorkRecord["status"];
  attempts: number;
  generation: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_error: string | null;
  created_at: string;
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

export async function createInstallation(db: Database.Database, input: NewConnectorInstallation): Promise<ConnectorInstallation> {
    
    const installation: ConnectorInstallation = {
      ...input,
      config: { ...input.config },
      updated_at: input.created_at,
    };
    db
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

export async function findInstallation(db: Database.Database, id: string): Promise<ConnectorInstallation | null> {
    const row = db
      .prepare(
        `
          SELECT id, org_id, connector_type, status, config_json, credentials_ref,
                 created_at, updated_at
          FROM connector_installations WHERE id = ?
        `,
      )
      .get(id) as InstallationRow | undefined;
    return row ? toInstallation(db, row) : null;
  }

export async function listInstallations(db: Database.Database, orgId: string): Promise<ConnectorInstallation[]> {
    const rows = db
      .prepare(
        `
          SELECT id, org_id, connector_type, status, config_json, credentials_ref,
                 created_at, updated_at
          FROM connector_installations WHERE org_id = ? ORDER BY created_at DESC
        `,
      )
      .all(orgId) as InstallationRow[];
    return rows.map((row) => toInstallation(db, row));
  }

export async function setInstallationStatus(db: Database.Database, input: SetConnectorInstallationStatus): Promise<ConnectorInstallation | null> {
    
    const updated = db
      .prepare(
        `
          UPDATE connector_installations SET status = ?, updated_at = ?
          WHERE id = ? AND org_id = ?
        `,
      )
      .run(input.status, input.updated_at, input.id, input.org_id);
    return updated.changes === 1 ? findInstallation(db, input.id) : null;
  }

export async function updateInstallationConfig(db: Database.Database, input: SetConnectorInstallationConfig): Promise<ConnectorInstallation | null> {
    
    const updated = db
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
    return updated.changes === 1 ? findInstallation(db, input.id) : null;
  }

export async function deleteInstallation(db: Database.Database, id: string, orgId: string): Promise<boolean> {
    
    const removed = db.transaction(() => {
      const row = db
        .prepare(
          `SELECT id FROM connector_installations WHERE id = ? AND org_id = ?`,
        )
        .get(id, orgId) as { id: string } | undefined;
      if (!row) {
        return false;
      }
      db
        .prepare(
          `
            DELETE FROM ingest_quarantines
            WHERE attempt_id IN (
              SELECT id FROM ingest_attempts WHERE connector_installation_id = ?
            )
          `,
        )
        .run(id);
      db
        .prepare(`DELETE FROM ingest_attempts WHERE connector_installation_id = ?`)
        .run(id);
      db
        .prepare(`DELETE FROM connector_cursors WHERE installation_id = ?`)
        .run(id);
      db
        .prepare(`DELETE FROM connector_stream_members WHERE installation_id = ?`)
        .run(id);
      db
        .prepare(`DELETE FROM connector_catalog_cursors WHERE installation_id = ?`)
        .run(id);
      db
        .prepare(`DELETE FROM connector_sync_state WHERE installation_id = ?`)
        .run(id);
      db
        .prepare(`DELETE FROM connector_sync_work WHERE installation_id = ?`)
        .run(id);
      db
        .prepare(`DELETE FROM sync_runs WHERE installation_id = ?`)
        .run(id);
      db
        .prepare(`DELETE FROM connector_installations WHERE id = ? AND org_id = ?`)
        .run(id, orgId);
      return true;
    });
    return removed();
  }

export async function acquireLease(db: Database.Database, input: {
    installation_id: string;
    stream_key: string;
    lease_owner: string;
    now: string;
    lease_duration_ms: number;
    preempt?: boolean;
  }): Promise<ConnectorLease | null> {
    
    const transaction = db.transaction(() => {
      const installation = db
        .prepare(`SELECT status FROM connector_installations WHERE id = ?`)
        .get(input.installation_id) as
        | { status: ConnectorInstallation["status"] }
        | undefined;
      if (!installation || installation.status !== "enabled") {
        return null;
      }

      const current = findCursorRow(db, 
        input.installation_id,
        input.stream_key,
      );
      if (
        !input.preempt &&
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
        db
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
        db
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
      return toLease(db, 
        findCursorRow(db, input.installation_id, input.stream_key)!,
      );
    });
    return transaction.immediate();
  }

export async function releaseLease(db: Database.Database, input: ReleaseConnectorLease): Promise<boolean> {
    
    const released = db
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

export async function resetCursor(db: Database.Database, input: ResetConnectorCursor): Promise<ConnectorStreamCursor | null> {
    
    const transaction = db.transaction(() => {
      const cursor = findCursorRow(db, input.installation_id, input.stream_key);
      if (!cursor) {
        return null;
      }
      if (cursor.lease_expires_at && cursor.lease_expires_at > input.now) {
        throw new Error("Connector cursor is leased and cannot be reset");
      }
      db
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
      return toCursor(db, findCursorRow(db, input.installation_id, input.stream_key)!);
    });
    return transaction.immediate();
  }

export async function beginAttempt(db: Database.Database, input: NewIngestAttempt): Promise<IngestAttempt> {
    
    beginAttemptUnlocked(db, input);
    return findAttempt(db, input.id)!;
  }

export function commitSyncPageUnlocked(db: Database.Database, input: CommitSyncPage): CommitSyncPageResult {
    beginAttemptUnlocked(db, input.attempt);
    const events = input.ingest
      ? commitIngestUnlocked(db, input.ingest)
      : [];
    for (const pref of input.prefs ?? []) {
      putConversationPrefUnlocked(db, pref);
    }
    const attempt = settleAttemptUnlocked(db, input.settle);
    return { attempt, events };
  }

export async function settleAttempt(db: Database.Database, input: SettleIngestAttempt): Promise<IngestAttempt> {
    
    const transaction = db.transaction(() =>
      settleAttemptUnlocked(db, input),
    );
    return transaction.immediate();
  }

function beginAttemptUnlocked(db: Database.Database, input: NewIngestAttempt): void {
    db
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
  }

function settleAttemptUnlocked(db: Database.Database, input: SettleIngestAttempt): IngestAttempt {
    const cursor = findCursorRow(db, input.installation_id, input.stream_key);
    if (!cursor || cursor.lease_owner !== input.lease_owner) {
      throw new Error("Connector lease is not held by the attempt owner");
    }
    const status =
      input.retryable_failure_count === 0 ? "succeeded" : "failed";
    db
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
      db
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
    const updated = db
      .prepare(
        `
          UPDATE connector_cursors
          SET cursor_value = ?, cursor_version = ?, lease_owner = NULL,
              lease_expires_at = NULL, updated_at = ?
          WHERE installation_id = ? AND stream_key = ? AND lease_owner = ?
        `,
      )
      .run(
        advancesCursor ? input.next_cursor : cursor.cursor_value,
        advancesCursor ? cursor.cursor_version + 1 : cursor.cursor_version,
        input.finished_at,
        input.installation_id,
        input.stream_key,
        input.lease_owner,
      );
    if (updated.changes !== 1) {
      throw new Error("Connector lease is not held by the attempt owner");
    }
    return findAttempt(db, input.attempt_id)!;
  }

export async function listAttempts(db: Database.Database, installationId: string, limit?: number): Promise<IngestAttempt[]> {
    const cap =
      typeof limit === "number" && Number.isInteger(limit) && limit > 0
        ? limit
        : undefined;
    const rows = cap
      ? (db
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
      : (db
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
    return rows.map((row) => toAttempt(db, row));
  }

export async function latestAttempt(db: Database.Database, installationId: string): Promise<IngestAttempt | null> {
    const row = db
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
    return row ? toAttempt(db, row) : null;
  }

export async function pruneIngestAttempts(db: Database.Database, keepPerInstallation = 64, batchSize = 5_000, installationLimit = Number.POSITIVE_INFINITY): Promise<{ deleted: number }> {
    
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
    const installations = db
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
    const deleteQuarantines = db.prepare(
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
    const deleteAttempts = db.prepare(
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
      db
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

export async function listQuarantines(db: Database.Database, installationId: string): Promise<IngestQuarantine[]> {
    const rows = db
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
    return rows.map((row) => toQuarantine(db, row));
  }

export async function getCursor(db: Database.Database, installationId: string, streamKey: string): Promise<ConnectorStreamCursor | null> {
    const row = findCursorRow(db, installationId, streamKey);
    return row ? toCursor(db, row) : null;
  }

export async function listCursors(db: Database.Database, installationId: string, streamKeys?: readonly string[]): Promise<ConnectorStreamCursor[]> {
    const wanted = streamKeys ? new Set(streamKeys) : null;
    const rows = db
      .prepare(
        `
          SELECT installation_id, stream_key, cursor_value, cursor_version,
                 lease_owner, lease_expires_at, updated_at
          FROM connector_cursors
          WHERE installation_id = ?
          ORDER BY stream_key
        `,
      )
      .all(installationId) as CursorRow[];
    return rows
      .filter((row) => !wanted || wanted.has(row.stream_key))
      .map((row) => toCursor(db, row));
  }

export async function createSyncRun(db: Database.Database, input: NewSyncRun): Promise<SyncRun> {
    
    validateSyncRunOptions(input.options ?? {});
    const installation = db
      .prepare(
        `SELECT id FROM connector_installations WHERE id = ? AND org_id = ?`,
      )
      .get(input.installation_id, input.org_id);
    if (!installation) {
      throw new Error("Connector installation not found for sync run");
    }
    db
      .prepare(
        `
          INSERT INTO sync_runs (
            id, org_id, installation_id, mode, status, options_json,
            total_work, completed_work, failed_work, accepted_count,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'queued', ?, 0, 0, 0, 0, ?, ?)
        `,
      )
      .run(
        input.id,
        input.org_id,
        input.installation_id,
        input.mode,
        JSON.stringify(input.options ?? {}),
        input.now,
        input.now,
      );
    return findSyncRun(db, input.id)!;
  }

export async function getSyncRun(db: Database.Database, id: string, orgId: string): Promise<SyncRun | null> {
    const row = db
      .prepare(
        `
          SELECT id, org_id, installation_id, mode, status, options_json,
                 total_work, completed_work, failed_work, accepted_count,
                 started_at, finished_at, last_error, created_at, updated_at
          FROM sync_runs WHERE id = ? AND org_id = ?
        `,
      )
      .get(id, orgId) as SyncRunRow | undefined;
    return row ? toSyncRun(db, row) : null;
  }

export async function listSyncRuns(db: Database.Database, query: ListSyncRunsQuery): Promise<SyncRun[]> {
    const limit =
      Number.isInteger(query.limit) && Number(query.limit) > 0
        ? Math.min(Number(query.limit), 1_000)
        : 100;
    const rows = query.installation_id
      ? (db
          .prepare(
            `
              SELECT id, org_id, installation_id, mode, status, options_json,
                     total_work, completed_work, failed_work, accepted_count,
                     started_at, finished_at, last_error, created_at, updated_at
              FROM sync_runs
              WHERE org_id = ? AND installation_id = ?
              ORDER BY created_at DESC, id DESC LIMIT ?
            `,
          )
          .all(query.org_id, query.installation_id, limit) as SyncRunRow[])
      : (db
          .prepare(
            `
              SELECT id, org_id, installation_id, mode, status, options_json,
                     total_work, completed_work, failed_work, accepted_count,
                     started_at, finished_at, last_error, created_at, updated_at
              FROM sync_runs
              WHERE org_id = ?
              ORDER BY created_at DESC, id DESC LIMIT ?
            `,
          )
          .all(query.org_id, limit) as SyncRunRow[]);
    return rows.map((row) => toSyncRun(db, row));
  }

export async function commandSyncRun(db: Database.Database, input: CommandSyncRun): Promise<SyncRun | null> {
    
    const command = db.transaction(() => {
      const current = db
        .prepare(`SELECT status FROM sync_runs WHERE id = ? AND org_id = ?`)
        .get(input.id, input.org_id) as
        | { status: SyncRun["status"] }
        | undefined;
      if (!current) {
        return null;
      }
      if (
        input.command === "pause" &&
        (current.status === "queued" || current.status === "running")
      ) {
        db
          .prepare(
            `UPDATE sync_runs SET status = 'paused', updated_at = ? WHERE id = ?`,
          )
          .run(input.now, input.id);
      } else if (
        input.command === "resume" &&
        current.status === "paused"
      ) {
        db
          .prepare(
            `
              UPDATE sync_runs
              SET status = 'queued', finished_at = NULL, updated_at = ?
              WHERE id = ?
            `,
          )
          .run(input.now, input.id);
      } else if (
        input.command === "cancel" &&
        (current.status === "queued" ||
          current.status === "running" ||
          current.status === "paused")
      ) {
        db
          .prepare(
            `
              UPDATE sync_runs
              SET status = 'cancelled', finished_at = ?, updated_at = ?
              WHERE id = ?
            `,
          )
          .run(input.now, input.now, input.id);
        db
          .prepare(
            `
              UPDATE connector_sync_work
              SET status = 'cancelled', lease_owner = NULL,
                  lease_expires_at = NULL, updated_at = ?
              WHERE run_id = ? AND status IN ('pending', 'running')
            `,
          )
          .run(input.now, input.id);
      }
      return findSyncRun(db, input.id);
    });
    return command.immediate();
  }

export async function enqueueSyncWork(db: Database.Database, input: EnqueueSyncWork): Promise<SyncWorkRecord> {
    
    const enqueue = db.transaction(() =>
      enqueueSyncWorkUnlocked(db, input),
    );
    return enqueue.immediate();
  }

export async function enqueueSyncWorkMany(db: Database.Database, inputs: readonly EnqueueSyncWork[]): Promise<number> {
    
    if (inputs.length === 0) {
      return 0;
    }
    const enqueue = db.transaction(() => {
      const lookup = db.prepare(
        `
          SELECT id, status FROM connector_sync_work
          WHERE installation_id = ? AND stream_key = ?
            AND lane = ? AND generation = ?
        `,
      );
      const update = db.prepare(
        `
          UPDATE connector_sync_work
          SET run_id = COALESCE(?, run_id), priority = ?,
              next_due_at = ?, status = 'pending',
              lease_owner = NULL, lease_expires_at = NULL,
              last_error = NULL, updated_at = ?
          WHERE id = ?
        `,
      );
      const insert = db.prepare(
        `
          INSERT INTO connector_sync_work (
            id, run_id, installation_id, stream_key, lane, priority,
            next_due_at, status, attempts, generation, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        `,
      );
      const bumpRun = db.prepare(
        `
          UPDATE sync_runs
          SET total_work = total_work + 1, updated_at = ?
          WHERE id = ?
        `,
      );
      for (const input of inputs) {
        const current = lookup.get(
          input.installation_id,
          input.stream_key,
          input.lane,
          input.generation,
        ) as { id: string; status: string } | undefined;
        if (current) {
          if (current.status !== "running") {
            update.run(
              input.run_id ?? null,
              input.priority ?? syncWorkPriority(input.lane),
              input.next_due_at,
              input.now,
              current.id,
            );
          }
          continue;
        }
        if (input.run_id && !findSyncRun(db, input.run_id)) {
          throw new Error(`Sync run not found: ${input.run_id}`);
        }
        insert.run(
          input.id,
          input.run_id ?? null,
          input.installation_id,
          input.stream_key,
          input.lane,
          input.priority ?? syncWorkPriority(input.lane),
          input.next_due_at,
          input.generation,
          input.now,
          input.now,
        );
        if (input.run_id) {
          bumpRun.run(input.now, input.run_id);
        }
      }
      return inputs.length;
    });
    return enqueue.immediate();
  }

function enqueueSyncWorkUnlocked(db: Database.Database, input: EnqueueSyncWork): SyncWorkRecord {
    const current = findSyncWorkByIdentity(db, input);
    if (current) {
      if (current.status !== "running") {
        db
          .prepare(
            `
              UPDATE connector_sync_work
              SET run_id = COALESCE(?, run_id), priority = ?,
                  next_due_at = ?, status = 'pending',
                  lease_owner = NULL, lease_expires_at = NULL,
                  last_error = NULL, updated_at = ?
              WHERE id = ?
            `,
          )
          .run(
            input.run_id ?? null,
            input.priority ?? syncWorkPriority(input.lane),
            input.next_due_at,
            input.now,
            current.id,
          );
      }
      return findSyncWork(db, current.id)!;
    }
    if (input.run_id && !findSyncRun(db, input.run_id)) {
      throw new Error(`Sync run not found: ${input.run_id}`);
    }
    db
      .prepare(
        `
          INSERT INTO connector_sync_work (
            id, run_id, installation_id, stream_key, lane, priority,
            next_due_at, status, attempts, generation, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
        `,
      )
      .run(
        input.id,
        input.run_id ?? null,
        input.installation_id,
        input.stream_key,
        input.lane,
        input.priority ?? syncWorkPriority(input.lane),
        input.next_due_at,
        input.generation,
        input.now,
        input.now,
      );
    if (input.run_id) {
      db
        .prepare(
          `
            UPDATE sync_runs
            SET total_work = total_work + 1, updated_at = ?
            WHERE id = ?
          `,
        )
        .run(input.now, input.run_id);
    }
    return findSyncWork(db, input.id)!;
  }

export async function claimSyncWork(db: Database.Database, input: ClaimSyncWork): Promise<SyncWorkRecord[]> {
    
    if (!Number.isInteger(input.limit) || input.limit < 1) {
      return [];
    }
    const claim = db.transaction(() => {
      const clauses = [
        `(
          (w.status = 'pending' AND w.next_due_at <= ?)
          OR
          (w.status = 'running' AND w.lease_expires_at <= ?)
        )`,
        `(w.run_id IS NULL OR r.status IN ('queued', 'running'))`,
      ];
      const params: unknown[] = [input.now, input.now];
      if (input.work_id) {
        clauses.push(`w.id = ?`);
        params.push(input.work_id);
      }
      if (input.installation_id) {
        clauses.push(`w.installation_id = ?`);
        params.push(input.installation_id);
      }
      if (input.lanes?.length) {
        clauses.push(
          `w.lane IN (${input.lanes.map(() => "?").join(", ")})`,
        );
        params.push(...input.lanes);
      }
      if (input.unassigned) {
        clauses.push(`w.run_id IS NULL`);
      }
      params.push(Math.min(input.limit, 1_000));
      const ids = db
        .prepare(
          `
            SELECT w.id
            FROM connector_sync_work w
            LEFT JOIN sync_runs r ON r.id = w.run_id
            WHERE ${clauses.join(" AND ")}
            ORDER BY w.priority DESC, w.next_due_at, w.created_at, w.id
            LIMIT ?
          `,
        )
        .all(...params) as Array<{ id: string }>;
      if (ids.length === 0) {
        return [];
      }
      const leaseExpiresAt = new Date(
        Date.parse(input.now) + input.lease_ms,
      ).toISOString();
      const update = db.prepare(
        `
          UPDATE connector_sync_work
          SET status = 'running', attempts = attempts + 1,
              lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ?
        `,
      );
      for (const { id } of ids) {
        update.run(input.owner, leaseExpiresAt, input.now, id);
      }
      db
        .prepare(
          `
            UPDATE sync_runs
            SET status = 'running',
                started_at = COALESCE(started_at, ?),
                updated_at = ?
            WHERE status = 'queued'
              AND id IN (
                SELECT DISTINCT run_id FROM connector_sync_work
                WHERE id IN (${ids.map(() => "?").join(", ")})
                  AND run_id IS NOT NULL
              )
          `,
        )
        .run(input.now, input.now, ...ids.map((item) => item.id));
      return ids.map(({ id }) => findSyncWork(db, id)!);
    });
    return claim.immediate();
  }

export async function renewSyncWork(db: Database.Database, input: RenewSyncWork): Promise<boolean> {
    
    const leaseExpiresAt = new Date(
      Date.parse(input.now) + input.lease_ms,
    ).toISOString();
    const result = db
      .prepare(
        `
          UPDATE connector_sync_work
          SET lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND status = 'running' AND lease_owner = ?
            AND lease_expires_at > ?
        `,
      )
      .run(
        leaseExpiresAt,
        input.now,
        input.id,
        input.owner,
        input.now,
      );
    return result.changes === 1;
  }

export async function settleSyncWork(db: Database.Database, input: SettleSyncWork): Promise<SyncWorkRecord | null> {
    
    const settle = db.transaction(() => {
      const current = findSyncWork(db, input.id);
      if (
        !current ||
        current.status !== "running" ||
        current.lease_owner !== input.owner
      ) {
        return null;
      }
      const status =
        input.outcome === "retry" ? "pending" : input.outcome;
      db
        .prepare(
          `
            UPDATE connector_sync_work
            SET status = ?, next_due_at = ?, lease_owner = NULL,
                lease_expires_at = NULL, last_error = ?, updated_at = ?
            WHERE id = ? AND status = 'running' AND lease_owner = ?
          `,
        )
        .run(
          status,
          input.next_due_at ?? current.next_due_at,
          input.error_code ?? null,
          input.now,
          input.id,
          input.owner,
        );
      if (current.run_id && input.outcome !== "retry") {
        const completed = input.outcome === "succeeded" ? 1 : 0;
        const failed = input.outcome === "failed" ? 1 : 0;
        db
          .prepare(
            `
              UPDATE sync_runs
              SET completed_work = completed_work + ?,
                  failed_work = failed_work + ?,
                  accepted_count = accepted_count + ?,
                  last_error = COALESCE(?, last_error),
                  updated_at = ?
              WHERE id = ? AND status != 'cancelled'
            `,
          )
          .run(
            completed,
            failed,
            Math.max(0, input.accepted_count ?? 0),
            input.error_code ?? null,
            input.now,
            current.run_id,
          );
        const remaining = db
          .prepare(
            `
              SELECT 1 FROM connector_sync_work
              WHERE run_id = ? AND status IN ('pending', 'running')
              LIMIT 1
            `,
          )
          .get(current.run_id);
        if (!remaining) {
          db
            .prepare(
              `
                UPDATE sync_runs
                SET status = CASE
                      WHEN failed_work > 0 THEN 'failed'
                      ELSE 'succeeded'
                    END,
                    finished_at = ?, updated_at = ?
                WHERE id = ? AND status NOT IN ('paused', 'cancelled')
              `,
            )
            .run(input.now, input.now, current.run_id);
        }
      }
      return findSyncWork(db, input.id);
    });
    return settle.immediate();
  }

export async function hasUnassignedSyncWork(db: Database.Database, query: UnassignedSyncWorkQuery = {}): Promise<boolean> {
    const { sql, params } = unassignedSyncWorkWhere(query, "?");
    const row = db
      .prepare(
        `SELECT 1 AS found FROM connector_sync_work WHERE ${sql} LIMIT 1`,
      )
      .get(...params) as { found: number } | undefined;
    return Boolean(row);
  }

export async function listUnassignedSyncWorkIdentities(db: Database.Database, query: {
    installation_id: string;
  }): Promise<SyncWorkIdentity[]> {
    const { sql, params } = unassignedSyncWorkWhere(
      { installation_id: query.installation_id },
      "?",
    );
    return (
      db
        .prepare(
          `
            SELECT stream_key, lane, generation
            FROM connector_sync_work
            WHERE ${sql}
          `,
        )
        .all(...params) as SyncWorkIdentity[]
    ).map((row) => ({
      stream_key: row.stream_key,
      lane: row.lane,
      generation: row.generation,
    }));
  }

export async function wakeUnassignedSyncWork(db: Database.Database, input: WakeUnassignedSyncWork): Promise<number> {
    
    const streamKeys = uniqueStreamKeys(input.stream_keys);
    if (streamKeys.length === 0) {
      return 0;
    }
    const placeholders = streamKeys.map(() => "?").join(", ");
    const result = db
      .prepare(
        `
          UPDATE connector_sync_work
          SET next_due_at = ?, updated_at = ?
          WHERE installation_id = ?
            AND run_id IS NULL
            AND status = 'pending'
            AND stream_key IN (${placeholders})
        `,
      )
      .run(input.now, input.now, input.installation_id, ...streamKeys);
    return result.changes;
  }

export async function getSyncCatalog(db: Database.Database, installationId: string): Promise<SyncCatalogView> {
    return loadSyncCatalog(db, installationId);
  }

export async function getSyncCatalogHead(db: Database.Database, installationId: string): Promise<SyncCatalogHead> {
    const count = db
      .prepare(
        `
          SELECT COUNT(*) AS n
          FROM connector_stream_members
          WHERE installation_id = ? AND stream_key != ?
        `,
      )
      .get(installationId, SYNC_CATALOG_STREAM) as { n: number };
    const cursor = db
      .prepare(
        `
          SELECT complete, generation, updated_at
          FROM connector_catalog_cursors
          WHERE installation_id = ?
        `,
      )
      .get(installationId) as
      | { complete: number; generation: number; updated_at: string }
      | undefined;
    return {
      member_count: Number(count.n),
      has_cursor: cursor != null,
      complete: cursor?.complete === 1,
      generation: cursor?.generation ?? 1,
      ...(cursor ? { updated_at: cursor.updated_at } : {}),
    };
  }

export async function applySyncCatalogPage(db: Database.Database, input: ApplySyncCatalogPageInput): Promise<SyncCatalogView> {
    
    const apply = db.transaction(() => {
      const current = loadSyncCatalog(db, input.installation_id);
      const next = applySyncCatalogMembers(current, input);
      db
        .prepare(`DELETE FROM connector_stream_members WHERE installation_id = ?`)
        .run(input.installation_id);
      const insert = db.prepare(
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
        db
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
      if (input.complete) {
        dropStreamsLeftCatalog(db, 
          input.installation_id,
          catalogStreamKeysLeft(current, next),
          input.now,
        );
      }
      return next;
    });
    return apply.immediate();
  }

export async function listSyncPhaseHeads(db: Database.Database, installationId: string): Promise<SyncPhaseHead[]> {
    const rows = db
      .prepare(
        `
          SELECT stream_key, phase, media_pending, generation, idle_until
          FROM connector_sync_state
          WHERE installation_id = ?
        `,
      )
      .all(installationId) as Array<{
      stream_key: string;
      phase: SyncPhase;
      media_pending: number;
      generation: number;
      idle_until: string | null;
    }>;
    return rows.map((row) => ({
      stream_key: row.stream_key,
      phase: row.phase,
      media_pending: row.media_pending !== 0,
      generation: row.generation,
      idle_until: row.idle_until ?? undefined,
    }));
  }

export async function listSyncStates(db: Database.Database, installationId: string): Promise<SyncStreamState[]> {
    const rows = db
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
    return rows.map((row) => toSyncState(db, row));
  }

export async function getSyncState(db: Database.Database, installationId: string, streamKey: string): Promise<SyncStreamState | null> {
    const row = db
      .prepare(
        `
          SELECT installation_id, stream_key, phase, live_cursor, history_cursor,
                 media_pending, idle_until, generation, updated_at
          FROM connector_sync_state
          WHERE installation_id = ? AND stream_key = ?
        `,
      )
      .get(installationId, streamKey) as SyncStateRow | undefined;
    return row ? toSyncState(db, row) : null;
  }

export async function putSyncState(db: Database.Database, state: SyncStreamState): Promise<SyncStreamState> {
    
    const write = db.transaction(() => {
      if (
        streamOutsideCompleteCatalog(db, 
          state.installation_id,
          state.stream_key,
        )
      ) {
        dropStreamsLeftCatalog(db, 
          state.installation_id,
          [state.stream_key],
          state.updated_at,
        );
        return;
      }
      db
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
      ensureOwedSyncWorkUnlocked(db, state);
    });
    write.immediate();
    return { ...state };
  }

function streamOutsideCompleteCatalog(db: Database.Database, installationId: string, streamKey: string): boolean {
    const cursor = db
      .prepare(
        `
          SELECT complete
          FROM connector_catalog_cursors
          WHERE installation_id = ?
        `,
      )
      .get(installationId) as { complete: number } | undefined;
    if (!cursor || cursor.complete !== 1) {
      return false;
    }
    const member = db
      .prepare(
        `
          SELECT 1 AS found
          FROM connector_stream_members
          WHERE installation_id = ? AND stream_key = ?
        `,
      )
      .get(installationId, streamKey) as { found: number } | undefined;
    return !member;
  }

function dropStreamsLeftCatalog(db: Database.Database, installationId: string, streamKeys: readonly string[], now: string): void {
    for (let offset = 0; offset < streamKeys.length; offset += 200) {
      const chunk = streamKeys.slice(offset, offset + 200);
      const marks = chunk.map(() => "?").join(", ");
      db
        .prepare(
          `
            DELETE FROM connector_sync_state
            WHERE installation_id = ? AND stream_key IN (${marks})
          `,
        )
        .run(installationId, ...chunk);
      db
        .prepare(
          `
            UPDATE connector_sync_work
            SET status = 'cancelled',
                lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = ?
            WHERE installation_id = ?
              AND run_id IS NULL
              AND status IN ('pending', 'running')
              AND stream_key IN (${marks})
          `,
        )
        .run(now, installationId, ...chunk);
    }
  }

function ensureOwedSyncWorkUnlocked(db: Database.Database, state: SyncStreamState): void {
    const existing = db
      .prepare(
        `
          SELECT lane, status, run_id
          FROM connector_sync_work
          WHERE installation_id = ? AND stream_key = ? AND generation = ?
        `,
      )
      .all(state.installation_id, state.stream_key, state.generation) as Array<{
      lane: SyncWorkGap["missing_lane"];
      status: "pending" | "running" | "succeeded" | "failed" | "cancelled";
      run_id: string | null;
    }>;
    const plan = syncWorkEnsurePlan({ state, existing });
    for (const lane of plan.enqueue) {
      enqueueSyncWorkUnlocked(db, {
        id: dueSyncWorkId(
          state.installation_id,
          state.stream_key,
          lane,
          state.generation,
        ),
        installation_id: state.installation_id,
        stream_key: state.stream_key,
        lane,
        next_due_at: state.updated_at,
        generation: state.generation,
        now: state.updated_at,
      });
    }
    const cancel = db.prepare(
      `
        UPDATE connector_sync_work
        SET status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = ?
        WHERE installation_id = ? AND stream_key = ? AND generation = ?
          AND lane = ? AND run_id IS NULL AND status = 'pending'
      `,
    );
    for (const lane of plan.cancel) {
      cancel.run(
        state.updated_at,
        state.installation_id,
        state.stream_key,
        state.generation,
        lane,
      );
    }
  }

function loadSyncCatalog(db: Database.Database, installationId: string): SyncCatalogView {
    const members = (
      db
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
    ).map((row) => toStreamMember(db, row));
    const snapshot = db
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
      catalog: snapshot ? toCatalogSnapshot(db, snapshot) : null,
    };
  }

function toStreamMember(db: Database.Database, row: StreamMemberRow): SyncCatalogMember {
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

function toSyncState(db: Database.Database, row: SyncStateRow): SyncStreamState {
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

function findSyncRun(db: Database.Database, id: string): SyncRun | null {
    const row = db
      .prepare(
        `
          SELECT id, org_id, installation_id, mode, status, options_json,
                 total_work, completed_work, failed_work, accepted_count,
                 started_at, finished_at, last_error, created_at, updated_at
          FROM sync_runs WHERE id = ?
        `,
      )
      .get(id) as SyncRunRow | undefined;
    return row ? toSyncRun(db, row) : null;
  }

function findSyncWork(db: Database.Database, id: string): SyncWorkRecord | null {
    const row = db
      .prepare(
        `
          SELECT id, run_id, installation_id, stream_key, lane, priority,
                 next_due_at, status, attempts, generation, lease_owner,
                 lease_expires_at, last_error, created_at, updated_at
          FROM connector_sync_work WHERE id = ?
        `,
      )
      .get(id) as SyncWorkRow | undefined;
    return row ? toSyncWork(db, row) : null;
  }

function findSyncWorkByIdentity(db: Database.Database, input: Pick<
      EnqueueSyncWork,
      "installation_id" | "stream_key" | "lane" | "generation"
    >): SyncWorkRecord | null {
    const row = db
      .prepare(
        `
          SELECT id, run_id, installation_id, stream_key, lane, priority,
                 next_due_at, status, attempts, generation, lease_owner,
                 lease_expires_at, last_error, created_at, updated_at
          FROM connector_sync_work
          WHERE installation_id = ? AND stream_key = ?
            AND lane = ? AND generation = ?
        `,
      )
      .get(
        input.installation_id,
        input.stream_key,
        input.lane,
        input.generation,
      ) as SyncWorkRow | undefined;
    return row ? toSyncWork(db, row) : null;
  }

function toSyncRun(db: Database.Database, row: SyncRunRow): SyncRun {
    return {
      id: row.id,
      org_id: row.org_id,
      installation_id: row.installation_id,
      mode: row.mode,
      status: row.status,
      options: JSON.parse(row.options_json) as SyncRun["options"],
      total_work: row.total_work,
      completed_work: row.completed_work,
      failed_work: row.failed_work,
      accepted_count: row.accepted_count,
      ...(row.started_at ? { started_at: row.started_at } : {}),
      ...(row.finished_at ? { finished_at: row.finished_at } : {}),
      ...(row.last_error ? { last_error: row.last_error } : {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

function toSyncWork(db: Database.Database, row: SyncWorkRow): SyncWorkRecord {
    return {
      id: row.id,
      ...(row.run_id ? { run_id: row.run_id } : {}),
      installation_id: row.installation_id,
      stream_key: row.stream_key,
      lane: row.lane,
      priority: row.priority,
      next_due_at: row.next_due_at,
      status: row.status,
      attempts: row.attempts,
      generation: row.generation,
      ...(row.lease_owner ? { lease_owner: row.lease_owner } : {}),
      ...(row.lease_expires_at
        ? { lease_expires_at: row.lease_expires_at }
        : {}),
      ...(row.last_error ? { last_error: row.last_error } : {}),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

function findCursorRow(db: Database.Database, installationId: string, streamKey: string): CursorRow | null {
    return (
      (db
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

function findAttempt(db: Database.Database, id: string): IngestAttempt | null {
    const row = db
      .prepare(
        `
          SELECT id, org_id, connector_installation_id, stream_key, delivery_id,
                 started_at, finished_at, status, accepted_count, duplicate_count,
                 quarantined_count, retryable_failure_count, error_code
          FROM ingest_attempts WHERE id = ?
        `,
      )
      .get(id) as AttemptRow | undefined;
    return row ? toAttempt(db, row) : null;
  }

function toInstallation(db: Database.Database, row: InstallationRow): ConnectorInstallation {
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

function toCursor(db: Database.Database, row: CursorRow): ConnectorStreamCursor {
    return {
      installation_id: row.installation_id,
      stream_key: row.stream_key,
      cursor: row.cursor_value ?? undefined,
      cursor_version: row.cursor_version,
      updated_at: row.updated_at,
    };
  }

function toLease(db: Database.Database, row: CursorRow): ConnectorLease {
    return {
      ...toCursor(db, row),
      lease_owner: row.lease_owner!,
      lease_expires_at: row.lease_expires_at!,
    };
  }

function toAttempt(db: Database.Database, row: AttemptRow): IngestAttempt {
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

function toQuarantine(db: Database.Database, row: QuarantineRow): IngestQuarantine {
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

function unassignedSyncWorkWhere(
  query: UnassignedSyncWorkQuery,
  _placeholder: "?",
): { sql: string; params: unknown[] } {
  const clauses = ["run_id IS NULL", "status IN ('pending', 'running')"];
  const params: unknown[] = [];
  if (query.installation_id) {
    clauses.push("installation_id = ?");
    params.push(query.installation_id);
  }
  if (query.lanes?.length) {
    clauses.push(`lane IN (${query.lanes.map(() => "?").join(", ")})`);
    params.push(...query.lanes);
  }
  return { sql: clauses.join(" AND "), params };
}

function uniqueStreamKeys(keys: readonly string[]): string[] {
  return [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
}
