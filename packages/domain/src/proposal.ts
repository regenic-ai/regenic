import type { ActorRef } from "./actor";

export const PROPOSAL_SCHEMA_VERSION = "1.0" as const;

export type ProposalKind =
  | "new_standard"
  | "revise_standard"
  | "decision"
  | "context_update"
  | "hypothesis";

export type ProposalStatus =
  | "draft"
  | "submitted"
  | "in_review"
  | "accepted"
  | "rejected"
  | "withdrawn";

export type DecisionRightsLevel = "direct" | "coach" | "negotiate" | "authorize" | "delegate";
export type ProposalEvidenceKind = "data" | "demo" | "user_quote" | "document" | "other";

export interface ProposalEvidenceRef {
  kind: ProposalEvidenceKind;
  uri_or_ref: string;
  note?: string;
  claim_ids?: string[];
}

export interface ProposalRecord {
  schema_version: typeof PROPOSAL_SCHEMA_VERSION;
  id: string;
  org_id: string;
  kind: ProposalKind;
  title: string;
  summary: string;
  status: ProposalStatus;
  author: ActorRef;
  rights_level: DecisionRightsLevel;
  boundary: string;
  context_snapshot_id?: string;
  standard_bindings: Array<{ standard_id: string; version_id: string }>;
  single_uncertainty?: string;
  evidence: ProposalEvidenceRef[];
  gap_id?: string;
  outcome_ref?: { outcome_kind: "standard_version" | "decision" | "claim" | "none"; ref_id?: string };
  source_digest_id?: string;
  source_item_event_id?: string;
  created_at: string;
  updated_at: string;
}

export interface ProposalStore {
  putProposal(proposal: ProposalRecord): Promise<ProposalRecord>;
  getProposal(orgId: string, proposalId: string): Promise<ProposalRecord | null>;
  listProposals(input: { org_id: string; status?: ProposalStatus; limit?: number }): Promise<ProposalRecord[]>;
  transitionProposal(input: {
    org_id: string;
    proposal_id: string;
    status: "submitted" | "withdrawn";
    updated_at: string;
  }): Promise<ProposalRecord | null>;
}

export function validateProposal(proposal: ProposalRecord): ProposalRecord {
  if (!proposal || proposal.schema_version !== PROPOSAL_SCHEMA_VERSION
    || !proposal.id?.trim() || !proposal.org_id?.trim() || !proposal.title?.trim()
    || !proposal.summary?.trim() || !proposal.boundary?.trim()
    || !proposal.author?.actor_id?.trim() || !["human", "agent", "system"].includes(proposal.author.actor_type)
    || Number.isNaN(Date.parse(proposal.created_at)) || Number.isNaN(Date.parse(proposal.updated_at))) {
    throw new Error("Invalid Proposal");
  }
  if (![
    "new_standard", "revise_standard", "decision", "context_update", "hypothesis",
  ].includes(proposal.kind)
    || !["draft", "submitted", "in_review", "accepted", "rejected", "withdrawn"].includes(proposal.status)
    || !["direct", "coach", "negotiate", "authorize", "delegate"].includes(proposal.rights_level)) {
    throw new Error("Invalid Proposal enum");
  }
  if (!proposal.evidence.length || proposal.evidence.some((item) =>
    !["data", "demo", "user_quote", "document", "other"].includes(item.kind)
    || !item.uri_or_ref?.trim()
  )) throw new Error("Invalid Proposal evidence");
  if (proposal.status === "submitted" && !proposal.evidence.some((item) => item.kind !== "other")) {
    throw new Error("Submitted Proposal requires non-other evidence");
  }
  if (["new_standard", "revise_standard"].includes(proposal.kind)
    && proposal.status === "submitted"
    && (!proposal.context_snapshot_id || !proposal.single_uncertainty?.trim())) {
    throw new Error("Submitted standard Proposal requires snapshot and uncertainty");
  }
  return structuredClone(proposal);
}
