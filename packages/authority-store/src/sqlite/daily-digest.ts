import type {
  DailyDigestJob,
  DailyDigestCoverageAlert,
  DailyDigestPolicy,
} from "@regenic/domain";
import Database from "better-sqlite3";
import {
  hashCanonicalContext,
  validateDailyDigestPolicy,
  canonicalContextJson,
} from "@regenic/domain";
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
  lease_expires_at: string | null;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export async function enqueueDailyDigestCatchUp(db: Database.Database, input: {
    org_id: string;
    through_utc_date: string;
    generation: string;
    created_at: string;
    max_days: number;
  }): Promise<DailyDigestJob[]> {
    
    assertDailyDigestCatchUp(input);
    return db.transaction(() => {
      const cursor = db.prepare(
        `SELECT last_scheduled_utc_date FROM daily_digest_schedule_cursors
         WHERE org_id = ? AND generation = ?`,
      ).get(input.org_id, input.generation) as { last_scheduled_utc_date: string } | undefined;
      const dates = catchUpDates(cursor?.last_scheduled_utc_date, input.through_utc_date, input.max_days);
      const jobs = dates.map((utcDate) => {
        const id = `daily-digest-job:${hashCanonicalContext([input.org_id, utcDate, input.generation])}`;
        db.prepare(
          `INSERT INTO daily_digest_jobs (
            id, org_id, utc_date, generation, status, attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
          ON CONFLICT (org_id, utc_date, generation) DO NOTHING`,
        ).run(id, input.org_id, utcDate, input.generation, input.created_at, input.created_at);
        return getDailyDigestJob(db, id)!;
      });
      const lastScheduled = dates.at(-1);
      if (lastScheduled) {
        db.prepare(
          `INSERT INTO daily_digest_schedule_cursors (org_id, generation, last_scheduled_utc_date, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (org_id, generation) DO UPDATE SET
             last_scheduled_utc_date = excluded.last_scheduled_utc_date,
             updated_at = excluded.updated_at`,
        ).run(input.org_id, input.generation, lastScheduled, input.created_at);
      }
      return jobs;
    }).immediate();
  }

export async function enqueueDailyDigestJob(db: Database.Database, input: {
    org_id: string;
    utc_date: string;
    generation: string;
    created_at: string;
  }): Promise<DailyDigestJob> {
    
    assertDailyDigestEnqueue(input);
    const id = `daily-digest-job:${hashCanonicalContext([input.org_id, input.utc_date, input.generation])}`;
    db.prepare(
      `INSERT INTO daily_digest_jobs (
        id, org_id, utc_date, generation, status, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT (org_id, utc_date, generation) DO NOTHING`,
    ).run(id, input.org_id, input.utc_date, input.generation, input.created_at, input.created_at);
    return getDailyDigestJob(db, id)!;
  }

export async function claimDailyDigestJobs(db: Database.Database, input: {
    owner: string; now: string; lease_ms: number; limit: number;
  }): Promise<DailyDigestJob[]> {
    
    assertProjectionClaim(input);
    return db.transaction(() => {
      const rows = db.prepare(
        `SELECT id FROM daily_digest_jobs
         WHERE status = 'pending'
            OR (status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= ?))
            OR (status = 'running' AND lease_expires_at <= ?)
         ORDER BY created_at, id LIMIT ?`,
      ).all(input.now, input.now, input.limit) as Array<{ id: string }>;
      const leaseExpiresAt = new Date(Date.parse(input.now) + input.lease_ms).toISOString();
      for (const row of rows) {
        db.prepare(
          `UPDATE daily_digest_jobs SET status = 'running', attempts = attempts + 1,
           lease_owner = ?, lease_expires_at = ?, next_retry_at = NULL,
           last_error = NULL, updated_at = ? WHERE id = ?`,
        ).run(input.owner, leaseExpiresAt, input.now, row.id);
      }
      return rows.map((row) => getDailyDigestJob(db, row.id)!);
    }).immediate();
  }

export async function completeDailyDigestJob(db: Database.Database, input: { id: string; owner: string; completed_at: string }): Promise<boolean> {
    
    assertProjectionSettle(input.id, input.owner, input.completed_at);
    return db.prepare(
      `UPDATE daily_digest_jobs SET status = 'succeeded', lease_owner = NULL,
       lease_expires_at = NULL, next_retry_at = NULL, last_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?`,
    ).run(input.completed_at, input.id, input.owner, input.completed_at).changes === 1;
  }

export async function renewDailyDigestJob(db: Database.Database, input: { id: string; owner: string; now: string; lease_ms: number }): Promise<boolean> {
    
    assertProjectionSettle(input.id, input.owner, input.now);
    if (!Number.isSafeInteger(input.lease_ms) || input.lease_ms < 1) throw new Error("Invalid daily digest lease renewal");
    const leaseExpiresAt = new Date(Date.parse(input.now) + input.lease_ms).toISOString();
    return db.prepare(
      `UPDATE daily_digest_jobs SET lease_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?`,
    ).run(leaseExpiresAt, input.now, input.id, input.owner, input.now).changes === 1;
  }

export async function failDailyDigestJob(db: Database.Database, input: {
    id: string; owner: string; failed_at: string; next_retry_at: string; error_code: string;
  }): Promise<boolean> {
    
    assertProjectionSettle(input.id, input.owner, input.failed_at);
    if (Number.isNaN(Date.parse(input.next_retry_at)) || !input.error_code.trim()) throw new Error("Invalid daily digest failure");
    return db.prepare(
      `UPDATE daily_digest_jobs SET status = 'failed', lease_owner = NULL,
       lease_expires_at = NULL, next_retry_at = ?, last_error = ?, updated_at = ?
       WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?`,
    ).run(input.next_retry_at, input.error_code.slice(0, 120), input.failed_at, input.id, input.owner, input.failed_at).changes === 1;
  }

