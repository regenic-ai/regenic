import type { ActorRef } from "./actor";
import type { DecisionRightsLevel, ProposalRecord } from "./proposal";

export const DECISION_SCHEMA_VERSION = "1.0" as const;

export interface StandardBinding {
  standard_id: string;
  version_id: string;
}

export interface DecisionRecord {
  schema_version: typeof DECISION_SCHEMA_VERSION;
  id: string;
  org_id: string;
  proposal_id: string;
  summary: string;
  rationale: string;
  decided_by: ActorRef;
  co_deciders: ActorRef[];
  rights_level: DecisionRightsLevel;
  context_snapshot_id: string;
  standard_bindings: StandardBinding[];
  status: "committed" | "superseded" | "void";
  committed_at: string;
}

export interface DecisionStore {
  commitProposalDecision(input: {
    org_id: string;
    proposal_id: string;
    decision: DecisionRecord;
  }): Promise<{ proposal: ProposalRecord; decision: DecisionRecord }>;
  getDecision(orgId: string, decisionId: string): Promise<DecisionRecord | null>;
  listDecisions(input: { org_id: string; limit?: number }): Promise<DecisionRecord[]>;
}

export function validateDecision(decision: DecisionRecord): DecisionRecord {
  if (!decision || decision.schema_version !== DECISION_SCHEMA_VERSION
    || !decision.id?.trim() || !decision.org_id?.trim() || !decision.proposal_id?.trim()
    || !decision.summary?.trim() || !decision.rationale?.trim()
    || !decision.context_snapshot_id?.trim() || decision.status !== "committed"
    || !decision.decided_by?.actor_id?.trim()
    || !["human", "agent", "system"].includes(decision.decided_by.actor_type)
    || !["direct", "coach", "negotiate", "authorize", "delegate"].includes(decision.rights_level)
    || Number.isNaN(Date.parse(decision.committed_at))) {
    throw new Error("Invalid Decision");
  }
  if (decision.co_deciders.some((actor) =>
    !actor.actor_id?.trim() || !["human", "agent", "system"].includes(actor.actor_type)
  )) throw new Error("Invalid Decision co-decider");
  if (decision.rights_level === "negotiate" && decision.co_deciders.length === 0) {
    throw new Error("Negotiated Decision requires a co-decider");
  }
  if (decision.rights_level !== "negotiate" && decision.co_deciders.length > 0) {
    throw new Error("Only negotiated Decisions may have co-deciders");
  }
  if (decision.standard_bindings.some((binding) =>
    !binding.standard_id?.trim() || !binding.version_id?.trim()
  )) throw new Error("Invalid Decision standard binding");
  return structuredClone(decision);
}
