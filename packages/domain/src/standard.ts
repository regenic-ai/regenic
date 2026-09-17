import type { ActorRef } from "./actor";
import { hashCanonicalContext } from "./context-canonical";
import type { ProposalEvidenceRef, ProposalRecord } from "./proposal";

export const STANDARD_SCHEMA_VERSION = "1.0" as const;
export const STANDARD_VERSION_SCHEMA_VERSION = "1.0" as const;

export type StandardLayer = "stable_core" | "adjacent" | "frontier";
export type StandardVersionStatus = "draft" | "trial" | "active" | "deprecated";
export type TargetUserTier = "innovator" | "early_adopter" | "early_majority" | "late_majority" | "laggard";
export type LearningOutput = "new_standard" | "revision" | "no_standard_needed";

export interface StandardScope {
  org_id: string;
  team_ids: string[];
  roles: string[];
  decision_kinds: string[];
}

export interface UpgradeEvidence {
  core_value_revalidated: boolean;
  delivery_standardized: boolean;
  unit_economics_or_roi_ok: boolean;
  next_tier_behavioral_evidence: boolean;
  rollback_safe: boolean;
  waiver_reason?: string;
}

export interface IterationGate {
  single_uncertainty: string;
  target_user_tier: TargetUserTier;
  consensus_hypothesis: string;
  value_metric: string;
  cost_budget: string;
  validation_window: string;
  stop_condition: string;
  stable_core_preserved: boolean;
  compat_and_rollback: string;
  upgrade_evidence?: UpgradeEvidence;
  learning_output: LearningOutput;
}

export interface TrialConfig {
  audience: StandardScope;
  starts_at: string;
  ends_at?: string;
  success_metric: string;
  stop_condition: string;
}

export interface StandardRecord {
  schema_version: typeof STANDARD_SCHEMA_VERSION;
  id: string;
  org_id: string;
  slug: string;
  title: string;
  layer: StandardLayer;
  scope: StandardScope;
  created_at: string;
  created_by: ActorRef;
  current_version_id?: string;
  citation_count: number;
}

export interface StandardVersionRecord {
  schema_version: typeof STANDARD_VERSION_SCHEMA_VERSION;
  id: string;
  org_id: string;
  standard_id: string;
  proposal_id: string;
  version: string;
  status: StandardVersionStatus;
  condition: string;
  action: string;
  acceptance: string;
  boundary: string;
  revision_trigger: string;
  gate?: IterationGate;
  trial?: TrialConfig;
  supersedes_version_id?: string;
  body_hash: string;
  created_at: string;
  published_at?: string;
  published_by?: ActorRef;
  deprecated_at?: string;
  deprecated_by?: ActorRef;
  deprecation_evidence?: ProposalEvidenceRef[];
  superseded_by_version_id?: string;
}

export interface StandardVersionTransition {
  org_id: string;
  version_id: string;
  status: Exclude<StandardVersionStatus, "draft">;
  actor: ActorRef;
  transitioned_at: string;
  upgrade_evidence?: UpgradeEvidence;
  deprecation_evidence?: ProposalEvidenceRef[];
  superseded_by_version_id?: string;
}

export interface StandardVersionState {
  status: StandardVersionStatus;
  upgrade_evidence?: UpgradeEvidence;
  published_at?: string;
  published_by?: ActorRef;
  deprecated_at?: string;
  deprecated_by?: ActorRef;
  deprecation_evidence?: ProposalEvidenceRef[];
  superseded_by_version_id?: string;
}

export interface StandardStore {
  commitProposalStandardVersion(input: {
    org_id: string;
    proposal_id: string;
    standard?: StandardRecord;
    version: StandardVersionRecord;
  }): Promise<{ proposal: ProposalRecord; standard: StandardRecord; version: StandardVersionRecord }>;
  getStandard(orgId: string, standardId: string): Promise<StandardRecord | null>;
  getStandardBySlug(orgId: string, slug: string): Promise<StandardRecord | null>;
  listStandards(input: { org_id: string; limit?: number }): Promise<StandardRecord[]>;
  getStandardVersion(orgId: string, versionId: string): Promise<StandardVersionRecord | null>;
  listStandardVersions(input: { org_id: string; standard_id: string; limit?: number }): Promise<StandardVersionRecord[]>;
  transitionStandardVersion(input: StandardVersionTransition): Promise<StandardVersionRecord | null>;
}

