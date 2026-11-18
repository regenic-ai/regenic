import {
  PROPOSAL_SCHEMA_VERSION,
  hashCanonicalContext,
  type ProposalRecord,
} from "@regenic/domain";
import {
  cliStandardBindings,
  optionalString,
  optionString,
  requireOption,
  requirePath,
  requireString,
  writeJson,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";
import { withLocalHost } from "../host";


export async function listProposals(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => writeJson(stdout, await host.get("proposals").listProposals({ org_id: orgId, limit: 100 })));
}

export async function getProposal(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const proposal = await host.get("proposals").getProposal(orgId, requireOption(options, "proposal"));
    if (!proposal) throw new Error("Proposal was not found");
    writeJson(stdout, proposal);
  });
}

export async function createDecisionProposal(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const snapshotId = requireOption(options, "snapshot");
    if (!await host.get("context-artifacts").getSnapshot(orgId, snapshotId)) throw new Error("Context snapshot was not found");
    const eventId = requireOption(options, "event");
    if (!await host.get("authority").getEvent(orgId, eventId)) throw new Error("Proposal evidence Event was not found");
    const proposalId = `proposal:${hashCanonicalContext([orgId, requireOption(options, "request")])}`;
    const existing = await host.get("proposals").getProposal(orgId, proposalId);
    const bindings = cliStandardBindings(optionString(options, "bindings"));
    for (const binding of bindings) {
      const standard = await host.get("standards").getStandard(orgId, binding.standard_id);
      const version = await host.get("standards").getStandardVersion(orgId, binding.version_id);
      if (!standard || !version || version.standard_id !== standard.id
        || (!existing && !["trial", "active"].includes(version.status))) {
        throw new Error("Decision Proposal binding must pin a published StandardVersion");
      }
    }
    const at = now();
    const rights = optionString(options, "rights") ?? "coach";
    if (!["direct", "coach", "negotiate", "authorize", "delegate"].includes(rights)) throw new Error("Invalid rights level");
    const proposal: ProposalRecord = {
      schema_version: PROPOSAL_SCHEMA_VERSION,
      id: proposalId,
      org_id: orgId, kind: "decision", title: requireOption(options, "title"),
      summary: requireOption(options, "summary"), status: "draft",
      author: { actor_type: "human", actor_id: orgId }, rights_level: rights as ProposalRecord["rights_level"],
      boundary: requireOption(options, "boundary"), context_snapshot_id: snapshotId,
      standard_bindings: bindings, evidence: [{ kind: "document", uri_or_ref: `event:${eventId}` }],
      created_at: at, updated_at: at,
    };
    writeJson(stdout, await host.get("proposals").putProposal(proposal));
  });
}

export async function transitionProposal(options: CommandOptions, stdout: CliOutput, now: () => string, status: "submitted" | "in_review" | "rejected" | "withdrawn"): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const proposal = await host.get("proposals").transitionProposal({ org_id: orgId, proposal_id: requireOption(options, "proposal"), status, updated_at: now() });
    if (!proposal) throw new Error("Proposal was not found");
    writeJson(stdout, proposal);
  });
}

export async function createStandardProposal(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  kind: "new_standard" | "revise_standard",
): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const snapshotId = requireOption(options, "snapshot");
    if (!await host.get("context-artifacts").getSnapshot(orgId, snapshotId)) throw new Error("Context snapshot was not found");
    const eventId = requireOption(options, "event");
    if (!await host.get("authority").getEvent(orgId, eventId)) throw new Error("Proposal evidence Event was not found");
    const rights = optionString(options, "rights") ?? "coach";
    if (!["direct", "coach", "negotiate", "authorize", "delegate"].includes(rights)) throw new Error("Invalid rights level");
    let standardBindings: ProposalRecord["standard_bindings"] = [];
    if (kind === "revise_standard") {
      const standardId = requireOption(options, "standard");
      const supersedesId = requireOption(options, "supersedes");
      const standard = await host.get("standards").getStandard(orgId, standardId);
      const superseded = await host.get("standards").getStandardVersion(orgId, supersedesId);
      if (!standard || !superseded || superseded.standard_id !== standard.id || superseded.status === "draft") {
        throw new Error("Revision must pin a published StandardVersion");
      }
      standardBindings = [{ standard_id: standard.id, version_id: superseded.id }];
    }
    const at = now();
    const proposal: ProposalRecord = {
      schema_version: PROPOSAL_SCHEMA_VERSION,
      id: `proposal:${hashCanonicalContext([orgId, requireOption(options, "request")])}`,
      org_id: orgId,
      kind,
      title: requireOption(options, "title"),
      summary: requireOption(options, "summary"),
      status: "draft",
      author: { actor_type: "human", actor_id: orgId },
      rights_level: rights as ProposalRecord["rights_level"],
      boundary: requireOption(options, "boundary"),
      context_snapshot_id: snapshotId,
      standard_bindings: standardBindings,
      single_uncertainty: requireOption(options, "uncertainty"),
      evidence: [{ kind: "document", uri_or_ref: `event:${eventId}` }],
      created_at: at,
      updated_at: at,
    };
    writeJson(stdout, await host.get("proposals").putProposal(proposal));
  });
}


