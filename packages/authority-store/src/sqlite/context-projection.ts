import type {
  ContextProjectionJob,
  ClaimContextProjectionJobs,
  CompleteContextProjectionJob,
  RenewContextProjectionJob,
  FailContextProjectionJob,
} from "@regenic/domain";
import Database from "better-sqlite3";

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

export async function claimContextProjectionJobs(db: Database.Database, input: ClaimContextProjectionJobs): Promise<ContextProjectionJob[]> {
    
    assertProjectionClaim(input);
    return db.transaction(() => {
      const rows = db.prepare(
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
        db.prepare(
          `
            UPDATE context_projection_outbox
            SET status = 'running', attempts = attempts + 1,
                lease_owner = ?, lease_expires_at = ?, next_retry_at = NULL,
                last_error = NULL, updated_at = ?
            WHERE id = ?
          `,
        ).run(input.owner, leaseExpiresAt, input.now, row.id);
      }
      return rows.map((row) => getContextProjectionJob(db, row.id)!);
    }).immediate();
  }

export async function completeContextProjectionJob(db: Database.Database, input: CompleteContextProjectionJob): Promise<boolean> {
    
    assertProjectionSettle(input.id, input.owner, input.completed_at);
    return db.prepare(
      `
        UPDATE context_projection_outbox
        SET status = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
            next_retry_at = NULL, last_error = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
          AND lease_expires_at > ?
      `,
    ).run(input.completed_at, input.id, input.owner, input.completed_at).changes === 1;
  }

export async function renewContextProjectionJob(db: Database.Database, input: RenewContextProjectionJob): Promise<boolean> {
    
    assertProjectionSettle(input.id, input.owner, input.now);
    if (!Number.isSafeInteger(input.lease_ms) || input.lease_ms < 1) {
      throw new Error("Invalid Context projection lease renewal");
    }
    const leaseExpiresAt = new Date(Date.parse(input.now) + input.lease_ms).toISOString();
    return db.prepare(
      `
        UPDATE context_projection_outbox
        SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
          AND lease_expires_at > ?
      `,
    ).run(leaseExpiresAt, input.now, input.id, input.owner, input.now).changes === 1;
  }

export async function failContextProjectionJob(db: Database.Database, input: FailContextProjectionJob): Promise<boolean> {
    
    assertProjectionSettle(input.id, input.owner, input.failed_at);
    if (Number.isNaN(Date.parse(input.next_retry_at)) || !input.error_code.trim()) {
      throw new Error("Invalid Context projection failure");
    }
    return db.prepare(
      `
        UPDATE context_projection_outbox
        SET status = 'failed', lease_owner = NULL, lease_expires_at = NULL,
            next_retry_at = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
          AND lease_expires_at > ?
      `,
    ).run(
      input.next_retry_at,
      input.error_code.slice(0, 120),
      input.failed_at,
      input.id,
      input.owner,
      input.failed_at,
    ).changes === 1;
  }

export async function listContextProjectionJobs(db: Database.Database, orgId: string): Promise<ContextProjectionJob[]> {
    return (db.prepare(
      `
        SELECT id, org_id, event_id, status, attempts, lease_owner,
               lease_expires_at, next_retry_at, last_error, created_at, updated_at
        FROM context_projection_outbox WHERE org_id = ? ORDER BY created_at, id
      `,
    ).all(orgId) as ContextProjectionJobRow[]).map(toContextProjectionJob);
  }

function getContextProjectionJob(db: Database.Database, id: string): ContextProjectionJob | null {
    const row = db.prepare(
      `
        SELECT id, org_id, event_id, status, attempts, lease_owner,
               lease_expires_at, next_retry_at, last_error, created_at, updated_at
        FROM context_projection_outbox WHERE id = ?
      `,
    ).get(id) as ContextProjectionJobRow | undefined;
    return row ? toContextProjectionJob(row) : null;
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

export function assertProjectionClaim(input: ClaimContextProjectionJobs): void {
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

export function assertProjectionSettle(id: string, owner: string, at: string): void {
  if (!id?.trim() || !owner?.trim() || Number.isNaN(Date.parse(at))) {
    throw new Error("Invalid Context projection settlement");
  }
}
