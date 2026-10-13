import type {
  ProposalRecord,
  ProposalStatus,
  DecisionRecord,
  ReviewRecord,
  HandoffRecord,
  HandoffStatus,
  HandoffDirection,
} from "@regenic/domain";
import {
  validateProposal,
  validateDecision,
  canonicalContextJson,
  validateReview,
  validateHandoff,
  assertHandoffTransition,
} from "@regenic/domain";
import type {
  PoolClient,
} from "pg";
import {
  PgSql,
  jsonb,
  toIso,
  toIsoOrNull,
} from "./sql";
import {
  parseContextJson,
} from "./context-artifacts";

export async function putProposal(db: PgSql, input: ProposalRecord): Promise<ProposalRecord> {
    const proposal = validateProposal(input);
    if (proposal.status !== "draft") throw new Error("New Proposal must be draft");
    await db.execute(`INSERT INTO proposals (id, org_id, status, source_digest_id, source_item_event_id, payload_json, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`, [proposal.id, proposal.org_id, proposal.status, proposal.source_digest_id ?? null, proposal.source_item_event_id ?? null, jsonb(proposal), proposal.created_at, proposal.updated_at]);
    const row = proposal.source_digest_id && proposal.source_item_event_id
      ? await db.queryOne<ProposalRow>(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = $1 AND source_digest_id = $2 AND source_item_event_id = $3`, [proposal.org_id, proposal.source_digest_id, proposal.source_item_event_id])
      : await db.queryOne<ProposalRow>(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = $1 AND id = $2`, [proposal.org_id, proposal.id]);
    return toProposal(row!);
  }

export async function getProposal(db: PgSql, orgId: string, proposalId: string): Promise<ProposalRecord | null> {
    const row = await db.queryOne<ProposalRow>(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = $1 AND id = $2`, [orgId, proposalId]);
    return row ? toProposal(row) : null;
  }

export async function listProposals(db: PgSql, input: { org_id: string; status?: ProposalStatus; limit?: number }): Promise<ProposalRecord[]> {
    const limit = input.limit ?? 100;
    const rows = await db.query<ProposalRow>(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = $1 ${input.status ? "AND status = $2" : ""} ORDER BY created_at, id LIMIT $${input.status ? 3 : 2}`, input.status ? [input.org_id, input.status, limit] : [input.org_id, limit]);
    return rows.map(toProposal);
  }

export async function transitionProposal(db: PgSql, input: { org_id: string; proposal_id: string; status: "submitted" | "in_review" | "rejected" | "withdrawn"; updated_at: string }): Promise<ProposalRecord | null> {
    return db.withTx(async (client) => {
      const row = await db.queryOne<ProposalRow>(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, input.proposal_id], client);
      if (!row) return null;
      const proposal = toProposal(row);
      const allowed = (proposal.status === "draft" && ["submitted", "withdrawn"].includes(input.status))
        || (proposal.status === "submitted" && ["in_review", "withdrawn"].includes(input.status))
        || (proposal.status === "in_review" && ["rejected", "withdrawn"].includes(input.status));
      if (!allowed) throw new Error("Invalid Proposal transition");
      const next = validateProposal({ ...proposal, status: input.status, updated_at: input.updated_at });
      await db.execute(`UPDATE proposals SET status = $1, updated_at = $2 WHERE org_id = $3 AND id = $4 AND status = $5`, [next.status, next.updated_at, input.org_id, input.proposal_id, proposal.status], client);
      return next;
    });
  }

