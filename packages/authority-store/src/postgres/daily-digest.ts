import type {
  DailyDigestJob,
  DailyDigestCoverageAlert,
  DailyDigestPolicy,
} from "@regenic/domain";
import {
  hashCanonicalContext,
  validateDailyDigestPolicy,
  canonicalContextJson,
} from "@regenic/domain";
import {
  PgSql,
  asNumber,
  toIso,
} from "./sql";
import {
  assertProjectionClaim,
  assertProjectionSettle,
} from "./context-projection";

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

export async function enqueueDailyDigestCatchUp(db: PgSql, input: {
    org_id: string;
    through_utc_date: string;
    generation: string;
    created_at: string;
    max_days: number;
  }): Promise<DailyDigestJob[]> {
    assertDailyDigestCatchUp(input);
    return db.withTx(async (client) => {
      await db.query(
        `SELECT pg_advisory_xact_lock(hashtext($1))`,
        [`daily-digest:${input.org_id}:${input.generation}`],
        client,
      );
      const cursor = await db.queryOne<{ last_scheduled_utc_date: string }>(
        `SELECT last_scheduled_utc_date FROM daily_digest_schedule_cursors
         WHERE org_id = $1 AND generation = $2`,
        [input.org_id, input.generation],
        client,
      );
      const dates = catchUpDates(cursor?.last_scheduled_utc_date, input.through_utc_date, input.max_days);
      const ids: string[] = [];
      for (const utcDate of dates) {
        const id = `daily-digest-job:${hashCanonicalContext([input.org_id, utcDate, input.generation])}`;
        await db.execute(
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
        await db.execute(
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
      const rows = await db.query<DailyDigestJobRow>(
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

export async function enqueueDailyDigestJob(db: PgSql, input: {
    org_id: string; utc_date: string; generation: string; created_at: string;
  }): Promise<DailyDigestJob> {
    assertDailyDigestEnqueue(input);
    const id = `daily-digest-job:${hashCanonicalContext([input.org_id, input.utc_date, input.generation])}`;
    await db.execute(
      `INSERT INTO daily_digest_jobs (
        id, org_id, utc_date, generation, status, attempts, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'pending', 0, $5, $5)
      ON CONFLICT (org_id, utc_date, generation) DO NOTHING`,
      [id, input.org_id, input.utc_date, input.generation, input.created_at],
    );
    const row = await db.queryOne<DailyDigestJobRow>(
      `SELECT id, org_id, utc_date, generation, status, attempts, lease_owner,
       lease_expires_at, next_retry_at, last_error, created_at, updated_at
       FROM daily_digest_jobs WHERE id = $1`, [id],
    );
    return toDailyDigestJob(row!);
  }

export async function claimDailyDigestJobs(db: PgSql, input: {
    owner: string; now: string; lease_ms: number; limit: number;
  }): Promise<DailyDigestJob[]> {
    assertProjectionClaim(input);
    return db.withTx(async (client) => {
      const rows = await db.query<{ id: string }>(
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
      await db.execute(
        `UPDATE daily_digest_jobs SET status = 'running', attempts = attempts + 1,
         lease_owner = $1, lease_expires_at = $2, next_retry_at = NULL,
         last_error = NULL, updated_at = $3 WHERE id = ANY($4::text[])`,
        [input.owner, expiresAt, input.now, ids], client,
      );
      const claimed = await db.query<DailyDigestJobRow>(
        `SELECT id, org_id, utc_date, generation, status, attempts, lease_owner,
         lease_expires_at, next_retry_at, last_error, created_at, updated_at
         FROM daily_digest_jobs WHERE id = ANY($1::text[])`, [ids], client,
      );
      const byId = new Map(claimed.map((row) => [row.id, toDailyDigestJob(row)] as const));
      return ids.map((id) => byId.get(id)!);
    });
  }

export async function completeDailyDigestJob(db: PgSql, input: { id: string; owner: string; completed_at: string }): Promise<boolean> {
    assertProjectionSettle(input.id, input.owner, input.completed_at);
    return await db.execute(
      `UPDATE daily_digest_jobs SET status = 'succeeded', lease_owner = NULL,
       lease_expires_at = NULL, next_retry_at = NULL, last_error = NULL, updated_at = $1
       WHERE id = $2 AND status = 'running' AND lease_owner = $3 AND lease_expires_at > $1::timestamptz`,
      [input.completed_at, input.id, input.owner],
    ) === 1;
  }

export async function renewDailyDigestJob(db: PgSql, input: { id: string; owner: string; now: string; lease_ms: number }): Promise<boolean> {
    assertProjectionSettle(input.id, input.owner, input.now);
    if (!Number.isSafeInteger(input.lease_ms) || input.lease_ms < 1) throw new Error("Invalid daily digest lease renewal");
    return await db.execute(
      `UPDATE daily_digest_jobs SET lease_expires_at = $1, updated_at = $2
       WHERE id = $3 AND status = 'running' AND lease_owner = $4 AND lease_expires_at > $2::timestamptz`,
      [new Date(Date.parse(input.now) + input.lease_ms).toISOString(), input.now, input.id, input.owner],
    ) === 1;
  }

export async function failDailyDigestJob(db: PgSql, input: {
    id: string; owner: string; failed_at: string; next_retry_at: string; error_code: string;
  }): Promise<boolean> {
    assertProjectionSettle(input.id, input.owner, input.failed_at);
    if (Number.isNaN(Date.parse(input.next_retry_at)) || !input.error_code.trim()) throw new Error("Invalid daily digest failure");
    return await db.execute(
      `UPDATE daily_digest_jobs SET status = 'failed', lease_owner = NULL,
       lease_expires_at = NULL, next_retry_at = $1, last_error = $2, updated_at = $3
       WHERE id = $4 AND status = 'running' AND lease_owner = $5 AND lease_expires_at > $3::timestamptz`,
      [input.next_retry_at, input.error_code.slice(0, 120), input.failed_at, input.id, input.owner],
    ) === 1;
  }

export async function listDailyDigestJobs(db: PgSql, orgId: string): Promise<DailyDigestJob[]> {
    const rows = await db.query<DailyDigestJobRow>(
      `SELECT id, org_id, utc_date, generation, status, attempts, lease_owner,
       lease_expires_at, next_retry_at, last_error, created_at, updated_at
      FROM daily_digest_jobs WHERE org_id = $1 ORDER BY utc_date, generation, id`, [orgId],
    );
    return rows.map(toDailyDigestJob);
  }

export async function putDailyDigestCoverageAlert(db: PgSql, alert: DailyDigestCoverageAlert): Promise<DailyDigestCoverageAlert> {
    await db.execute(`INSERT INTO daily_digest_coverage_alerts (id, org_id, local_date, generation, event_id, reason_code, status, created_at, resolved_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (org_id, local_date, generation, event_id, reason_code) DO NOTHING`, [alert.id, alert.org_id, alert.local_date, alert.generation, alert.event_id, alert.reason_code, alert.status, alert.created_at, alert.resolved_at ?? null]);
    const row = await db.queryOne<DailyDigestCoverageAlert>(`SELECT id, org_id, local_date, generation, event_id, reason_code, status, created_at, resolved_at FROM daily_digest_coverage_alerts WHERE org_id = $1 AND local_date = $2 AND generation = $3 AND event_id = $4 AND reason_code = $5`, [alert.org_id, alert.local_date, alert.generation, alert.event_id, alert.reason_code]);
    return row!;
  }

export async function listDailyDigestCoverageAlerts(db: PgSql, input: { org_id: string; status?: "open" | "resolved"; limit?: number }): Promise<DailyDigestCoverageAlert[]> {
    const limit = input.limit ?? 100;
    return db.query<DailyDigestCoverageAlert>(`SELECT id, org_id, local_date, generation, event_id, reason_code, status, created_at, resolved_at FROM daily_digest_coverage_alerts WHERE org_id = $1 ${input.status ? "AND status = $2" : ""} ORDER BY local_date, id LIMIT $${input.status ? 3 : 2}`, input.status ? [input.org_id, input.status, limit] : [input.org_id, limit]);
  }

export async function resolveDailyDigestCoverageAlert(db: PgSql, input: { org_id: string; alert_id: string; resolved_at: string }): Promise<DailyDigestCoverageAlert | null> {
    await db.execute(`UPDATE daily_digest_coverage_alerts SET status = 'resolved', resolved_at = $1 WHERE org_id = $2 AND id = $3 AND status = 'open'`, [input.resolved_at, input.org_id, input.alert_id]);
    return await db.queryOne<DailyDigestCoverageAlert>(`SELECT id, org_id, local_date, generation, event_id, reason_code, status, created_at, resolved_at FROM daily_digest_coverage_alerts WHERE org_id = $1 AND id = $2`, [input.org_id, input.alert_id]);
  }

export async function getUiPref(db: PgSql, orgId: string, key: string): Promise<string | null> {
    const row = await db.queryOne<{ value: string }>(
      `SELECT value FROM ui_prefs WHERE org_id = $1 AND key = $2`,
      [orgId, key],
    );
    return row?.value ?? null;
  }

export async function getDailyDigestPolicy(db: PgSql, orgId: string): Promise<DailyDigestPolicy | null> {
    const value = await getUiPref(db, orgId, "daily_digest_policy_v1");
    return value ? validateDailyDigestPolicy(JSON.parse(value) as DailyDigestPolicy) : null;
  }

export async function putDailyDigestPolicy(db: PgSql, input: { org_id: string; policy: DailyDigestPolicy; updated_at: string }): Promise<DailyDigestPolicy> {
    const policy = validateDailyDigestPolicy(input.policy);
    if (!input.org_id.trim() || Number.isNaN(Date.parse(input.updated_at))) throw new Error("Invalid daily digest policy update");
    await putUiPref(db, input.org_id, "daily_digest_policy_v1", canonicalContextJson(policy), input.updated_at);
    return policy;
  }

export async function putUiPref(db: PgSql, orgId: string, key: string, value: string, updatedAt: string): Promise<void> {
    await db.execute(
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
