import { readFile } from "node:fs/promises";
import {
  PROPOSAL_SCHEMA_VERSION,
  STANDARD_GAP_SCHEMA_VERSION,
  STANDARD_SCHEMA_VERSION,
  STANDARD_VERSION_SCHEMA_VERSION,
  detectStandardHealth,
  hashCanonicalContext,
  hashStandardVersionBody,
  validateIterationGate,
  validateStandardScope,
  validateTrialConfig,
  validateUpgradeEvidence,
  type IterationGate,
  type ProposalRecord,
  type StandardGapRecord,
  type StandardGapStatus,
  type StandardLayer,
  type StandardRecord,
  type StandardScope,
  type StandardVersionRecord,
  type StandardVersionStatus,
  type TrialConfig,
  type UpgradeEvidence,
} from "@regenic/domain";
import {
  assertObjectKeys,
  cliBoolean,
  cliStringArray,
  isObject,
  optionPath,
  optionString,
  readJsonObject,
  requireOption,
  requirePath,
  requirePositiveInteger,
  requireString,
  writeJson,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";
import { withLocalHost, withLocalReadOnlyHost } from "../host";

export async function commitStandardVersion(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  const spec = await readJsonObject(requirePath(options, "spec"), "StandardVersion spec");
  assertObjectKeys(spec, new Set([
    "slug", "title", "layer", "scope", "target_standard_id", "supersedes_version_id",
    "version", "condition", "action", "acceptance", "boundary", "revision_trigger",
    "gate", "trial",
  ]), "StandardVersion spec");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const proposalId = requireOption(options, "proposal");
    const proposal = await host.get("proposals").getProposal(orgId, proposalId);
    if (!proposal || !["new_standard", "revise_standard"].includes(proposal.kind)
      || !["in_review", "accepted"].includes(proposal.status) || !proposal.single_uncertainty) {
      throw new Error("StandardVersion commit requires an in-review Standard Proposal");
    }
    const gate = validateIterationGate(spec.gate as IterationGate);
    if (gate.single_uncertainty !== proposal.single_uncertainty) throw new Error("IterationGate must preserve the Proposal uncertainty");
    const at = now();
    let standard: StandardRecord | undefined;
    let standardId: string;
    let supersedesVersionId: string | undefined;
    if (proposal.kind === "new_standard") {
      if (spec.target_standard_id !== undefined || spec.supersedes_version_id !== undefined) throw new Error("New Standard cannot set target or superseded version");
      const slug = requireString(spec.slug);
      const layer = requireString(spec.layer);
      if (!["stable_core", "adjacent", "frontier"].includes(layer)) throw new Error("Invalid Standard layer");
      standardId = `standard:${hashCanonicalContext([orgId, slug])}`;
      standard = {
        schema_version: STANDARD_SCHEMA_VERSION,
        id: standardId,
        org_id: orgId,
        slug,
        title: requireString(spec.title),
        layer: layer as StandardLayer,
        scope: cliStandardScope(spec.scope, orgId),
        created_at: at,
        created_by: proposal.author,
        citation_count: 0,
      };
    } else {
      if (spec.slug !== undefined || spec.title !== undefined || spec.layer !== undefined || spec.scope !== undefined) throw new Error("Revised StandardVersion cannot replace Standard identity");
      standardId = requireString(spec.target_standard_id);
      supersedesVersionId = requireString(spec.supersedes_version_id);
      if (!await host.get("standards").getStandard(orgId, standardId)) throw new Error("Standard was not found");
      if (!proposal.standard_bindings.some((binding) => binding.standard_id === standardId && binding.version_id === supersedesVersionId)) {
        throw new Error("Revision Proposal must pin the superseded StandardVersion");
      }
    }
    const body = {
      condition: requireString(spec.condition),
      action: requireString(spec.action),
      acceptance: requireString(spec.acceptance),
      boundary: requireString(spec.boundary),
      revision_trigger: requireString(spec.revision_trigger),
    };
    const version: StandardVersionRecord = {
      schema_version: STANDARD_VERSION_SCHEMA_VERSION,
      id: `standard-version:${hashCanonicalContext([orgId, proposal.id])}`,
      org_id: orgId,
      standard_id: standardId,
      proposal_id: proposal.id,
      version: requireString(spec.version),
      status: "draft",
      ...body,
      gate,
      ...(spec.trial === undefined ? {} : { trial: cliTrialConfig(spec.trial, orgId) }),
      ...(supersedesVersionId ? { supersedes_version_id: supersedesVersionId } : {}),
      body_hash: hashStandardVersionBody(body),
      created_at: at,
    };
    writeJson(stdout, await host.get("standards").commitProposalStandardVersion({
      org_id: orgId, proposal_id: proposal.id, ...(standard ? { standard } : {}), version,
    }));
  });
}