export function hashStandardVersionBody(version: Pick<StandardVersionRecord,
  "condition" | "action" | "acceptance" | "boundary" | "revision_trigger"
>): string {
  return hashCanonicalContext({
    condition: version.condition,
    action: version.action,
    acceptance: version.acceptance,
    boundary: version.boundary,
    revision_trigger: version.revision_trigger,
  });
}

export function validateStandard(input: StandardRecord): StandardRecord {
  if (!input || input.schema_version !== STANDARD_SCHEMA_VERSION
    || !nonBlank(input.id) || !nonBlank(input.org_id) || !nonBlank(input.title)
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)
    || !["stable_core", "adjacent", "frontier"].includes(input.layer)
    || !validActor(input.created_by, ["human", "system"])
    || !validTimestamp(input.created_at)
    || (input.current_version_id !== undefined && !nonBlank(input.current_version_id))
    || !Number.isSafeInteger(input.citation_count) || input.citation_count < 0) {
    throw new Error("Invalid Standard");
  }
  validateStandardScope(input.scope, input.org_id);
  return structuredClone(input);
}

export function validateStandardVersion(input: StandardVersionRecord): StandardVersionRecord {
  if (!input || input.schema_version !== STANDARD_VERSION_SCHEMA_VERSION
    || !nonBlank(input.id) || !nonBlank(input.org_id) || !nonBlank(input.standard_id)
    || !nonBlank(input.proposal_id) || !isSemver(input.version)
    || !["draft", "trial", "active", "deprecated"].includes(input.status)
    || !nonBlank(input.condition) || !nonBlank(input.action) || !nonBlank(input.acceptance)
    || !nonBlank(input.boundary) || !nonBlank(input.revision_trigger)
    || input.body_hash !== hashStandardVersionBody(input)
    || !validTimestamp(input.created_at)
    || (input.supersedes_version_id !== undefined && !nonBlank(input.supersedes_version_id))) {
    throw new Error("Invalid StandardVersion");
  }
  if (input.gate) validateIterationGate(input.gate);
  if (input.trial) validateTrialConfig(input.trial);
  if (input.status === "draft") {
    if (input.published_at !== undefined || input.published_by !== undefined
      || input.deprecated_at !== undefined || input.deprecated_by !== undefined
      || input.deprecation_evidence !== undefined || input.superseded_by_version_id !== undefined) {
      throw new Error("Draft StandardVersion cannot have lifecycle outcome");
    }
  } else {
    if (!input.gate || !validTimestamp(input.published_at) || !validActor(input.published_by)) {
      throw new Error("Published StandardVersion requires gate and publisher");
    }
    if (Date.parse(input.published_at) < Date.parse(input.created_at)) {
      throw new Error("StandardVersion publication predates creation");
    }
  }
  if (input.status === "trial" && !input.trial) {
    throw new Error("Trial StandardVersion requires trial config");
  }
  if (["active", "deprecated"].includes(input.status)
    && (!input.gate?.upgrade_evidence || !upgradeEvidenceComplete(input.gate.upgrade_evidence))) {
    throw new Error("Active StandardVersion requires upgrade evidence");
  }
  if (input.status === "deprecated") {
    if (!validTimestamp(input.deprecated_at) || !validActor(input.deprecated_by)
      || Date.parse(input.deprecated_at) < Date.parse(input.published_at!)) {
      throw new Error("Deprecated StandardVersion requires deprecation metadata");
    }
    const evidence = input.deprecation_evidence ?? [];
    if (!input.superseded_by_version_id && !hasNonOtherEvidence(evidence)) {
      throw new Error("StandardVersion deprecation requires evidence or replacement");
    }
  } else if (input.deprecated_at !== undefined || input.deprecated_by !== undefined
    || input.deprecation_evidence !== undefined || input.superseded_by_version_id !== undefined) {
    throw new Error("Non-deprecated StandardVersion cannot have deprecation metadata");
  }
  return structuredClone(input);
}

