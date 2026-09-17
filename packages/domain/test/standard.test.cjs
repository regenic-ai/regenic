const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  hashStandardVersionBody,
  transitionStandardVersion,
  validateStandard,
  validateStandardVersion,
} = require("../dist");

function standard(overrides = {}) {
  return {
    schema_version: "1.0",
    id: "standard-1",
    org_id: "example-org",
    slug: "release-safety",
    title: "Release safety",
    layer: "adjacent",
    scope: { org_id: "example-org", team_ids: [], roles: [], decision_kinds: ["release"] },
    created_at: "2026-09-18T00:00:00.000Z",
    created_by: { actor_type: "human", actor_id: "person-1" },
    citation_count: 0,
    ...overrides,
  };
}

function gate(overrides = {}) {
  return {
    single_uncertainty: "Can this release process prevent regressions?",
    target_user_tier: "early_adopter",
    consensus_hypothesis: "Teams need a bounded release check.",
    value_metric: "Escaped regressions per release",
    cost_budget: "Two engineer-days",
    validation_window: "14 days",
    stop_condition: "Rollback when one severe regression escapes.",
    stable_core_preserved: true,
    compat_and_rollback: "Keep the previous release path available.",
    learning_output: "new_standard",
    ...overrides,
  };
}

function upgrade(overrides = {}) {
  return {
    core_value_revalidated: true,
    delivery_standardized: true,
    unit_economics_or_roi_ok: true,
    next_tier_behavioral_evidence: true,
    rollback_safe: true,
    ...overrides,
  };
}

function version(overrides = {}) {
  const value = {
    schema_version: "1.0",
    id: "standard-version-1",
    org_id: "example-org",
    standard_id: "standard-1",
    proposal_id: "proposal-1",
    version: "1.0.0",
    status: "draft",
    condition: "A release changes production behavior.",
    action: "Run the bounded release check.",
    acceptance: "No severe regression escapes during the validation window.",
    boundary: "Escalate when rollback is unavailable.",
    revision_trigger: "A severe regression escapes the check.",
    gate: gate(),
    trial: {
      audience: { org_id: "example-org", team_ids: ["team-1"], roles: [], decision_kinds: ["release"] },
      starts_at: "2026-09-19T00:00:00.000Z",
      ends_at: "2026-10-03T00:00:00.000Z",
      success_metric: "Zero severe escaped regressions",
      stop_condition: "Stop after one severe escaped regression.",
    },
    body_hash: "",
    created_at: "2026-09-18T01:00:00.000Z",
    ...overrides,
  };
  value.body_hash = overrides.body_hash ?? hashStandardVersionBody(value);
  return value;
}

const actor = { actor_type: "human", actor_id: "person-1" };

function transition(status, overrides = {}) {
  return {
    org_id: "example-org",
    version_id: "standard-version-1",
    status,
    actor,
    transitioned_at: "2026-09-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("Standards machine", () => {
  it("validates stable identity and content-addressed draft bodies", () => {
    assert.equal(validateStandard(standard()).slug, "release-safety");
    assert.equal(validateStandardVersion(version()).status, "draft");
    assert.throws(() => validateStandard(standard({ slug: "Release Safety" })), /Invalid Standard/);
    assert.throws(() => validateStandardVersion(version({ body_hash: "a".repeat(64) })), /Invalid StandardVersion/);
    assert.throws(() => validateStandardVersion(version({ version: "latest" })), /Invalid StandardVersion/);
  });

  it("publishes only a narrower trial that preserves non-frontier stable core", () => {
    const published = transitionStandardVersion(version(), standard(), transition("trial"));
    assert.equal(published.status, "trial");
    assert.equal(published.published_at, "2026-09-19T00:00:00.000Z");
    assert.throws(() => transitionStandardVersion(
      version({ gate: gate({ stable_core_preserved: false }) }),
      standard(),
      transition("trial"),
    ), /preserve stable core/);
    assert.throws(() => transitionStandardVersion(
      version({ trial: { ...version().trial, audience: standard().scope } }),
      standard(),
      transition("trial"),
    ), /must be narrower/);
  });

  it("promotes a trial only with complete upgrade evidence", () => {
    const trial = transitionStandardVersion(version(), standard(), transition("trial"));
    const currentStandard = standard({ current_version_id: trial.id });
    assert.throws(() => transitionStandardVersion(trial, currentStandard, transition("active")), /requires upgrade evidence/);
    assert.throws(() => transitionStandardVersion(trial, currentStandard, transition("active", {
      transitioned_at: "2026-09-18T12:00:00.000Z",
      upgrade_evidence: upgrade(),
    })), /Invalid StandardVersion transition/);
    const active = transitionStandardVersion(trial, currentStandard, transition("active", { upgrade_evidence: upgrade() }));
    assert.equal(active.status, "active");
    assert.deepEqual(active.gate.upgrade_evidence, upgrade());
  });

  it("does not publish a draft based on a stale Standard head", () => {
    const staleDraft = version({ supersedes_version_id: "standard-version-0" });
    assert.throws(() => transitionStandardVersion(
      staleDraft,
      standard({ current_version_id: "standard-version-newer" }),
      transition("trial"),
    ), /does not extend the current Standard head/);
  });

  it("allows an audited waiver on the draft-to-active fast path", () => {
    const active = transitionStandardVersion(version(), standard(), transition("active", {
      upgrade_evidence: upgrade({ rollback_safe: false, waiver_reason: "Human-approved bounded exception." }),
    }));
    assert.equal(active.status, "active");
    assert.equal(active.gate.upgrade_evidence.rollback_safe, false);
  });

  it("requires evidence or an explicit replacement to deprecate an active version", () => {
    const active = transitionStandardVersion(version(), standard(), transition("active", { upgrade_evidence: upgrade() }));
    assert.throws(() => transitionStandardVersion(active, standard(), transition("deprecated", {
      transitioned_at: "2026-09-20T00:00:00.000Z",
    })), /requires evidence or replacement/);
    const deprecated = transitionStandardVersion(active, standard(), transition("deprecated", {
      transitioned_at: "2026-09-20T00:00:00.000Z",
      deprecation_evidence: [{ kind: "data", uri_or_ref: "event:event-1" }],
    }));
    assert.equal(deprecated.status, "deprecated");
    assert.throws(() => transitionStandardVersion(deprecated, standard(), transition("active")), /Invalid StandardVersion transition/);
  });
});
