import Database from "better-sqlite3";
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
  canonicalContextJson,
  validateDecision,
  validateReview,
  validateHandoff,
  assertHandoffTransition,
} from "@regenic/domain";

export async function putProposal(db: Database.Database, input: ProposalRecord): Promise<ProposalRecord> {
    
    const proposal = validateProposal(input);
    if (proposal.status !== "draft") throw new Error("New Proposal must be draft");
    db.prepare(`INSERT INTO proposals (id, org_id, status, source_digest_id, source_item_event_id, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(proposal.id, proposal.org_id, proposal.status, proposal.source_digest_id ?? null, proposal.source_item_event_id ?? null, canonicalContextJson(proposal), proposal.created_at, proposal.updated_at);
    const stored = proposal.source_digest_id && proposal.source_item_event_id
      ? db.prepare(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = ? AND source_digest_id = ? AND source_item_event_id = ?`).get(proposal.org_id, proposal.source_digest_id, proposal.source_item_event_id)
      : db.prepare(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = ? AND id = ?`).get(proposal.org_id, proposal.id);
    return toProposal(stored as ProposalRow);
  }

export async function getProposal(db: Database.Database, orgId: string, proposalId: string): Promise<ProposalRecord | null> {
    return getProposalSync(db, orgId, proposalId);
  }

export async function listProposals(db: Database.Database, input: { org_id: string; status?: ProposalStatus; limit?: number }): Promise<ProposalRecord[]> {
    const limit = input.limit ?? 100;
    const rows = db.prepare(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = ? ${input.status ? "AND status = ?" : ""} ORDER BY created_at, id LIMIT ?`).all(...(input.status ? [input.org_id, input.status, limit] : [input.org_id, limit])) as ProposalRow[];
    return rows.map(toProposal);
  }