export async function listStandards(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    writeJson(stdout, await host.get("standards").listStandards({ org_id: orgId, limit: 100 }));
  });
}

export async function getStandard(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const standard = await host.get("standards").getStandard(orgId, requireOption(options, "standard"));
    if (!standard) throw new Error("Standard was not found");
    writeJson(stdout, standard);
  });
}

export async function listStandardVersions(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  const standardId = requireOption(options, "standard");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    if (!await host.get("standards").getStandard(orgId, standardId)) throw new Error("Standard was not found");
    writeJson(stdout, await host.get("standards").listStandardVersions({ org_id: orgId, standard_id: standardId, limit: 100 }));
  });
}

export async function projectStandardUsageCommand(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  const sourceKind = cliStandardUsageSourceKind(requireOption(options, "source-kind"));
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    writeJson(stdout, await host.get("standard-usage").projectStandardUsage({
      org_id: orgId, source_kind: sourceKind, source_id: requireOption(options, "source"),
    }));
  });
}

export async function listStandardUsageCommand(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  const standardId = requireOption(options, "standard");
  const versionId = optionString(options, "version");
  const sourceKind = optionString(options, "source-kind");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const standard = await host.get("standards").getStandard(orgId, standardId);
    if (!standard) throw new Error("Standard was not found");
    if (versionId) {
      const version = await host.get("standards").getStandardVersion(orgId, versionId);
      if (!version || version.standard_id !== standard.id) throw new Error("StandardVersion does not belong to Standard");
    }
    writeJson(stdout, await host.get("standard-usage").listStandardUsage({
      org_id: orgId,
      standard_id: standard.id,
      ...(versionId ? { version_id: versionId } : {}),
      ...(sourceKind ? { source_kind: cliStandardUsageSourceKind(sourceKind) } : {}),
      limit: 100,
    }));
  });
}

function cliStandardUsageSourceKind(value: string): "decision" | "agent_run" {
  if (!["decision", "agent_run"].includes(value)) throw new Error("Invalid StandardUsage source kind");
  return value as "decision" | "agent_run";
}

export async function listStandardHealthCommand(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
): Promise<void> {
  const orgId = requireOption(options, "org");
  const observedAt = optionString(options, "observed-at") ?? now();
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(observedAt) || Number.isNaN(Date.parse(observedAt))) {
    throw new Error("--observed-at must be a timestamp with timezone");
  }
  const staleAfterDays = requirePositiveInteger(options, "stale-after-days", 90);
  if (staleAfterDays > 3_650) throw new Error("--stale-after-days must be from 1 to 3650");
  const limit = optionString(options, "limit") === undefined
    ? 100
    : requirePositiveInteger(options, "limit", 100);
  if (limit > 100) throw new Error("--limit must be from 1 to 100");
  const afterCreatedAt = optionString(options, "after-created-at");
  const afterId = optionString(options, "after-id");
  if (!!afterCreatedAt !== !!afterId) throw new Error("--after-created-at and --after-id must be provided together");
  if (afterCreatedAt && (!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(afterCreatedAt) || Number.isNaN(Date.parse(afterCreatedAt)))) {
    throw new Error("--after-created-at must be a timestamp with timezone");
  }
  await withLocalReadOnlyHost(requirePath(options, "database"), async (host) => {
    const standards = await host.get("standards").listStandards({
      org_id: orgId,
      limit: limit + 1,
      ...(afterCreatedAt ? { after_created_at: afterCreatedAt, after_id: afterId! } : {}),
    });
    const page = standards.slice(0, limit);
    const observations = [];
    for (const standard of page) {
      if (!standard.current_version_id) continue;
      const version = await host.get("standards").getStandardVersion(orgId, standard.current_version_id);
      if (!version) throw new Error("Standard current version was not found");
      const totalUsageCount = await host.get("standard-usage").countStandardUsage({
        org_id: orgId, standard_id: standard.id,
      });
      const currentVersionUsageCount = await host.get("standard-usage").countStandardUsage({
        org_id: orgId, standard_id: standard.id, version_id: version.id,
      });
      const [latestUsage] = await host.get("standard-usage").listStandardUsage({
        org_id: orgId, standard_id: standard.id, version_id: version.id,
        newest_first: true, limit: 1,
      });
      observations.push({
        standard,
        current_version: version,
        total_usage_count: totalUsageCount,
        current_version_usage_count: currentVersionUsageCount,
        ...(latestUsage ? { latest_usage: latestUsage } : {}),
      });
    }
    const next = standards.length > limit ? page.at(-1) : undefined;
    writeJson(stdout, {
      candidates: detectStandardHealth(observations, {
        observed_at: observedAt,
        stale_after_days: staleAfterDays,
      }),
      next_after: next ? { created_at: next.created_at, id: next.id } : null,
    });
  });
}

