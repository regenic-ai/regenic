import {
  HANDOFF_SCHEMA_VERSION,
  hashCanonicalContext,
  type HandoffDirection,
  type HandoffReason,
  type HandoffRecord,
  type HandoffStatus,
  type JsonValue,
} from "@regenic/domain";
import {
  cliStandardBindings,
  isObject,
  optionString,
  requireOption,
  requirePath,
  writeJson,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";
import { withLocalHost } from "../host";

export async function createHandoff(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const snapshotId = requireOption(options, "snapshot");
    if (!await host.get("context-artifacts").getSnapshot(orgId, snapshotId)) throw new Error("Context snapshot was not found");
    const proposalId = optionString(options, "proposal");
    const proposal = proposalId ? await host.get("proposals").getProposal(orgId, proposalId) : null;
    if (proposalId && !proposal) throw new Error("Proposal was not found");
    const decisionId = optionString(options, "decision");
    const decision = decisionId ? await host.get("decisions").getDecision(orgId, decisionId) : null;
    if (decisionId && !decision) throw new Error("Decision was not found");
    if (proposal && decision && decision.proposal_id !== proposal.id) throw new Error("Handoff Proposal and Decision do not refer to the same outcome");
    const direction = cliHandoffDirection(requireOption(options, "direction"));
    const agentId = requireOption(options, "agent");
    const human = { actor_type: "human" as const, actor_id: orgId };
    const agent = { actor_type: "agent" as const, actor_id: agentId };
    const handoffs = host.get("handoffs");
    const id = `handoff:${hashCanonicalContext([orgId, requireOption(options, "request")])}`;
    const existing = await handoffs.getHandoff(orgId, id);
    const handoff: HandoffRecord = {
      schema_version: HANDOFF_SCHEMA_VERSION,
      id,
      org_id: orgId,
      direction,
      from: direction === "human_to_agent" ? human : agent,
      to: direction === "human_to_agent" ? agent : human,
      reason: cliHandoffReason(requireOption(options, "reason")),
      ...(proposalId ? { proposal_id: proposalId } : {}),
      ...(decisionId ? { decision_id: decisionId } : {}),
      context_snapshot_id: snapshotId,
      standard_bindings: cliStandardBindings(optionString(options, "bindings")),
      payload: cliHandoffPayload(requireOption(options, "payload")),
      status: "open",
      created_at: existing?.created_at ?? now(),
    };
    writeJson(stdout, await handoffs.putHandoff(handoff));
  });
}

export async function listHandoffs(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  const status = optionString(options, "status");
  const direction = optionString(options, "direction");
  if (status && !["open", "acked", "resolved", "cancelled"].includes(status)) throw new Error("Invalid Handoff status");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    writeJson(stdout, await host.get("handoffs").listHandoffs({
      org_id: orgId,
      ...(status ? { status: status as HandoffStatus } : {}),
      ...(direction ? { direction: cliHandoffDirection(direction) } : {}),
      limit: 100,
    }));
  });
}

export async function getHandoff(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const handoff = await host.get("handoffs").getHandoff(orgId, requireOption(options, "handoff"));
    if (!handoff) throw new Error("Handoff was not found");
    writeJson(stdout, handoff);
  });
}

export async function transitionHandoff(options: CommandOptions, stdout: CliOutput, now: () => string, status: Exclude<HandoffStatus, "open">): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const handoff = await host.get("handoffs").transitionHandoff({
      org_id: orgId, handoff_id: requireOption(options, "handoff"), status, transitioned_at: now(),
    });
    if (!handoff) throw new Error("Handoff was not found");
    writeJson(stdout, handoff);
  });
}

function cliHandoffDirection(value: string): HandoffDirection {
  if (!["agent_to_human", "human_to_agent"].includes(value)) throw new Error("Invalid Handoff direction");
  return value as HandoffDirection;
}

export function cliHandoffReason(value: string): HandoffReason {
  if (![
    "standard_uncovered", "evidence_conflict", "permission_denied", "acceptance_failed",
    "escalation_boundary", "approve_proposal", "revise_standard", "enrich_context",
    "set_boundary", "retry_with_binding",
  ].includes(value)) throw new Error("Invalid Handoff reason");
  return value as HandoffReason;
}

function cliHandoffPayload(value: string): Record<string, JsonValue> {
  let payload: unknown;
  try { payload = JSON.parse(value); } catch { throw new Error("Handoff payload must be valid JSON"); }
  if (!isObject(payload) || Object.keys(payload).length === 0) throw new Error("Handoff payload must be a non-empty object");
  return payload as Record<string, JsonValue>;
}

