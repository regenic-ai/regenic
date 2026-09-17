import type { ActorRef } from "./actor";
import type { ProposalEvidenceRef } from "./proposal";

export const REVIEW_SCHEMA_VERSION = "1.0" as const;

export interface ReviewRecord {
  schema_version: typeof REVIEW_SCHEMA_VERSION;
  id: string;
  org_id: string;
  subject_kind: "standard_version" | "decision" | "hypothesis_claim" | "agent_run";
  subject_id: string;
  result: "validated" | "falsified" | "inconclusive";
  severity: "normal" | "bad_news";
  evidence: ProposalEvidenceRef[];
  context_snapshot_id: string;
  recommended_action: "solidify" | "revise_standard" | "open_gap" | "none";
  author: ActorRef;
  created_at: string;
}

export interface ReviewStore {
  putReview(review: ReviewRecord): Promise<ReviewRecord>;
  getReview(orgId: string, reviewId: string): Promise<ReviewRecord | null>;
  listReviews(input: { org_id: string; subject_id?: string; limit?: number }): Promise<ReviewRecord[]>;
}

export function validateReview(review: ReviewRecord): ReviewRecord {
  if (!review || review.schema_version !== REVIEW_SCHEMA_VERSION
    || !review.id?.trim() || !review.org_id?.trim() || !review.subject_id?.trim()
    || !review.context_snapshot_id?.trim()
    || !["standard_version", "decision", "hypothesis_claim", "agent_run"].includes(review.subject_kind)
    || !["validated", "falsified", "inconclusive"].includes(review.result)
    || !["normal", "bad_news"].includes(review.severity)
    || !["solidify", "revise_standard", "open_gap", "none"].includes(review.recommended_action)
    || !review.author?.actor_id?.trim() || !["human", "agent", "system"].includes(review.author.actor_type)
    || Number.isNaN(Date.parse(review.created_at))) {
    throw new Error("Invalid Review");
  }
  if (!Array.isArray(review.evidence) || !review.evidence.length || review.evidence.some((item) =>
    !["data", "demo", "user_quote", "document", "other"].includes(item.kind)
    || !item.uri_or_ref?.trim()
  )) throw new Error("Invalid Review evidence");
  if (review.result !== "inconclusive" && !review.evidence.some((item) => item.kind !== "other")) {
    throw new Error("Conclusive Review requires non-other evidence");
  }
  if (review.result === "falsified" && review.recommended_action === "solidify") {
    throw new Error("Falsified Review cannot recommend solidify");
  }
  return structuredClone(review);
}
