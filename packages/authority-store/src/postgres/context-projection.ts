import type {
  ContextProjectionJob,
  ClaimContextProjectionJobs,
  CompleteContextProjectionJob,
  RenewContextProjectionJob,
  FailContextProjectionJob,
} from "@regenic/domain";
import {
  PgSql,
  asNumber,
  toIso,
} from "./sql";

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

export async function claimContextProjectionJobs(db: PgSql, input: ClaimContextProjectionJobs): Promise<ContextProjectionJob[]> {
    assertProjectionClaim(input);
    return db.withTx(async (client) => {
      const rows = await db.query<{ id: string }>(
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
      await db.execute(
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
      const jobs = await db.query<ContextProjectionJobRow>(
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

export async function completeContextProjectionJob(db: PgSql, input: CompleteContextProjectionJob): Promise<boolean> {
    assertProjectionSettle(input.id, input.owner, input.completed_at);
    const rowCount = await db.execute(
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

export async function renewContextProjectionJob(db: PgSql, input: RenewContextProjectionJob): Promise<boolean> {
    assertProjectionSettle(input.id, input.owner, input.now);
    if (!Number.isSafeInteger(input.lease_ms) || input.lease_ms < 1) throw new Error("Invalid Context projection lease renewal");
    return await db.execute(
      `UPDATE context_projection_outbox SET lease_expires_at = $1, updated_at = $2 WHERE id = $3 AND status = 'running' AND lease_owner = $4 AND lease_expires_at > $2::timestamptz`,
      [new Date(Date.parse(input.now) + input.lease_ms).toISOString(), input.now, input.id, input.owner],
    ) === 1;
  }

export async function failContextProjectionJob(db: PgSql, input: FailContextProjectionJob): Promise<boolean> {
    assertProjectionSettle(input.id, input.owner, input.failed_at);
    if (Number.isNaN(Date.parse(input.next_retry_at)) || !input.error_code.trim()) {
      throw new Error("Invalid Context projection failure");
    }
    const rowCount = await db.execute(
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

export async function listContextProjectionJobs(db: PgSql, orgId: string): Promise<ContextProjectionJob[]> {
    const rows = await db.query<ContextProjectionJobRow>(
      `
        SELECT id, org_id, event_id, status, attempts, lease_owner,
               lease_expires_at, next_retry_at, last_error, created_at, updated_at
        FROM context_projection_outbox WHERE org_id = $1 ORDER BY created_at, id
      `,
      [orgId],
    );
    return rows.map(toContextProjectionJob);
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