export async function commitProposalDecision(db: PgSql, input: { org_id: string; proposal_id: string; decision: DecisionRecord }): Promise<{ proposal: ProposalRecord; decision: DecisionRecord }> {
    return db.withTx(async (client) => {
      const decision = validateDecision(input.decision);
      const proposal = await getProposalWithinTransaction(db, input.org_id, input.proposal_id, client, true);
      const existing = await db.queryOne<{ payload_json: unknown }>(`SELECT payload_json FROM decisions WHERE org_id = $1 AND proposal_id = $2`, [input.org_id, input.proposal_id], client);
      if (existing) {
        const stored = validateDecision(parseContextJson<DecisionRecord>(existing.payload_json));
        if (canonicalContextJson(stored) !== canonicalContextJson(decision)) throw new Error("Cannot replace immutable Decision");
        return { proposal: proposal!, decision: stored };
      }
      if (!proposal || proposal.status !== "in_review" || proposal.kind !== "decision"
        || decision.org_id !== input.org_id || decision.proposal_id !== proposal.id
        || decision.context_snapshot_id !== proposal.context_snapshot_id
        || decision.rights_level !== proposal.rights_level
        || canonicalContextJson(decision.standard_bindings) !== canonicalContextJson(proposal.standard_bindings)) {
        throw new Error("Invalid Proposal Decision commit");
      }
      await db.execute(`INSERT INTO decisions (id, org_id, proposal_id, status, payload_json, committed_at) VALUES ($1, $2, $3, $4, $5, $6)`, [decision.id, decision.org_id, decision.proposal_id, decision.status, jsonb(decision), decision.committed_at], client);
      await db.execute(`UPDATE proposals SET status = 'accepted', outcome_kind = 'decision', outcome_ref_id = $1, updated_at = $2 WHERE org_id = $3 AND id = $4 AND status = 'in_review'`, [decision.id, decision.committed_at, input.org_id, input.proposal_id], client);
      return {
        proposal: (await getProposalWithinTransaction(db, input.org_id, input.proposal_id, client))!,
        decision,
      };
    });
  }

export async function getDecision(db: PgSql, orgId: string, decisionId: string): Promise<DecisionRecord | null> {
    const row = await db.queryOne<{ payload_json: unknown }>(`SELECT payload_json FROM decisions WHERE org_id = $1 AND id = $2`, [orgId, decisionId]);
    return row ? validateDecision(parseContextJson<DecisionRecord>(row.payload_json)) : null;
  }

export async function listDecisions(db: PgSql, input: { org_id: string; limit?: number }): Promise<DecisionRecord[]> {
    const rows = await db.query<{ payload_json: unknown }>(`SELECT payload_json FROM decisions WHERE org_id = $1 ORDER BY committed_at, id LIMIT $2`, [input.org_id, input.limit ?? 100]);
    return rows.map((row) => validateDecision(parseContextJson<DecisionRecord>(row.payload_json)));
  }

export async function putReview(db: PgSql, input: ReviewRecord): Promise<ReviewRecord> {
    const review = validateReview(input);
    await db.execute(`INSERT INTO reviews (id, org_id, subject_kind, subject_id, payload_json, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`, [review.id, review.org_id, review.subject_kind, review.subject_id, jsonb(review), review.created_at]);
    const stored = await getReview(db, review.org_id, review.id);
    if (!stored || canonicalContextJson(stored) !== canonicalContextJson(review)) throw new Error("Cannot replace immutable Review");
    return stored;
  }

export async function getReview(db: PgSql, orgId: string, reviewId: string): Promise<ReviewRecord | null> {
    const row = await db.queryOne<{ payload_json: unknown }>(`SELECT payload_json FROM reviews WHERE org_id = $1 AND id = $2`, [orgId, reviewId]);
    return row ? validateReview(parseContextJson<ReviewRecord>(row.payload_json)) : null;
  }

export async function listReviews(db: PgSql, input: { org_id: string; subject_id?: string; limit?: number }): Promise<ReviewRecord[]> {
    const rows = await db.query<{ payload_json: unknown }>(`SELECT payload_json FROM reviews WHERE org_id = $1 ${input.subject_id ? "AND subject_id = $2" : ""} ORDER BY created_at, id LIMIT $${input.subject_id ? 3 : 2}`, input.subject_id ? [input.org_id, input.subject_id, input.limit ?? 100] : [input.org_id, input.limit ?? 100]);
    return rows.map((row) => validateReview(parseContextJson<ReviewRecord>(row.payload_json)));
  }

export async function putHandoff(db: PgSql, input: HandoffRecord): Promise<HandoffRecord> {
    const handoff = validateHandoff(input);
    if (handoff.status !== "open") throw new Error("New Handoff must be open");
    await db.execute(`INSERT INTO handoffs (id, org_id, direction, status, payload_json, created_at, resolved_at) VALUES ($1, $2, $3, $4, $5, $6, NULL) ON CONFLICT (id) DO NOTHING`, [handoff.id, handoff.org_id, handoff.direction, handoff.status, jsonb(handoff), handoff.created_at]);
    const row = await db.queryOne<HandoffRow>(`SELECT status, payload_json, resolved_at FROM handoffs WHERE org_id = $1 AND id = $2`, [handoff.org_id, handoff.id]);
    if (!row) throw new Error("Cannot replace immutable Handoff");
    const storedCreation = validateHandoff(parseContextJson<HandoffRecord>(row.payload_json));
    if (canonicalContextJson(storedCreation) !== canonicalContextJson({
      ...handoff, created_at: storedCreation.created_at,
    })) {
      throw new Error("Cannot replace immutable Handoff");
    }
    return toHandoff(row);
  }

