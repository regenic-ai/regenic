import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  CancellationJob,
  ClaimCancellationJobs,
  RenewCancellationJob,
  RetryCancellationJob,
  RetryCancellationJobResult,
  SettleCancellationJob,
  WorkRun,
} from "@regenic/domain";

interface CancellationJobRow {
  id: string;
  org_id: string;
  event_id: string;
  job_type: "cancel_execution";
  run_id: string;
  schema_version: number;
  status: CancellationJob["status"];
  attempts: number;
  lease_owner: string | null;
  claim_token: string | null;
  lease_expires_at: string | null;
  next_retry_at: string | null;
  last_error_code: string | null;
  last_error: string | null;
  outcome_code: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export function enqueueCancellationJob(
  db: Database.Database,
  input: { run: WorkRun; thread_id: string; now: string },
): void {
  const { run } = input;
  if (run.status !== "running" && run.status !== "waiting_human") return;
  if (!run.external_run_id && !run.agent_thread_id) return;

  const eventId = randomUUID();
  const jobId = randomUUID();
  const dedupeKey = JSON.stringify([
    "work_run", run.id, run.version ?? 0, "cancellation_requested",
  ]);
  db.prepare(`INSERT INTO conversation_lifecycle_events (
    id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
    event_type, dedupe_key, schema_version, payload_json, occurred_at, created_at
  ) VALUES (?, ?, ?, 'work_run', ?, ?, 'cancellation_requested', ?, 1, ?, ?, ?)
  ON CONFLICT (org_id, dedupe_key) DO NOTHING`)
    .run(
      eventId, run.org_id, input.thread_id, run.id, run.version ?? 0, dedupeKey,
      JSON.stringify({
        work_item_id: run.work_item_id,
        run_id: run.id,
        reason: "work_dismissed",
      }),
      input.now, input.now,
    );
  const savedEvent = db.prepare(`SELECT id FROM conversation_lifecycle_events
    WHERE org_id = ? AND dedupe_key = ?`).get(run.org_id, dedupeKey) as { id: string } | undefined;
  if (!savedEvent) throw new Error("Cancellation request lifecycle event was not saved");
  db.prepare(`INSERT INTO conversation_lifecycle_jobs (
    id, org_id, event_id, job_type, run_id, schema_version, status, attempts, created_at, updated_at
  ) VALUES (?, ?, ?, 'cancel_execution', ?, 1, 'pending', 0, ?, ?)
  ON CONFLICT (org_id, job_type, run_id) DO NOTHING`)
    .run(jobId, run.org_id, savedEvent.id, run.id, input.now, input.now);
}

export async function claimCancellationJobs(
  db: Database.Database,
  input: ClaimCancellationJobs,
): Promise<CancellationJob[]> {
  assertClaim(input);
  return db.transaction(() => {
    db.prepare(`UPDATE conversation_lifecycle_jobs SET status = 'dead',
      lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL,
      last_error_code = 'retry_exhausted', outcome_code = 'retry_exhausted',
      completed_at = ?, updated_at = ?
      WHERE org_id = ? AND status = 'running' AND lease_expires_at <= ? AND attempts >= 5`)
      .run(input.now, input.now, input.org_id, input.now);
    const rows = db.prepare(`SELECT id FROM conversation_lifecycle_jobs
      WHERE org_id = ? AND attempts < 5 AND (
        status = 'pending'
        OR (status = 'failed' AND (next_retry_at IS NULL OR next_retry_at <= ?))
        OR (status = 'running' AND lease_expires_at <= ?)
      ) ORDER BY created_at, id LIMIT ?`)
      .all(input.org_id, input.now, input.now, input.limit) as Array<{ id: string }>;
    const expiresAt = new Date(Date.parse(input.now) + input.lease_ms).toISOString();
    for (const row of rows) {
      db.prepare(`UPDATE conversation_lifecycle_jobs SET status = 'running',
        attempts = attempts + 1, lease_owner = ?, claim_token = ?,
        lease_expires_at = ?, next_retry_at = NULL, last_error_code = NULL,
        last_error = NULL, outcome_code = NULL, completed_at = NULL, updated_at = ?
        WHERE id = ?`)
        .run(input.owner, randomUUID(), expiresAt, input.now, row.id);
    }
    return rows.map(({ id }) => getCancellationJob(db, input.org_id, id)!);
  }).immediate();
}

export async function renewCancellationJob(
  db: Database.Database,
  input: RenewCancellationJob,
): Promise<boolean> {
  assertLease(input);
  if (!Number.isSafeInteger(input.lease_ms) || input.lease_ms < 1) {
    throw new Error("Invalid cancellation job lease renewal");
  }
  const expiresAt = new Date(Date.parse(input.now) + input.lease_ms).toISOString();
  return db.prepare(`UPDATE conversation_lifecycle_jobs SET lease_expires_at = ?, updated_at = ?
    WHERE org_id = ? AND id = ? AND status = 'running' AND lease_owner = ?
      AND claim_token = ? AND lease_expires_at > ?`)
    .run(expiresAt, input.now, input.org_id, input.id, input.owner, input.claim_token, input.now)
    .changes === 1;
}

export async function settleCancellationJob(
  db: Database.Database,
  input: SettleCancellationJob,
): Promise<boolean> {
  assertLease(input);
  if (input.kind === "succeeded") {
    if (!input.outcome_code.trim()) throw new Error("Cancellation job outcome is required");
    return db.prepare(`UPDATE conversation_lifecycle_jobs SET status = 'succeeded',
      lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL,
      next_retry_at = NULL, outcome_code = ?, completed_at = ?, updated_at = ?
      WHERE org_id = ? AND id = ? AND status = 'running' AND lease_owner = ?
        AND claim_token = ? AND lease_expires_at > ?`)
      .run(input.outcome_code.slice(0, 120), input.now, input.now, input.org_id,
        input.id, input.owner, input.claim_token, input.now).changes === 1;
  }
  if (!Number.isFinite(Date.parse(input.next_retry_at)) || !input.error_code.trim()) {
    throw new Error("Invalid cancellation job failure");
  }
  return db.prepare(`UPDATE conversation_lifecycle_jobs SET
      status = CASE WHEN attempts >= 5 THEN 'dead' ELSE 'failed' END,
      lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL,
      next_retry_at = CASE WHEN attempts >= 5 THEN NULL ELSE ? END,
      last_error_code = ?, last_error = ?,
      outcome_code = CASE WHEN attempts >= 5 THEN 'retry_exhausted' ELSE NULL END,
      completed_at = CASE WHEN attempts >= 5 THEN ? ELSE NULL END, updated_at = ?
      WHERE org_id = ? AND id = ? AND status = 'running' AND lease_owner = ?
        AND claim_token = ? AND lease_expires_at > ?`)
    .run(input.next_retry_at, input.error_code.slice(0, 120), input.error.slice(0, 1000),
      input.now, input.now, input.org_id, input.id, input.owner, input.claim_token, input.now)
    .changes === 1;
}

export async function listCancellationJobs(
  db: Database.Database,
  orgId: string,
  limit = 100,
  statuses?: CancellationJob["status"][],
): Promise<CancellationJob[]> {
  if (statuses?.length === 0) return [];
  const boundedLimit = Number.isSafeInteger(limit)
    ? Math.max(0, Math.min(500, limit))
    : 100;
  const statusFilter = statuses
    ? ` AND status IN (${statuses.map(() => "?").join(", ")})`
    : "";
  const ordering = statuses ? "DESC" : "ASC";
  return (db.prepare(`SELECT * FROM conversation_lifecycle_jobs
    WHERE org_id = ?${statusFilter} ORDER BY created_at ${ordering}, id ${ordering} LIMIT ?`)
    .all(orgId, ...(statuses ?? []), boundedLimit) as CancellationJobRow[])
    .map(toCancellationJob);
}

export async function retryCancellationJob(
  db: Database.Database,
  input: RetryCancellationJob,
): Promise<RetryCancellationJobResult> {
  assertRetry(input);
  return db.transaction((): RetryCancellationJobResult => {
    const previous = db.prepare(`SELECT aggregate_type, aggregate_id, event_type, payload_json
      FROM conversation_lifecycle_events WHERE org_id = ? AND command_id = ?`)
      .get(input.org_id, input.command_id) as
      | { aggregate_type: string; aggregate_id: string; event_type: string; payload_json: string }
      | undefined;
    if (previous) {
      const payload = JSON.parse(previous.payload_json) as { command?: unknown };
      if (previous.aggregate_type !== "work_run" || previous.event_type !== "cancellation_requested"
        || previous.aggregate_id !== input.id || !sameRetryCommand(payload.command, input)) {
        return { outcome: "conflict" };
      }
      const replayed = getCancellationJob(db, input.org_id, input.id);
      return replayed ? { outcome: "replayed", job: replayed } : { outcome: "not_found" };
    }

    const job = getCancellationJob(db, input.org_id, input.id);
    if (!job) return { outcome: "not_found" };
    if (job.status !== "dead" || job.attempts !== input.expected_attempts) {
      return { outcome: "conflict" };
    }
    const context = db.prepare(`SELECT w.thread_id FROM work_runs r
      JOIN work_items w ON w.org_id = r.org_id AND w.id = r.work_item_id
      WHERE r.org_id = ? AND r.id = ?`).get(input.org_id, job.run_id) as
      | { thread_id: string }
      | undefined;
    if (!context) return { outcome: "conflict" };
    const eventId = `lifecycle-${randomUUID()}`;
    db.prepare(`INSERT INTO conversation_lifecycle_events (
      id, org_id, thread_id, aggregate_type, aggregate_id, aggregate_version,
      event_type, command_id, dedupe_key, schema_version, payload_json, occurred_at, created_at
    ) VALUES (?, ?, ?, 'work_run', ?, ?, 'cancellation_requested', ?, ?, 1, ?, ?, ?)`)
      .run(
        eventId, input.org_id, context.thread_id, input.id, job.attempts,
        input.command_id, JSON.stringify(["cancellation_job_retry", input.command_id]),
        JSON.stringify({ command: input, reason: "manual_retry" }),
        input.issued_at, input.issued_at,
      );
    const changed = db.prepare(`UPDATE conversation_lifecycle_jobs SET status = 'pending',
      attempts = 0, lease_owner = NULL, claim_token = NULL, lease_expires_at = NULL,
      next_retry_at = NULL, last_error_code = NULL, last_error = NULL,
      outcome_code = NULL, completed_at = NULL, updated_at = ?
      WHERE org_id = ? AND id = ? AND status = 'dead' AND attempts = ?`)
      .run(input.issued_at, input.org_id, input.id, input.expected_attempts);
    if (changed.changes !== 1) throw new Error("Cancellation job changed inside retry transaction");
    const saved = getCancellationJob(db, input.org_id, input.id);
    if (!saved) throw new Error("Retried cancellation job disappeared inside transaction");
    return { outcome: "applied", job: saved };
  }).immediate();
}

function assertRetry(input: RetryCancellationJob): void {
  if (!Number.isSafeInteger(input.expected_attempts) || input.expected_attempts < 0
    || !input.command_id.trim() || input.command_id !== input.command_id.trim()
    || input.command_id.length > 128 || !Number.isFinite(Date.parse(input.issued_at))) {
    throw new Error("Invalid cancellation job retry command");
  }
}

function sameRetryCommand(value: unknown, command: RetryCancellationJob): boolean {
  if (!value || typeof value !== "object") return false;
  const prior = value as Partial<RetryCancellationJob>;
  return prior.org_id === command.org_id && prior.id === command.id
    && prior.expected_attempts === command.expected_attempts
    && prior.command_id === command.command_id && prior.issued_at === command.issued_at;
}

export function getCancellationJob(
  db: Database.Database,
  orgId: string,
  id: string,
): CancellationJob | null {
  const row = db.prepare(`SELECT * FROM conversation_lifecycle_jobs
    WHERE org_id = ? AND id = ?`).get(orgId, id) as CancellationJobRow | undefined;
  return row ? toCancellationJob(row) : null;
}

export function toCancellationJob(row: CancellationJobRow): CancellationJob {
  return {
    id: row.id,
    org_id: row.org_id,
    event_id: row.event_id,
    job_type: row.job_type,
    run_id: row.run_id,
    schema_version: row.schema_version,
    status: row.status,
    attempts: row.attempts,
    ...(row.lease_owner ? { lease_owner: row.lease_owner } : {}),
    ...(row.claim_token ? { claim_token: row.claim_token } : {}),
    ...(row.lease_expires_at ? { lease_expires_at: row.lease_expires_at } : {}),
    ...(row.next_retry_at ? { next_retry_at: row.next_retry_at } : {}),
    ...(row.last_error_code ? { last_error_code: row.last_error_code } : {}),
    ...(row.last_error ? { last_error: row.last_error } : {}),
    ...(row.outcome_code ? { outcome_code: row.outcome_code } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(row.completed_at ? { completed_at: row.completed_at } : {}),
  };
}

function assertClaim(input: ClaimCancellationJobs): void {
  assertLease(input);
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100
    || !Number.isSafeInteger(input.lease_ms) || input.lease_ms < 1) {
    throw new Error("Invalid cancellation job claim");
  }
}

function assertLease(input: {
  org_id: string;
  id?: string;
  owner: string;
  claim_token?: string;
  now: string;
}): void {
  if (!input.org_id.trim() || !input.owner.trim()
    || (input.id !== undefined && !input.id.trim())
    || (input.claim_token !== undefined && !input.claim_token.trim())
    || !Number.isFinite(Date.parse(input.now))) {
    throw new Error("Invalid cancellation job lease identity");
  }
}
