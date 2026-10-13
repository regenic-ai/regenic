import type {
  AgentRunRecord,
  AgentRunStatus,
  AgentRunOutput,
  AgentRunState,
} from "@regenic/domain";
import {
  validateAgentRun,
  agentRunState,
  canonicalContextJson,
  startAgentRun as applyAgentRunStart,
  settleAgentRun as applyAgentRunSettlement,
  cancelAgentRun as applyAgentRunCancellation,
} from "@regenic/domain";
import type {
  PoolClient,
} from "pg";
import {
  PgSql,
  jsonb,
} from "./sql";
import {
  parseContextJson,
} from "./context-artifacts";

export async function putAgentRun(db: PgSql, input: AgentRunRecord): Promise<AgentRunRecord> {
    const run = validateAgentRun(input);
    if (run.status !== "queued") throw new Error("New AgentRun must be queued");
    await db.execute(`INSERT INTO agent_runs (id, org_id, status, payload_json, state_json, created_at) VALUES ($1, $2, 'queued', $3, $4, $5) ON CONFLICT (id) DO NOTHING`, [run.id, run.org_id, jsonb(run), jsonb(agentRunState(run)), run.created_at]);
    const row = await db.queryOne<AgentRunRow>(`SELECT status, payload_json, state_json FROM agent_runs WHERE org_id = $1 AND id = $2`, [run.org_id, run.id]);
    if (!row) throw new Error("Cannot persist AgentRun");
    const storedCreation = validateAgentRun(parseContextJson<AgentRunRecord>(row.payload_json));
    if (canonicalContextJson(storedCreation) !== canonicalContextJson({ ...run, created_at: storedCreation.created_at })) {
      throw new Error("Cannot replace immutable AgentRun");
    }
    return toAgentRun(row);
  }

export async function getAgentRun(db: PgSql, orgId: string, runId: string): Promise<AgentRunRecord | null> {
    const row = await db.queryOne<AgentRunRow>(`SELECT status, payload_json, state_json FROM agent_runs WHERE org_id = $1 AND id = $2`, [orgId, runId]);
    return row ? toAgentRun(row) : null;
  }

export async function listAgentRuns(db: PgSql, input: { org_id: string; status?: AgentRunStatus; newest_first?: boolean; limit?: number }): Promise<AgentRunRecord[]> {
    const order = input.newest_first
      ? "ORDER BY (state_json->>'finished_at')::timestamptz DESC NULLS LAST, id DESC"
      : "ORDER BY created_at, id";
    const rows = await db.query<AgentRunRow>(`SELECT status, payload_json, state_json FROM agent_runs WHERE org_id = $1 ${input.status ? "AND status = $2" : ""} ${order} LIMIT $${input.status ? 3 : 2}`, input.status ? [input.org_id, input.status, input.limit ?? 100] : [input.org_id, input.limit ?? 100]);
    return rows.map(toAgentRun);
  }

export async function startAgentRun(db: PgSql, input: { org_id: string; run_id: string; started_at: string }): Promise<AgentRunRecord | null> {
    return db.withTx(async (client) => {
      const row = await getAgentRunWithinTransaction(db, input.org_id, input.run_id, client);
      if (!row) return null;
      const current = toAgentRun(row);
      if (current.status === "running") return current;
      const next = applyAgentRunStart(current, input.started_at);
      await updateAgentRunState(db, current, next, client);
      return next;
    });
  }

export async function settleAgentRun(db: PgSql, input: { org_id: string; run_id: string; status: "succeeded" | "failed"; output: AgentRunOutput; finished_at: string }): Promise<AgentRunRecord | null> {
    return db.withTx(async (client) => {
      const row = await getAgentRunWithinTransaction(db, input.org_id, input.run_id, client);
      if (!row) return null;
      const current = toAgentRun(row);
      if (current.status === input.status && canonicalContextJson(current.output) === canonicalContextJson(input.output)) return current;
      const next = applyAgentRunSettlement(current, input.status, input.output, input.finished_at);
      await updateAgentRunState(db, current, next, client);
      return next;
    });
  }

export async function cancelAgentRun(db: PgSql, input: { org_id: string; run_id: string; cancelled_at: string }): Promise<AgentRunRecord | null> {
    return db.withTx(async (client) => {
      const row = await getAgentRunWithinTransaction(db, input.org_id, input.run_id, client);
      if (!row) return null;
      const current = toAgentRun(row);
      if (current.status === "cancelled") return current;
      const next = applyAgentRunCancellation(current, input.cancelled_at);
      await updateAgentRunState(db, current, next, client);
      return next;
    });
  }

export async function getAgentRunWithinTransaction(db: PgSql, orgId: string, runId: string, client: PoolClient): Promise<AgentRunRow | null> {
    return db.queryOne<AgentRunRow>(`SELECT status, payload_json, state_json FROM agent_runs WHERE org_id = $1 AND id = $2 FOR UPDATE`, [orgId, runId], client);
  }

export async function updateAgentRunState(db: PgSql, current: AgentRunRecord, next: AgentRunRecord, client: PoolClient): Promise<void> {
    const result = await client.query(`UPDATE agent_runs SET status = $1, state_json = $2 WHERE org_id = $3 AND id = $4 AND status = $5`, [next.status, jsonb(agentRunState(next)), current.org_id, current.id, current.status]);
    if (result.rowCount !== 1) throw new Error("AgentRun state changed concurrently");
  }

export interface AgentRunRow {
  status: AgentRunStatus;
  payload_json: unknown;
  state_json: unknown;
}

export function toAgentRun(row: AgentRunRow): AgentRunRecord {
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
