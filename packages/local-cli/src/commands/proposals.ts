import {
  PROPOSAL_SCHEMA_VERSION,
  hashCanonicalContext,
  type ProposalKind,
  type ProposalRecord,
} from "@regenic/domain";
import {
  cliStandardBindings,
  isObject,
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

export async function createProposalFromDigest(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const artifactId = requireOption(options, "digest");
    const eventId = requireOption(options, "event");
    const direction = requireOption(options, "direction");
    const artifacts = host.get("context-artifacts");
    const artifact = await artifacts.getArtifact(orgId, artifactId);
    const state = artifact ? await artifacts.getArtifactState(orgId, artifact.id) : null;
    if (!artifact || artifact.kind !== "daily_digest" || state?.status !== "accepted" || !artifact.body_hash || hashCanonicalContext(artifact.attrs) !== artifact.body_hash) throw new Error("Proposal intake requires an accepted valid daily digest");
    const item = cliDigestItem(artifact.attrs, direction, eventId);
    const kind = cliProposalKind(item.item_kind);
    const head = artifact.input_refs.find((reference) => reference.event_id === eventId);
    if (!head) throw new Error("Digest item is not bound to artifact evidence");
    const evidence = artifact.input_refs.filter((reference) => reference.source === head.source && reference.external_id === head.external_id).map((reference) => ({ kind: "document" as const, uri_or_ref: `event:${reference.event_id}` }));
    evidence.unshift({ kind: "document", uri_or_ref: `artifact:${artifact.id}` });
    const at = now();
    const summary = requireString(item.text);
    const proposal: ProposalRecord = {
      schema_version: PROPOSAL_SCHEMA_VERSION,
      id: `proposal:${hashCanonicalContext([orgId, artifact.id, direction, eventId])}`,
      org_id: orgId, kind, title: summary.split(/\r?\n/, 1)[0].slice(0, 120), summary,
      status: "draft", author: { actor_type: "human", actor_id: orgId }, rights_level: "coach",
      boundary: optionalString(options.boundary) ?? `${direction} daily digest item`,
      standard_bindings: [],
      ...(optionalString(options.uncertainty) ? { single_uncertainty: optionalString(options.uncertainty)! } : {}),
      evidence, source_digest_id: artifact.id, source_item_event_id: eventId,
      created_at: at, updated_at: at,
    };
    writeJson(stdout, await host.get("proposals").putProposal(proposal));
  });
}

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

function cliDigestItem(attrs: unknown, direction: string, eventId: string): { item_kind: string; text: unknown } {
  if (!isObject(attrs) || !Array.isArray(attrs.directions)) throw new Error("Invalid daily digest body");
  const bucket = attrs.directions.find((value) => isObject(value) && value.direction === direction);
  const item = isObject(bucket) && Array.isArray(bucket.items) ? bucket.items.find((value) => isObject(value) && value.event_id === eventId) : undefined;
  if (!isObject(item)) throw new Error("Daily digest item was not found");
  return item as { item_kind: string; text: unknown };
}

function cliProposalKind(itemKind: string): ProposalKind {
  if (itemKind === "hypothesis") return "hypothesis";
  if (itemKind === "new_judgment") return "new_standard";
  if (itemKind === "standard_amendment") return "revise_standard";
  throw new Error("Digest item kind cannot create a Proposal");
}