export async function getStandardVersion(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const version = await host.get("standards").getStandardVersion(orgId, requireOption(options, "version"));
    if (!version) throw new Error("StandardVersion was not found");
    writeJson(stdout, version);
  });
}

export async function transitionCliStandardVersion(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  status: Exclude<StandardVersionStatus, "draft">,
): Promise<void> {
  const orgId = requireOption(options, "org");
  const upgradePath = optionPath(options, "upgrade-evidence");
  const deprecationPath = optionPath(options, "deprecation-evidence");
  const replacementId = optionString(options, "replacement");
  const eventId = optionString(options, "event");
  if (status !== "active" && upgradePath) throw new Error("--upgrade-evidence is valid only when publishing active");
  if (status !== "deprecated" && (deprecationPath || replacementId || eventId)) throw new Error("Deprecation inputs are valid only when deprecating");
  if (deprecationPath && eventId) throw new Error("Provide --deprecation-evidence or --event, not both");
  const upgradeEvidence = upgradePath
    ? cliUpgradeEvidence(await readJsonObject(upgradePath, "UpgradeEvidence"))
    : undefined;
  const deprecationEvidence = deprecationPath
    ? await readEvidenceArray(deprecationPath, "Deprecation evidence")
    : eventId ? [{ kind: "document" as const, uri_or_ref: `event:${eventId}` }] : undefined;
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    for (const evidence of deprecationEvidence ?? []) {
      if (!evidence.uri_or_ref.startsWith("event:")) continue;
      if (!await host.get("authority").getEvent(orgId, evidence.uri_or_ref.slice("event:".length))) {
        throw new Error("Deprecation evidence Event was not found");
      }
    }
    const version = await host.get("standards").transitionStandardVersion({
      org_id: orgId,
      version_id: requireOption(options, "version"),
      status,
      actor: { actor_type: "human", actor_id: orgId },
      transitioned_at: now(),
      ...(upgradeEvidence ? { upgrade_evidence: upgradeEvidence } : {}),
      ...(deprecationEvidence ? { deprecation_evidence: deprecationEvidence } : {}),
      ...(replacementId ? { superseded_by_version_id: replacementId } : {}),
    });
    if (!version) throw new Error("StandardVersion was not found");
    writeJson(stdout, version);
  });
}

function cliStandardScope(value: unknown, orgId: string): StandardScope {
  if (!isObject(value)) throw new Error("Standard scope must be an object");
  assertObjectKeys(value, new Set(["org_id", "team_ids", "roles", "decision_kinds"]), "Standard scope");
  if (value.org_id !== undefined && value.org_id !== orgId) throw new Error("Standard scope organization mismatch");
  return validateStandardScope({
    org_id: orgId,
    team_ids: cliStringArray(value.team_ids),
    roles: cliStringArray(value.roles),
    decision_kinds: cliStringArray(value.decision_kinds),
  }, orgId);
}

function cliTrialConfig(value: unknown, orgId: string): TrialConfig {
  if (!isObject(value)) throw new Error("Trial config must be an object");
  assertObjectKeys(value, new Set(["audience", "starts_at", "ends_at", "success_metric", "stop_condition"]), "Trial config");
  return validateTrialConfig({
    audience: cliStandardScope(value.audience, orgId),
    starts_at: requireString(value.starts_at),
    ...(value.ends_at === undefined ? {} : { ends_at: requireString(value.ends_at) }),
    success_metric: requireString(value.success_metric),
    stop_condition: requireString(value.stop_condition),
  });
}

