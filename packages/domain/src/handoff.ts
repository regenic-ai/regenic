import type { ActorRef } from "./actor";
import type { StandardBinding } from "./decision";
import type { JsonValue } from "./ingestion";
import { JsonValueSchema } from "./ingestion-schema";

export const HANDOFF_SCHEMA_VERSION = "1.0" as const;

export type HandoffDirection = "agent_to_human" | "human_to_agent";
export type HandoffStatus = "open" | "acked" | "resolved" | "cancelled";
export type HandoffReason =
  | "standard_uncovered"
  | "evidence_conflict"
  | "permission_denied"
  | "acceptance_failed"
  | "escalation_boundary"
  | "approve_proposal"
  | "revise_standard"
  | "enrich_context"
  | "set_boundary"
  | "retry_with_binding";

const AGENT_TO_HUMAN_REASONS: HandoffReason[] = [
  "standard_uncovered",
  "evidence_conflict",
  "permission_denied",
  "acceptance_failed",
  "escalation_boundary",
];
const HUMAN_TO_AGENT_REASONS: HandoffReason[] = [
  "approve_proposal",
  "revise_standard",
  "enrich_context",
  "set_boundary",
  "retry_with_binding",
];

export interface HandoffRecord {
  schema_version: typeof HANDOFF_SCHEMA_VERSION;
  id: string;
  org_id: string;
  direction: HandoffDirection;
  from: ActorRef;
  to: ActorRef;
  reason: HandoffReason;
  proposal_id?: string;
  decision_id?: string;
  agent_run_id?: string;
  context_snapshot_id: string;
  standard_bindings: StandardBinding[];
  payload: Record<string, JsonValue>;
  status: HandoffStatus;
  created_at: string;
  resolved_at?: string;
}

export interface HandoffStore {
  putHandoff(handoff: HandoffRecord): Promise<HandoffRecord>;
  getHandoff(orgId: string, handoffId: string): Promise<HandoffRecord | null>;
  listHandoffs(input: {
    org_id: string;
    status?: HandoffStatus;
    direction?: HandoffDirection;
    limit?: number;
  }): Promise<HandoffRecord[]>;
  transitionHandoff(input: {
    org_id: string;
    handoff_id: string;
    status: Exclude<HandoffStatus, "open">;
    transitioned_at: string;
  }): Promise<HandoffRecord | null>;
}

export function validateHandoff(handoff: HandoffRecord): HandoffRecord {
  if (!handoff || handoff.schema_version !== HANDOFF_SCHEMA_VERSION
    || !handoff.id?.trim() || !handoff.org_id?.trim()
    || !handoff.context_snapshot_id?.trim()
    || !validActor(handoff.from) || !validActor(handoff.to)
    || !["agent_to_human", "human_to_agent"].includes(handoff.direction)
    || !["open", "acked", "resolved", "cancelled"].includes(handoff.status)
    || Number.isNaN(Date.parse(handoff.created_at))) {
    throw new Error("Invalid Handoff");
  }
  const validDirection = handoff.direction === "agent_to_human"
    ? handoff.from.actor_type === "agent" && handoff.to.actor_type === "human"
      && AGENT_TO_HUMAN_REASONS.includes(handoff.reason)
    : handoff.from.actor_type === "human" && handoff.to.actor_type === "agent"
      && HUMAN_TO_AGENT_REASONS.includes(handoff.reason);
  if (!validDirection) throw new Error("Invalid Handoff direction or reason");
  if ([handoff.proposal_id, handoff.decision_id, handoff.agent_run_id]
    .some((value) => value !== undefined && !value.trim())) {
    throw new Error("Invalid Handoff reference");
  }
  if (!Array.isArray(handoff.standard_bindings) || handoff.standard_bindings.some((binding) =>
    !binding.standard_id?.trim() || !binding.version_id?.trim()
  )) throw new Error("Invalid Handoff standard binding");
  if (!handoff.payload || typeof handoff.payload !== "object" || Array.isArray(handoff.payload)
    || Object.keys(handoff.payload).length === 0 || !JsonValueSchema.safeParse(handoff.payload).success) {
    throw new Error("Invalid Handoff payload");
  }
  if (handoff.status === "resolved") {
    if (!handoff.resolved_at || Number.isNaN(Date.parse(handoff.resolved_at))
      || Date.parse(handoff.resolved_at) < Date.parse(handoff.created_at)) {
      throw new Error("Resolved Handoff requires resolved_at");
    }
  } else if (handoff.resolved_at !== undefined) {
    throw new Error("Unresolved Handoff cannot have resolved_at");
  }
  return structuredClone(handoff);
}

export function assertHandoffTransition(current: HandoffStatus, next: Exclude<HandoffStatus, "open">): void {
  const allowed = (current === "open" && ["acked", "cancelled"].includes(next))
    || (current === "acked" && ["resolved", "cancelled"].includes(next));
  if (!allowed) throw new Error(`Invalid Handoff transition: ${current} -> ${next}`);
}

function validActor(actor: ActorRef | undefined): actor is ActorRef {
  return !!actor?.actor_id?.trim() && ["human", "agent"].includes(actor.actor_type);
}
