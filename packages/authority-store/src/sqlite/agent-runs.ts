import Database from "better-sqlite3";
import type {
  AgentRunRecord,
  AgentRunStatus,
  AgentRunOutput,
  AgentRunState,
} from "@regenic/domain";
import {
  validateAgentRun,
  canonicalContextJson,
  agentRunState,
  startAgentRun as applyAgentRunStart,
  settleAgentRun as applyAgentRunSettlement,
  cancelAgentRun as applyAgentRunCancellation,
} from "@regenic/domain";

export async function putAgentRun(db: Database.Database, input: AgentRunRecord): Promise<AgentRunRecord> {
    
    const run = validateAgentRun(input);
    if (run.status !== "queued") throw new Error("New AgentRun must be queued");
    db.prepare(`INSERT INTO agent_runs (id, org_id, status, payload_json, state_json, created_at) VALUES (?, ?, 'queued', ?, ?, ?) ON CONFLICT (id) DO NOTHING`).run(run.id, run.org_id, canonicalContextJson(run), canonicalContextJson(agentRunState(run)), run.created_at);
    const row = db.prepare(`SELECT status, payload_json, state_json FROM agent_runs WHERE org_id = ? AND id = ?`).get(run.org_id, run.id) as AgentRunRow | undefined;
    if (!row) throw new Error("Cannot persist AgentRun");
    const storedCreation = validateAgentRun(JSON.parse(row.payload_json) as AgentRunRecord);
    if (canonicalContextJson(storedCreation) !== canonicalContextJson({ ...run, created_at: storedCreation.created_at })) {
      throw new Error("Cannot replace immutable AgentRun");
    }
    return toAgentRun(row);
  }

export async function getAgentRun(db: Database.Database, orgId: string, runId: string): Promise<AgentRunRecord | null> {
    const row = db.prepare(`SELECT status, payload_json, state_json FROM agent_runs WHERE org_id = ? AND id = ?`).get(orgId, runId) as AgentRunRow | undefined;
    return row ? toAgentRun(row) : null;
  }

export async function listAgentRuns(db: Database.Database, input: { org_id: string; status?: AgentRunStatus; newest_first?: boolean; limit?: number }): Promise<AgentRunRecord[]> {
    const order = input.newest_first
      ? "ORDER BY julianday(json_extract(state_json, '$.finished_at')) DESC, id DESC"
      : "ORDER BY created_at, id";
    const rows = db.prepare(`SELECT status, payload_json, state_json FROM agent_runs WHERE org_id = ? ${input.status ? "AND status = ?" : ""} ${order} LIMIT ?`).all(...(input.status ? [input.org_id, input.status, input.limit ?? 100] : [input.org_id, input.limit ?? 100])) as AgentRunRow[];
    return rows.map(toAgentRun);
  }

export async function startAgentRun(db: Database.Database, input: { org_id: string; run_id: string; started_at: string }): Promise<AgentRunRecord | null> {
    
    const transaction = db.transaction(() => {
      const row = getAgentRunRow(db, input.org_id, input.run_id);
      if (!row) return null;
      const current = toAgentRun(row);
      if (current.status === "running") return current;
      const next = applyAgentRunStart(current, input.started_at);
      updateAgentRunState(db, current, next);
      return next;
    });
    return transaction.immediate();
  }

export async function settleAgentRun(db: Database.Database, input: { org_id: string; run_id: string; status: "succeeded" | "failed"; output: AgentRunOutput; finished_at: string }): Promise<AgentRunRecord | null> {
    
    const transaction = db.transaction(() => {
      const row = getAgentRunRow(db, input.org_id, input.run_id);
      if (!row) return null;
      const current = toAgentRun(row);
      if (current.status === input.status && canonicalContextJson(current.output) === canonicalContextJson(input.output)) return current;
      const next = applyAgentRunSettlement(current, input.status, input.output, input.finished_at);
      updateAgentRunState(db, current, next);
      return next;
    });
    return transaction.immediate();
  }

export async function cancelAgentRun(db: Database.Database, input: { org_id: string; run_id: string; cancelled_at: string }): Promise<AgentRunRecord | null> {
    
    const transaction = db.transaction(() => {
      const row = getAgentRunRow(db, input.org_id, input.run_id);
      if (!row) return null;
      const current = toAgentRun(row);
      if (current.status === "cancelled") return current;
      const next = applyAgentRunCancellation(current, input.cancelled_at);
      updateAgentRunState(db, current, next);
      return next;
    });
    return transaction.immediate();
  }

export function getAgentRunRow(db: Database.Database, orgId: string, runId: string): AgentRunRow | undefined {
    return db.prepare(`SELECT status, payload_json, state_json FROM agent_runs WHERE org_id = ? AND id = ?`).get(orgId, runId) as AgentRunRow | undefined;
  }

export function updateAgentRunState(db: Database.Database, current: AgentRunRecord, next: AgentRunRecord): void {
    const changed = db.prepare(`UPDATE agent_runs SET status = ?, state_json = ? WHERE org_id = ? AND id = ? AND status = ?`).run(next.status, canonicalContextJson(agentRunState(next)), current.org_id, current.id, current.status).changes;
    if (changed !== 1) throw new Error("AgentRun state changed concurrently");
  }

interface AgentRunRow {
  status: AgentRunStatus;
  payload_json: string;
  state_json: string;
}

export function toAgentRun(row: AgentRunRow): AgentRunRecord {
  const run = JSON.parse(row.payload_json) as AgentRunRecord;
  const state = JSON.parse(row.state_json) as AgentRunState;
  return validateAgentRun({
    ...run,
    status: row.status,
    ...(state.output ? { output: state.output } : {}),
    ...(state.handoff_id ? { handoff_id: state.handoff_id } : {}),
    ...(state.started_at ? { started_at: state.started_at } : {}),
    ...(state.finished_at ? { finished_at: state.finished_at } : {}),
  });
}