function cliUpgradeEvidence(value: Record<string, unknown>): UpgradeEvidence {
  assertObjectKeys(value, new Set([
    "core_value_revalidated", "delivery_standardized", "unit_economics_or_roi_ok",
    "next_tier_behavioral_evidence", "rollback_safe", "waiver_reason",
  ]), "UpgradeEvidence");
  return validateUpgradeEvidence({
    core_value_revalidated: cliBoolean(value.core_value_revalidated, "core_value_revalidated"),
    delivery_standardized: cliBoolean(value.delivery_standardized, "delivery_standardized"),
    unit_economics_or_roi_ok: cliBoolean(value.unit_economics_or_roi_ok, "unit_economics_or_roi_ok"),
    next_tier_behavioral_evidence: cliBoolean(value.next_tier_behavioral_evidence, "next_tier_behavioral_evidence"),
    rollback_safe: cliBoolean(value.rollback_safe, "rollback_safe"),
    ...(value.waiver_reason === undefined ? {} : { waiver_reason: requireString(value.waiver_reason) }),
  });
}

async function readEvidenceArray(path: string, name: string): Promise<ProposalRecord["evidence"]> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error(`${name} must be valid JSON`); }
  if (!Array.isArray(parsed)) throw new Error(`${name} must be an array`);
  return parsed.map((entry) => {
    if (!isObject(entry)) throw new Error(`${name} entries must be objects`);
    assertObjectKeys(entry, new Set(["kind", "uri_or_ref", "note", "claim_ids"]), name);
    const kind = requireString(entry.kind);
    if (!["data", "demo", "user_quote", "document", "other"].includes(kind)) throw new Error(`Invalid ${name} kind`);
    return {
      kind: kind as ProposalRecord["evidence"][number]["kind"],
      uri_or_ref: requireString(entry.uri_or_ref),
      ...(entry.note === undefined ? {} : { note: requireString(entry.note) }),
      ...(entry.claim_ids === undefined ? {} : { claim_ids: cliStringArray(entry.claim_ids) }),
    };
  });
}

export async function createManualStandardGap(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  await putCliStandardGap(options, stdout, now, {
    source_kind: "manual",
    source_ref: requireOption(options, "request"),
  });
}

export async function createReviewStandardGap(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  const reviewId = requireOption(options, "review");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const review = await host.get("reviews").getReview(orgId, reviewId);
    if (!review) throw new Error("Review was not found");
    if (review.result !== "falsified" || !["open_gap", "revise_standard"].includes(review.recommended_action)) {
      throw new Error("Review does not recommend a StandardGap");
    }
  });
  await putCliStandardGap(options, stdout, now, { source_kind: "review", source_ref: reviewId });
}

async function putCliStandardGap(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  source: Pick<StandardGapRecord, "source_kind" | "source_ref">,
): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const at = now();
    writeJson(stdout, await host.get("standard-gaps").putStandardGap({
      schema_version: STANDARD_GAP_SCHEMA_VERSION,
      id: `standard-gap:${hashCanonicalContext([orgId, source.source_kind, source.source_ref])}`,
      org_id: orgId,
      summary: requireOption(options, "summary"),
      source_kind: source.source_kind,
      source_ref: source.source_ref,
      proposed_uncertainty: requireOption(options, "uncertainty"),
      status: "open",
      created_by: { actor_type: "human", actor_id: orgId },
      created_at: at,
      updated_at: at,
    }));
  });
}

export async function listStandardGaps(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  const status = optionString(options, "status");
  if (status && !["open", "converted", "dismissed"].includes(status)) throw new Error("Invalid StandardGap status");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    writeJson(stdout, await host.get("standard-gaps").listStandardGaps({
      org_id: orgId, ...(status ? { status: status as StandardGapStatus } : {}), limit: 100,
    }));
  });
}

export async function getStandardGap(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const gap = await host.get("standard-gaps").getStandardGap(orgId, requireOption(options, "gap"));
    if (!gap) throw new Error("StandardGap was not found");
    writeJson(stdout, gap);
  });
}