export async function listDailyDigestJobs(db: Database.Database, orgId: string): Promise<DailyDigestJob[]> {
    return (db.prepare(
      `SELECT id, org_id, utc_date, generation, status, attempts, lease_owner,
       lease_expires_at, next_retry_at, last_error, created_at, updated_at
      FROM daily_digest_jobs WHERE org_id = ? ORDER BY utc_date, generation, id`,
    ).all(orgId) as DailyDigestJobRow[]).map(toDailyDigestJob);
  }

export async function putDailyDigestCoverageAlert(db: Database.Database, alert: DailyDigestCoverageAlert): Promise<DailyDigestCoverageAlert> {
    
    db.prepare(`INSERT INTO daily_digest_coverage_alerts (id, org_id, local_date, generation, event_id, reason_code, status, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (org_id, local_date, generation, event_id, reason_code) DO NOTHING`).run(alert.id, alert.org_id, alert.local_date, alert.generation, alert.event_id, alert.reason_code, alert.status, alert.created_at, alert.resolved_at ?? null);
    return toDailyDigestCoverageAlert(db.prepare(`SELECT id, org_id, local_date, generation, event_id, reason_code, status, created_at, resolved_at FROM daily_digest_coverage_alerts WHERE org_id = ? AND local_date = ? AND generation = ? AND event_id = ? AND reason_code = ?`).get(alert.org_id, alert.local_date, alert.generation, alert.event_id, alert.reason_code) as DailyDigestCoverageAlert);
  }

export async function listDailyDigestCoverageAlerts(db: Database.Database, input: { org_id: string; status?: "open" | "resolved"; limit?: number }): Promise<DailyDigestCoverageAlert[]> {
    const limit = input.limit ?? 100;
    return (db.prepare(`SELECT id, org_id, local_date, generation, event_id, reason_code, status, created_at, resolved_at FROM daily_digest_coverage_alerts WHERE org_id = ? ${input.status ? "AND status = ?" : ""} ORDER BY local_date, id LIMIT ?`).all(...(input.status ? [input.org_id, input.status, limit] : [input.org_id, limit])) as DailyDigestCoverageAlert[]).map(toDailyDigestCoverageAlert);
  }

export async function resolveDailyDigestCoverageAlert(db: Database.Database, input: { org_id: string; alert_id: string; resolved_at: string }): Promise<DailyDigestCoverageAlert | null> {
    
    db.prepare(`UPDATE daily_digest_coverage_alerts SET status = 'resolved', resolved_at = ? WHERE org_id = ? AND id = ? AND status = 'open'`).run(input.resolved_at, input.org_id, input.alert_id);
    const alert = db.prepare(`SELECT id, org_id, local_date, generation, event_id, reason_code, status, created_at, resolved_at FROM daily_digest_coverage_alerts WHERE org_id = ? AND id = ?`).get(input.org_id, input.alert_id) as DailyDigestCoverageAlert | undefined;
    return alert ? toDailyDigestCoverageAlert(alert) : null;
  }

function getDailyDigestJob(db: Database.Database, id: string): DailyDigestJob | null {
    const row = db.prepare(
      `SELECT id, org_id, utc_date, generation, status, attempts, lease_owner,
       lease_expires_at, next_retry_at, last_error, created_at, updated_at
       FROM daily_digest_jobs WHERE id = ?`,
    ).get(id) as DailyDigestJobRow | undefined;
    return row ? toDailyDigestJob(row) : null;
  }

export async function getUiPref(db: Database.Database, orgId: string, key: string): Promise<string | null> {
    const row = db
      .prepare(`SELECT value FROM ui_prefs WHERE org_id = ? AND key = ?`)
      .get(orgId, key) as { value: string } | undefined;
    return row?.value ?? null;
  }

export async function getDailyDigestPolicy(db: Database.Database, orgId: string): Promise<DailyDigestPolicy | null> {
    const value = await getUiPref(db, orgId, "daily_digest_policy_v1");
    return value ? validateDailyDigestPolicy(JSON.parse(value) as DailyDigestPolicy) : null;
  }

export async function putDailyDigestPolicy(db: Database.Database, input: { org_id: string; policy: DailyDigestPolicy; updated_at: string }): Promise<DailyDigestPolicy> {
    const policy = validateDailyDigestPolicy(input.policy);
    if (!input.org_id.trim() || Number.isNaN(Date.parse(input.updated_at))) throw new Error("Invalid daily digest policy update");
    await putUiPref(db, input.org_id, "daily_digest_policy_v1", canonicalContextJson(policy), input.updated_at);
    return policy;
  }

export async function putUiPref(db: Database.Database, orgId: string, key: string, value: string, updatedAt: string): Promise<void> {
    
    db
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

function toDailyDigestJob(row: DailyDigestJobRow): DailyDigestJob {
  return {
    id: row.id,
    org_id: row.org_id,
    utc_date: row.utc_date,
    generation: row.generation,
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

function toDailyDigestCoverageAlert(alert: DailyDigestCoverageAlert): DailyDigestCoverageAlert {
  const { resolved_at: resolvedAt, ...rest } = alert;
  return { ...rest, ...(resolvedAt ? { resolved_at: resolvedAt } : {}) };
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
