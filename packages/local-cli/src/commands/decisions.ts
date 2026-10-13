import {
  DECISION_SCHEMA_VERSION,
  hashCanonicalContext,
  type DecisionRecord,
} from "@regenic/domain";
import {
  optionString,
  projectCliStandardUsageBestEffort,
  requireOption,
  requirePath,
  writeJson,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";
import { withLocalHost } from "../host";

export async function commitDecision(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const proposalId = requireOption(options, "proposal");
    const proposal = await host.get("proposals").getProposal(orgId, proposalId);
    const coDeciders = (optionString(options, "co-deciders") ?? "").split(",").map((value) => value.trim()).filter(Boolean).map((actorId) => ({ actor_type: "human" as const, actor_id: actorId }));
    const summary = requireOption(options, "summary");
    const rationale = requireOption(options, "rationale");
    if (proposal?.status === "accepted" && proposal.outcome_ref?.outcome_kind === "decision" && proposal.outcome_ref.ref_id) {
      const existing = await host.get("decisions").getDecision(orgId, proposal.outcome_ref.ref_id);
      if (!existing || existing.summary !== summary || existing.rationale !== rationale
        || hashCanonicalContext(existing.co_deciders) !== hashCanonicalContext(coDeciders)) {
        throw new Error("Cannot replace committed Decision");
      }
      await projectCliStandardUsageBestEffort(host, {
        org_id: orgId, source_kind: "decision", source_id: existing.id,
      });
      writeJson(stdout, { proposal, decision: existing });
      return;
    }
    if (!proposal || proposal.kind !== "decision" || proposal.status !== "in_review" || !proposal.context_snapshot_id) throw new Error("Decision commit requires an in-review decision Proposal");
    const decision: DecisionRecord = {
      schema_version: DECISION_SCHEMA_VERSION,
      id: `decision:${hashCanonicalContext([orgId, proposal.id])}`,
      org_id: orgId, proposal_id: proposal.id, summary,
      rationale, decided_by: { actor_type: "human", actor_id: orgId },
      co_deciders: coDeciders, rights_level: proposal.rights_level,
      context_snapshot_id: proposal.context_snapshot_id, standard_bindings: proposal.standard_bindings,
      status: "committed", committed_at: now(),
    };
    const committed = await host.get("decisions").commitProposalDecision({ org_id: orgId, proposal_id: proposal.id, decision });
    await projectCliStandardUsageBestEffort(host, {
      org_id: orgId, source_kind: "decision", source_id: committed.decision.id,
    });
    writeJson(stdout, committed);
  });
}

export async function listDecisions(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => writeJson(stdout, await host.get("decisions").listDecisions({ org_id: orgId, limit: 100 })));
}

export async function getDecision(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const decision = await host.get("decisions").getDecision(orgId, requireOption(options, "decision"));
    if (!decision) throw new Error("Decision was not found");
    writeJson(stdout, decision);
  });
}