export function transitionStandardVersion(
  currentInput: StandardVersionRecord,
  standardInput: StandardRecord,
  transition: StandardVersionTransition,
): StandardVersionRecord {
  const current = validateStandardVersion(currentInput);
  const standard = validateStandard(standardInput);
  if (current.org_id !== transition.org_id || standard.org_id !== transition.org_id
    || current.standard_id !== standard.id || current.id !== transition.version_id
    || !validActor(transition.actor) || !validTimestamp(transition.transitioned_at)
    || Date.parse(transition.transitioned_at) < Date.parse(current.created_at)
    || (current.published_at !== undefined
      && Date.parse(transition.transitioned_at) < Date.parse(current.published_at))) {
    throw new Error("Invalid StandardVersion transition");
  }
  if (transition.status === "trial") {
    if (current.status !== "draft" || !current.gate || !current.trial) {
      throw new Error("Invalid StandardVersion transition");
    }
    assertCurrentStandardHead(standard, current);
    assertStableCoreGate(standard, current.gate);
    assertTrialNarrower(standard.scope, current.trial.audience);
    return validateStandardVersion({
      ...current,
      status: "trial",
      published_at: transition.transitioned_at,
      published_by: transition.actor,
    });
  }
  if (transition.status === "active") {
    if (!["draft", "trial"].includes(current.status) || !current.gate) {
      throw new Error("Invalid StandardVersion transition");
    }
    assertCurrentStandardHead(standard, current);
    if (current.status === "draft") assertStableCoreGate(standard, current.gate);
    const upgradeEvidence = transition.upgrade_evidence ?? current.gate.upgrade_evidence;
    if (!upgradeEvidence || !upgradeEvidenceComplete(upgradeEvidence)) {
      throw new Error("Active StandardVersion requires upgrade evidence");
    }
    return validateStandardVersion({
      ...current,
      status: "active",
      gate: { ...current.gate, upgrade_evidence: validateUpgradeEvidence(upgradeEvidence) },
      published_at: current.published_at ?? transition.transitioned_at,
      published_by: current.published_by ?? transition.actor,
    });
  }
  if (transition.status === "deprecated") {
    if (current.status !== "active") throw new Error("Invalid StandardVersion transition");
    const deprecationEvidence = transition.deprecation_evidence ?? [];
    if (!transition.superseded_by_version_id && !hasNonOtherEvidence(deprecationEvidence)) {
      throw new Error("StandardVersion deprecation requires evidence or replacement");
    }
    if (transition.superseded_by_version_id === current.id) {
      throw new Error("StandardVersion cannot supersede itself");
    }
    return validateStandardVersion({
      ...current,
      status: "deprecated",
      deprecated_at: transition.transitioned_at,
      deprecated_by: transition.actor,
      ...(deprecationEvidence.length ? { deprecation_evidence: validateEvidence(deprecationEvidence) } : {}),
      ...(transition.superseded_by_version_id ? { superseded_by_version_id: transition.superseded_by_version_id } : {}),
    });
  }
  throw new Error("Invalid StandardVersion transition");
}

export function validateIterationGate(input: IterationGate): IterationGate {
  if (!input || !nonBlank(input.single_uncertainty)
    || !["innovator", "early_adopter", "early_majority", "late_majority", "laggard"].includes(input.target_user_tier)
    || !nonBlank(input.consensus_hypothesis) || !nonBlank(input.value_metric)
    || !nonBlank(input.cost_budget) || !nonBlank(input.validation_window)
    || !nonBlank(input.stop_condition) || typeof input.stable_core_preserved !== "boolean"
    || !nonBlank(input.compat_and_rollback)
    || !["new_standard", "revision", "no_standard_needed"].includes(input.learning_output)) {
    throw new Error("Invalid IterationGate");
  }
  if (input.upgrade_evidence) validateUpgradeEvidence(input.upgrade_evidence);
  return structuredClone(input);
}