export async function convertStandardGap(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const gap = await host.get("standard-gaps").getStandardGap(orgId, requireOption(options, "gap"));
    if (!gap) throw new Error("StandardGap was not found");
    const snapshotId = requireOption(options, "snapshot");
    const sourceReview = gap.source_kind === "review"
      ? await host.get("reviews").getReview(orgId, gap.source_ref)
      : null;
    if (gap.source_kind === "review" && !sourceReview) throw new Error("Source Review was not found");
    if (sourceReview && sourceReview.context_snapshot_id !== snapshotId) {
      throw new Error("Review-sourced StandardGap must preserve the Review snapshot");
    }
    if (!await host.get("context-artifacts").getSnapshot(orgId, snapshotId)) throw new Error("Context snapshot was not found");
    const eventId = requireOption(options, "event");
    if (!await host.get("authority").getEvent(orgId, eventId)) throw new Error("Proposal evidence Event was not found");
    const kind = requireOption(options, "kind");
    if (!["new_standard", "revise_standard"].includes(kind)) throw new Error("StandardGap can convert only to a Standard Proposal");
    let bindings: ProposalRecord["standard_bindings"] = [];
    if (kind === "revise_standard") {
      const standardId = requireOption(options, "standard");
      const versionId = requireOption(options, "version");
      const standard = await host.get("standards").getStandard(orgId, standardId);
      const version = await host.get("standards").getStandardVersion(orgId, versionId);
      if (!standard || !version || version.standard_id !== standard.id) {
        throw new Error("Revision StandardVersion was not found");
      }
      if (sourceReview?.subject_kind === "agent_run") {
        const sourceRun = await host.get("agent-runs").getAgentRun(orgId, sourceReview.subject_id);
        if (!sourceRun || !sourceRun.standard_bindings.some((binding) =>
          binding.standard_id === standard.id && binding.version_id === version.id
        )) throw new Error("Revision target is outside the reviewed AgentRun bindings");
      }
      if (sourceReview?.subject_kind === "decision") {
        const sourceDecision = await host.get("decisions").getDecision(orgId, sourceReview.subject_id);
        if (!sourceDecision || !sourceDecision.standard_bindings.some((binding) =>
          binding.standard_id === standard.id && binding.version_id === version.id
        )) throw new Error("Revision target is outside the reviewed Decision bindings");
      }
      if (sourceReview?.subject_kind === "standard_version" && sourceReview.subject_id !== version.id) {
        throw new Error("Revision target is outside the reviewed StandardVersion");
      }
      if (gap.status === "open"
        && (standard.current_version_id !== version.id || ["draft", "deprecated"].includes(version.status))) {
        throw new Error("Revision must pin the current published StandardVersion");
      }
      bindings = [{ standard_id: standard.id, version_id: version.id }];
    } else if (optionString(options, "standard") || optionString(options, "version")) {
      throw new Error("New Standard Proposal cannot set a target version");
    }
    const rights = optionString(options, "rights") ?? "coach";
    if (!["direct", "coach", "negotiate", "authorize", "delegate"].includes(rights)) throw new Error("Invalid rights level");
    const at = now();
    const proposal: ProposalRecord = {
      schema_version: PROPOSAL_SCHEMA_VERSION,
      id: `proposal:${hashCanonicalContext([orgId, gap.id])}`,
      org_id: orgId,
      kind: kind as "new_standard" | "revise_standard",
      title: requireOption(options, "title"),
      summary: requireOption(options, "proposal-summary"),
      status: "draft",
      author: { actor_type: "human", actor_id: orgId },
      rights_level: rights as ProposalRecord["rights_level"],
      boundary: requireOption(options, "boundary"),
      context_snapshot_id: snapshotId,
      standard_bindings: bindings,
      single_uncertainty: gap.proposed_uncertainty,
      evidence: [
        { kind: "document", uri_or_ref: `standard-gap:${gap.id}` },
        { kind: "document", uri_or_ref: `event:${eventId}` },
      ],
      gap_id: gap.id,
      created_at: at,
      updated_at: at,
    };
    writeJson(stdout, await host.get("standard-gaps").convertStandardGap({ org_id: orgId, gap_id: gap.id, proposal }));
  });
}

export async function dismissStandardGap(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const gap = await host.get("standard-gaps").dismissStandardGap({
      org_id: orgId, gap_id: requireOption(options, "gap"), dismissed_at: now(),
    });
    if (!gap) throw new Error("StandardGap was not found");
    writeJson(stdout, gap);
  });
}

