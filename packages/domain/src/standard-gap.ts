import type { ActorRef } from "./actor";
import type { ProposalRecord } from "./proposal";

export const STANDARD_GAP_SCHEMA_VERSION = "1.0" as const;

export type StandardGapSourceKind =
  | "execution_failure"
  | "exception"
  | "three_questions"
  | "review"
  | "manual";
export type StandardGapStatus = "open" | "converted" | "dismissed";

export interface StandardGapRecord {
  schema_version: typeof STANDARD_GAP_SCHEMA_VERSION;
  id: string;
  org_id: string;
  summary: string;
  source_kind: StandardGapSourceKind;
  source_ref: string;
  proposed_uncertainty: string;
  status: StandardGapStatus;
  created_by: ActorRef;
  created_at: string;
  updated_at: string;
  converted_proposal_id?: string;
}

export interface StandardGapStore {
  putStandardGap(gap: StandardGapRecord): Promise<StandardGapRecord>;
  getStandardGap(orgId: string, gapId: string): Promise<StandardGapRecord | null>;
  listStandardGaps(input: {
    org_id: string;
    status?: StandardGapStatus;
    limit?: number;
  }): Promise<StandardGapRecord[]>;
  convertStandardGap(input: {
    org_id: string;
    gap_id: string;
    proposal: ProposalRecord;
  }): Promise<{ gap: StandardGapRecord; proposal: ProposalRecord }>;
  dismissStandardGap(input: {
    org_id: string;
    gap_id: string;
    dismissed_at: string;
  }): Promise<StandardGapRecord | null>;
}

export function validateStandardGap(input: StandardGapRecord): StandardGapRecord {
  if (!input || input.schema_version !== STANDARD_GAP_SCHEMA_VERSION
    || !nonBlank(input.id) || !nonBlank(input.org_id) || !nonBlank(input.summary)
    || !["execution_failure", "exception", "three_questions", "review", "manual"].includes(input.source_kind)
    || !nonBlank(input.source_ref) || !nonBlank(input.proposed_uncertainty)
    || !["open", "converted", "dismissed"].includes(input.status)
    || !validActor(input.created_by)
    || !validTimestamp(input.created_at) || !validTimestamp(input.updated_at)
    || Date.parse(input.updated_at) < Date.parse(input.created_at)) {
    throw new Error("Invalid StandardGap");
  }
  if (input.status === "converted") {
    if (!nonBlank(input.converted_proposal_id)) {
      throw new Error("Converted StandardGap requires Proposal");
    }
  } else if (input.converted_proposal_id !== undefined) {
    throw new Error("Unconverted StandardGap cannot reference Proposal");
  }
  return structuredClone(input);
}

export function validateStandardGapConversion(gapInput: StandardGapRecord, proposalInput: ProposalRecord): void {
  const gap = validateStandardGap(gapInput);
  if (gap.status !== "open" || proposalInput.status !== "draft"
    || !["new_standard", "revise_standard"].includes(proposalInput.kind)
    || proposalInput.org_id !== gap.org_id || proposalInput.gap_id !== gap.id
    || proposalInput.single_uncertainty !== gap.proposed_uncertainty
    || !proposalInput.context_snapshot_id
    || Date.parse(proposalInput.created_at) < Date.parse(gap.created_at)) {
    throw new Error("Invalid StandardGap conversion");
  }
}

export function standardGapState(input: StandardGapRecord): {
  status: StandardGapStatus;
  updated_at: string;
  converted_proposal_id?: string;
} {
  const gap = validateStandardGap(input);
  return {
    status: gap.status,
    updated_at: gap.updated_at,
    ...(gap.converted_proposal_id ? { converted_proposal_id: gap.converted_proposal_id } : {}),
  };
}

function validActor(actor: ActorRef | undefined): actor is ActorRef {
  return !!actor && nonBlank(actor.actor_id) && ["human", "agent", "system"].includes(actor.actor_type);
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}