export function validateUpgradeEvidence(input: UpgradeEvidence): UpgradeEvidence {
  if (!input || [
    input.core_value_revalidated,
    input.delivery_standardized,
    input.unit_economics_or_roi_ok,
    input.next_tier_behavioral_evidence,
    input.rollback_safe,
  ].some((value) => typeof value !== "boolean")
    || (input.waiver_reason !== undefined && !nonBlank(input.waiver_reason))) {
    throw new Error("Invalid UpgradeEvidence");
  }
  return structuredClone(input);
}

export function upgradeEvidenceComplete(input: UpgradeEvidence): boolean {
  const evidence = validateUpgradeEvidence(input);
  return evidence.core_value_revalidated
    && evidence.delivery_standardized
    && evidence.unit_economics_or_roi_ok
    && evidence.next_tier_behavioral_evidence
    && evidence.rollback_safe
    || nonBlank(evidence.waiver_reason);
}

export function validateStandardScope(input: StandardScope, expectedOrgId?: string): StandardScope {
  if (!input || !nonBlank(input.org_id) || (expectedOrgId !== undefined && input.org_id !== expectedOrgId)
    || !validStringSet(input.team_ids) || !validStringSet(input.roles)
    || !validStringSet(input.decision_kinds)) {
    throw new Error("Invalid Standard scope");
  }
  return structuredClone(input);
}

export function validateTrialConfig(input: TrialConfig): TrialConfig {
  if (!input || !validTimestamp(input.starts_at)
    || (input.ends_at !== undefined && (!validTimestamp(input.ends_at)
      || Date.parse(input.ends_at) <= Date.parse(input.starts_at)))
    || !nonBlank(input.success_metric) || !nonBlank(input.stop_condition)) {
    throw new Error("Invalid TrialConfig");
  }
  validateStandardScope(input.audience);
  return structuredClone(input);
}

function assertStableCoreGate(standard: StandardRecord, gate: IterationGate): void {
  if (standard.layer !== "frontier" && !gate.stable_core_preserved) {
    throw new Error("Non-frontier StandardVersion must preserve stable core");
  }
}

function assertCurrentStandardHead(standard: StandardRecord, version: StandardVersionRecord): void {
  const expectedHead = version.status === "draft"
    ? version.supersedes_version_id
    : version.id;
  if (standard.current_version_id !== expectedHead) {
    throw new Error("StandardVersion does not extend the current Standard head");
  }
}

function assertTrialNarrower(parent: StandardScope, audience: StandardScope): void {
  if (parent.org_id !== audience.org_id) throw new Error("Trial audience must stay in Standard scope");
  const dimensions: Array<[string[], string[]]> = [
    [parent.team_ids, audience.team_ids],
    [parent.roles, audience.roles],
    [parent.decision_kinds, audience.decision_kinds],
  ];
  let narrower = false;
  for (const [parentValues, audienceValues] of dimensions) {
    if (parentValues.length && (!audienceValues.length
      || audienceValues.some((value) => !parentValues.includes(value)))) {
      throw new Error("Trial audience must stay in Standard scope");
    }
    if ((!parentValues.length && audienceValues.length)
      || (parentValues.length && audienceValues.length < parentValues.length)) {
      narrower = true;
    }
  }
  if (!narrower) throw new Error("Trial audience must be narrower than Standard scope");
}

function hasNonOtherEvidence(input: ProposalEvidenceRef[]): boolean {
  return validateEvidence(input).some((item) => item.kind !== "other");
}

function validateEvidence(input: ProposalEvidenceRef[]): ProposalEvidenceRef[] {
  if (!Array.isArray(input) || input.some((item) =>
    !item || !["data", "demo", "user_quote", "document", "other"].includes(item.kind)
    || !nonBlank(item.uri_or_ref)
  )) throw new Error("Invalid Standard lifecycle evidence");
  return structuredClone(input);
}

function validActor(actor: ActorRef | undefined, allowed = ["human", "agent", "system"]): actor is ActorRef {
  return !!actor && nonBlank(actor.actor_id) && allowed.includes(actor.actor_type);
}

function validStringSet(input: string[]): boolean {
  return Array.isArray(input) && input.every(nonBlank) && new Set(input).size === input.length;
}

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isSemver(value: unknown): value is string {
  return typeof value === "string"
    && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value);
}