export async function getHandoff(db: PgSql, orgId: string, handoffId: string): Promise<HandoffRecord | null> {
    const row = await db.queryOne<HandoffRow>(`SELECT status, payload_json, resolved_at FROM handoffs WHERE org_id = $1 AND id = $2`, [orgId, handoffId]);
    return row ? toHandoff(row) : null;
  }

export async function listHandoffs(db: PgSql, input: { org_id: string; status?: HandoffStatus; direction?: HandoffDirection; limit?: number }): Promise<HandoffRecord[]> {
    const conditions = ["org_id = $1"];
    const values: unknown[] = [input.org_id];
    if (input.status) { values.push(input.status); conditions.push(`status = $${values.length}`); }
    if (input.direction) { values.push(input.direction); conditions.push(`direction = $${values.length}`); }
    values.push(input.limit ?? 100);
    const rows = await db.query<HandoffRow>(`SELECT status, payload_json, resolved_at FROM handoffs WHERE ${conditions.join(" AND ")} ORDER BY created_at, id LIMIT $${values.length}`, values);
    return rows.map(toHandoff);
  }

export async function transitionHandoff(db: PgSql, input: { org_id: string; handoff_id: string; status: Exclude<HandoffStatus, "open">; transitioned_at: string }): Promise<HandoffRecord | null> {
    if (!input.org_id?.trim() || !input.handoff_id?.trim() || Number.isNaN(Date.parse(input.transitioned_at))) throw new Error("Invalid Handoff transition");
    return db.withTx(async (client) => {
      const row = await db.queryOne<HandoffRow>(`SELECT status, payload_json, resolved_at FROM handoffs WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, input.handoff_id], client);
      if (!row) return null;
      const current = toHandoff(row);
      assertHandoffTransition(current.status, input.status);
      const next = validateHandoff({
        ...current,
        status: input.status,
        ...(input.status === "resolved" ? { resolved_at: input.transitioned_at } : {}),
      });
      await db.execute(`UPDATE handoffs SET status = $1, resolved_at = $2 WHERE org_id = $3 AND id = $4 AND status = $5`, [next.status, next.resolved_at ?? null, input.org_id, input.handoff_id, current.status], client);
      return next;
    });
  }

export async function getProposalWithinTransaction(db: PgSql, orgId: string, proposalId: string, client: PoolClient, lock = false): Promise<ProposalRecord | null> {
    const row = await db.queryOne<ProposalRow>(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`, [orgId, proposalId], client);
    return row ? toProposal(row) : null;
  }

export interface ProposalRow {
  status: ProposalStatus;
  payload_json: unknown;
  updated_at: unknown;
  outcome_kind: "standard_version" | "decision" | "claim" | "none" | null;
  outcome_ref_id: string | null;
}

export interface HandoffRow {
  status: HandoffStatus;
  payload_json: unknown;
  resolved_at: unknown;
}

export function toHandoff(row: HandoffRow): HandoffRecord {
  const resolvedAt = toIsoOrNull(row.resolved_at);
  return validateHandoff({
    ...parseContextJson<HandoffRecord>(row.payload_json),
    status: row.status,
    ...(resolvedAt ? { resolved_at: resolvedAt } : {}),
  });
}

export function toProposal(row: ProposalRow): ProposalRecord {
  const proposal = validateProposal({
    ...parseContextJson<ProposalRecord>(row.payload_json),
    status: row.status,
    updated_at: toIso(row.updated_at),
  });
  return {
    ...proposal,
    ...(row.outcome_kind
      ? { outcome_ref: { outcome_kind: row.outcome_kind, ...(row.outcome_ref_id ? { ref_id: row.outcome_ref_id } : {}) } }
      : {}),
  };
}
