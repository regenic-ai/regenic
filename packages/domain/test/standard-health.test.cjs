const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { detectStandardHealth, hashStandardVersionBody } = require("../dist");

function standard(overrides = {}) {
  return {
    schema_version: "1.0",
    id: "standard-1",
    org_id: "example-org",
    slug: "release-safety",
    title: "Release safety",
    layer: "adjacent",
    scope: { org_id: "example-org", team_ids: [], roles: [], decision_kinds: ["release"] },
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: { actor_type: "human", actor_id: "person-1" },
    current_version_id: "version-1",
    citation_count: 0,
    ...overrides,
  };
}

function version(overrides = {}) {
  const body = {
    condition: "A release changes production behavior.",
    action: "Run the bounded release check.",
    acceptance: "No severe regression escapes.",
    boundary: "Escalate when rollback is unavailable.",
    revision_trigger: "A severe regression escapes.",
  };
  return {
    schema_version: "1.0",
    id: "version-1",
    org_id: "example-org",
    standard_id: "standard-1",
    proposal_id: "proposal-1",
    version: "1.0.0",
    status: "active",
    ...body,
    gate: {
      single_uncertainty: "Can this process prevent regressions?",
      target_user_tier: "early_adopter",
      consensus_hypothesis: "Teams need a bounded release check.",
      value_metric: "Escaped regressions",
      cost_budget: "Two engineer-days",
      validation_window: "14 days",
      stop_condition: "Stop after one severe regression.",
      stable_core_preserved: true,
      compat_and_rollback: "Keep the previous path.",
      learning_output: "new_standard",
      upgrade_evidence: {
        core_value_revalidated: true,
        delivery_standardized: true,
        unit_economics_or_roi_ok: true,
        next_tier_behavioral_evidence: true,
        rollback_safe: true,
      },
    },
    body_hash: hashStandardVersionBody(body),
    created_at: "2026-01-01T00:00:00.000Z",
    published_at: "2026-01-02T00:00:00.000Z",
    published_by: { actor_type: "human", actor_id: "person-1" },
    ...overrides,
  };
}

function usage(overrides = {}) {
  return {
    schema_version: "1.0",
    id: "usage-1",
    org_id: "example-org",
    standard_id: "standard-1",
    version_id: "version-1",
    source_kind: "agent_run",
    source_id: "run-1",
    context_snapshot_id: "snapshot-1",
    cited_at: "2026-01-10T00:00:00.000Z",
    ...overrides,
  };
}

const options = { observed_at: "2026-02-15T00:00:00.000Z", stale_after_days: 30 };

describe("Standard health detector", () => {
  it("surfaces an active Standard that was never cited after the window", () => {
    const [candidate] = detectStandardHealth([{
      standard: standard(), current_version: version(),
      total_usage_count: 0, current_version_usage_count: 0,
    }], options);
    assert.equal(candidate.reason, "never_cited");
    assert.equal(candidate.citation_count, 0);
    assert.equal(candidate.standard_citation_count, 0);
    assert.equal(candidate.recommendation, "review_deprecate_or_merge");
  });

  it("surfaces stale usage but not recent usage", () => {
    const stale = detectStandardHealth([{
      standard: standard({ citation_count: 1 }),
      current_version: version(),
      total_usage_count: 1,
      current_version_usage_count: 1,
      latest_usage: usage(),
    }], options);
    assert.equal(stale[0].reason, "stale_usage");
    assert.equal(stale[0].last_cited_at, usage().cited_at);
    assert.deepEqual(detectStandardHealth([{
      standard: standard({ citation_count: 1 }),
      current_version: version(),
      total_usage_count: 1,
      current_version_usage_count: 1,
      latest_usage: usage({ cited_at: "2026-02-10T00:00:00.000Z" }),
    }], options), []);
  });

  it("ignores trial versions and young active versions", () => {
    assert.deepEqual(detectStandardHealth([{
      standard: standard(),
      total_usage_count: 0,
      current_version_usage_count: 0,
      current_version: version({ status: "trial", trial: {
        audience: { org_id: "example-org", team_ids: ["team-1"], roles: [], decision_kinds: ["release"] },
        starts_at: "2026-01-02T00:00:00.000Z",
        success_metric: "Zero regressions",
        stop_condition: "Stop after one regression.",
      } }),
    }], options), []);
    assert.deepEqual(detectStandardHealth([{
      standard: standard(),
      total_usage_count: 0,
      current_version_usage_count: 0,
      current_version: version({ published_at: "2026-02-01T00:00:00.000Z" }),
    }], options), []);
  });

  it("rejects citation-count drift and duplicate observations", () => {
    assert.throws(() => detectStandardHealth([{
      standard: standard({ citation_count: 1 }), current_version: version(),
      total_usage_count: 0, current_version_usage_count: 0,
    }], options), /citation count/);
    assert.throws(() => detectStandardHealth([
      { standard: standard(), current_version: version(), total_usage_count: 0, current_version_usage_count: 0 },
      { standard: standard(), current_version: version(), total_usage_count: 0, current_version_usage_count: 0 },
    ], options), /Duplicate Standard health observation/);
  });

  it("does not let old-version usage satisfy current-version health", () => {
    assert.throws(() => detectStandardHealth([{
      standard: standard({ citation_count: 1 }),
      current_version: version(),
      total_usage_count: 1,
      current_version_usage_count: 1,
      latest_usage: usage({ version_id: "version-old" }),
    }], options), /Invalid Standard health usage/);
  });

  it("requires an explicit timezone for deterministic observation", () => {
    assert.throws(() => detectStandardHealth([], {
      observed_at: "2026-02-15T00:00:00",
      stale_after_days: 30,
    }), /Invalid Standard health detection input/);
    assert.doesNotThrow(() => detectStandardHealth([], {
      observed_at: "2026-02-15T08:00:00+08:00",
      stale_after_days: 30,
    }));
  });
});