export async function transitionProposal(db: Database.Database, input: { org_id: string; proposal_id: string; status: "submitted" | "in_review" | "rejected" | "withdrawn"; updated_at: string }): Promise<ProposalRecord | null> {
    
    return db.transaction(() => {
      const current = db.prepare(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = ? AND id = ?`).get(input.org_id, input.proposal_id) as ProposalRow | undefined;
      if (!current) return null;
      const proposal = toProposal(current);
      const allowed = (proposal.status === "draft" && ["submitted", "withdrawn"].includes(input.status))
        || (proposal.status === "submitted" && ["in_review", "withdrawn"].includes(input.status))
        || (proposal.status === "in_review" && ["rejected", "withdrawn"].includes(input.status));
      if (!allowed) throw new Error("Invalid Proposal transition");
      const next = validateProposal({ ...proposal, status: input.status, updated_at: input.updated_at });
      db.prepare(`UPDATE proposals SET status = ?, updated_at = ? WHERE org_id = ? AND id = ? AND status = ?`).run(next.status, next.updated_at, input.org_id, input.proposal_id, proposal.status);
      return next;
    })();
  }

export async function commitProposalDecision(db: Database.Database, input: { org_id: string; proposal_id: string; decision: DecisionRecord }): Promise<{ proposal: ProposalRecord; decision: DecisionRecord }> {
    
    return db.transaction(() => {
      const decision = validateDecision(input.decision);
      const existing = db.prepare(`SELECT payload_json FROM decisions WHERE org_id = ? AND proposal_id = ?`).get(input.org_id, input.proposal_id) as { payload_json: string } | undefined;
      if (existing) {
        const stored = validateDecision(JSON.parse(existing.payload_json) as DecisionRecord);
        if (canonicalContextJson(stored) !== canonicalContextJson(decision)) throw new Error("Cannot replace immutable Decision");
        return { proposal: getProposalSync(db, input.org_id, input.proposal_id)!, decision: stored };
      }
      const proposal = getProposalSync(db, input.org_id, input.proposal_id);
      if (!proposal || proposal.status !== "in_review" || proposal.kind !== "decision"
        || decision.org_id !== input.org_id || decision.proposal_id !== proposal.id
        || decision.context_snapshot_id !== proposal.context_snapshot_id
        || decision.rights_level !== proposal.rights_level
        || canonicalContextJson(decision.standard_bindings) !== canonicalContextJson(proposal.standard_bindings)) {
        throw new Error("Invalid Proposal Decision commit");
      }
      db.prepare(`INSERT INTO decisions (id, org_id, proposal_id, status, payload_json, committed_at) VALUES (?, ?, ?, ?, ?, ?)`).run(decision.id, decision.org_id, decision.proposal_id, decision.status, canonicalContextJson(decision), decision.committed_at);
      db.prepare(`UPDATE proposals SET status = 'accepted', outcome_kind = 'decision', outcome_ref_id = ?, updated_at = ? WHERE org_id = ? AND id = ? AND status = 'in_review'`).run(decision.id, decision.committed_at, input.org_id, input.proposal_id);
      return { proposal: getProposalSync(db, input.org_id, input.proposal_id)!, decision };
    })();
  }

export async function getDecision(db: Database.Database, orgId: string, decisionId: string): Promise<DecisionRecord | null> {
    const row = db.prepare(`SELECT payload_json FROM decisions WHERE org_id = ? AND id = ?`).get(orgId, decisionId) as { payload_json: string } | undefined;
    return row ? validateDecision(JSON.parse(row.payload_json) as DecisionRecord) : null;
  }

export async function listDecisions(db: Database.Database, input: { org_id: string; limit?: number }): Promise<DecisionRecord[]> {
    const rows = db.prepare(`SELECT payload_json FROM decisions WHERE org_id = ? ORDER BY committed_at, id LIMIT ?`).all(input.org_id, input.limit ?? 100) as Array<{ payload_json: string }>;
    return rows.map((row) => validateDecision(JSON.parse(row.payload_json) as DecisionRecord));
  }

export async function putReview(db: Database.Database, input: ReviewRecord): Promise<ReviewRecord> {
    
    const review = validateReview(input);
    db.prepare(`INSERT INTO reviews (id, org_id, subject_kind, subject_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`).run(review.id, review.org_id, review.subject_kind, review.subject_id, canonicalContextJson(review), review.created_at);
    const stored = await getReview(db, review.org_id, review.id);
    if (!stored || canonicalContextJson(stored) !== canonicalContextJson(review)) throw new Error("Cannot replace immutable Review");
    return stored;
  }

export async function getReview(db: Database.Database, orgId: string, reviewId: string): Promise<ReviewRecord | null> {
    const row = db.prepare(`SELECT payload_json FROM reviews WHERE org_id = ? AND id = ?`).get(orgId, reviewId) as { payload_json: string } | undefined;
    return row ? validateReview(JSON.parse(row.payload_json) as ReviewRecord) : null;
  }

export async function listReviews(db: Database.Database, input: { org_id: string; subject_id?: string; limit?: number }): Promise<ReviewRecord[]> {
    const rows = db.prepare(`SELECT payload_json FROM reviews WHERE org_id = ? ${input.subject_id ? "AND subject_id = ?" : ""} ORDER BY created_at, id LIMIT ?`).all(...(input.subject_id ? [input.org_id, input.subject_id, input.limit ?? 100] : [input.org_id, input.limit ?? 100])) as Array<{ payload_json: string }>;
    return rows.map((row) => validateReview(JSON.parse(row.payload_json) as ReviewRecord));
  }

export async function putHandoff(db: Database.Database, input: HandoffRecord): Promise<HandoffRecord> {
    
    const handoff = validateHandoff(input);
    if (handoff.status !== "open") throw new Error("New Handoff must be open");
    db.prepare(`INSERT INTO handoffs (id, org_id, direction, status, payload_json, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, NULL) ON CONFLICT (id) DO NOTHING`).run(handoff.id, handoff.org_id, handoff.direction, handoff.status, canonicalContextJson(handoff), handoff.created_at);
    const row = db.prepare(`SELECT status, payload_json, resolved_at FROM handoffs WHERE org_id = ? AND id = ?`).get(handoff.org_id, handoff.id) as HandoffRow | undefined;
    if (!row) throw new Error("Cannot replace immutable Handoff");
    const storedCreation = validateHandoff(JSON.parse(row.payload_json) as HandoffRecord);
    if (canonicalContextJson(storedCreation) !== canonicalContextJson({
      ...handoff, created_at: storedCreation.created_at,
    })) {
      throw new Error("Cannot replace immutable Handoff");
    }
    return toHandoff(row);
  }

export async function getHandoff(db: Database.Database, orgId: string, handoffId: string): Promise<HandoffRecord | null> {
    const row = db.prepare(`SELECT status, payload_json, resolved_at FROM handoffs WHERE org_id = ? AND id = ?`).get(orgId, handoffId) as HandoffRow | undefined;
    return row ? toHandoff(row) : null;
  }

export async function listHandoffs(db: Database.Database, input: { org_id: string; status?: HandoffStatus; direction?: HandoffDirection; limit?: number }): Promise<HandoffRecord[]> {
    const conditions = ["org_id = ?"];
    const values: Array<string | number> = [input.org_id];
    if (input.status) { conditions.push("status = ?"); values.push(input.status); }
    if (input.direction) { conditions.push("direction = ?"); values.push(input.direction); }
    values.push(input.limit ?? 100);
    const rows = db.prepare(`SELECT status, payload_json, resolved_at FROM handoffs WHERE ${conditions.join(" AND ")} ORDER BY created_at, id LIMIT ?`).all(...values) as HandoffRow[];
    return rows.map(toHandoff);
  }

export async function transitionHandoff(db: Database.Database, input: { org_id: string; handoff_id: string; status: Exclude<HandoffStatus, "open">; transitioned_at: string }): Promise<HandoffRecord | null> {
    
    if (!input.org_id?.trim() || !input.handoff_id?.trim() || Number.isNaN(Date.parse(input.transitioned_at))) throw new Error("Invalid Handoff transition");
    return db.transaction(() => {
      const row = db.prepare(`SELECT status, payload_json, resolved_at FROM handoffs WHERE org_id = ? AND id = ?`).get(input.org_id, input.handoff_id) as HandoffRow | undefined;
      if (!row) return null;
      const current = toHandoff(row);
      assertHandoffTransition(current.status, input.status);
      const next = validateHandoff({
        ...current,
        status: input.status,
        ...(input.status === "resolved" ? { resolved_at: input.transitioned_at } : {}),
      });
      db.prepare(`UPDATE handoffs SET status = ?, resolved_at = ? WHERE org_id = ? AND id = ? AND status = ?`).run(next.status, next.resolved_at ?? null, input.org_id, input.handoff_id, current.status);
      return next;
    })();
  }

export function getProposalSync(db: Database.Database, orgId: string, proposalId: string): ProposalRecord | null {
    const row = db.prepare(`SELECT status, payload_json, updated_at, outcome_kind, outcome_ref_id FROM proposals WHERE org_id = ? AND id = ?`).get(orgId, proposalId) as ProposalRow | undefined;
    return row ? toProposal(row) : null;
  }

export interface ProposalRow {
  status: ProposalStatus;
  payload_json: string;
  updated_at: string;
  outcome_kind: "standard_version" | "decision" | "claim" | "none" | null;
  outcome_ref_id: string | null;
}

export interface HandoffRow {
  status: HandoffStatus;
  payload_json: string;
  resolved_at: string | null;
}

export function toHandoff(row: HandoffRow): HandoffRecord {
  return validateHandoff({
    ...(JSON.parse(row.payload_json) as HandoffRecord),
    status: row.status,
    ...(row.resolved_at ? { resolved_at: row.resolved_at } : {}),
  });
}

export function toProposal(row: ProposalRow): ProposalRecord {
  const proposal = validateProposal({
    ...(JSON.parse(row.payload_json) as ProposalRecord),
    status: row.status,
    updated_at: row.updated_at,
  });
  return {
    ...proposal,
    ...(row.outcome_kind
      ? { outcome_ref: { outcome_kind: row.outcome_kind, ...(row.outcome_ref_id ? { ref_id: row.outcome_ref_id } : {}) } }
      : {}),
  };
}
