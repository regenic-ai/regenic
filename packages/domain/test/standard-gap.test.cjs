const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { validateStandardGap, validateStandardGapConversion } = require("../dist");

function gap(overrides = {}) {
  return {
    schema_version: "1.0",
    id: "gap-1",
    org_id: "example-org",
    summary: "Release safety is not covered.",
    source_kind: "review",
    source_ref: "review-1",
    proposed_uncertainty: "Can this release process prevent regressions?",
    status: "open",
    created_by: { actor_type: "human", actor_id: "person-1" },
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

function proposal(overrides = {}) {
  return {
    schema_version: "1.0",
    id: "proposal-1",
    org_id: "example-org",
    kind: "new_standard",
    title: "Create release safety standard",
    summary: "Create a bounded release safety standard.",
    status: "draft",
    author: { actor_type: "human", actor_id: "person-1" },
    rights_level: "coach",
    boundary: "Release governance only",
    context_snapshot_id: "snapshot-1",
    standard_bindings: [],
    single_uncertainty: gap().proposed_uncertainty,
    evidence: [{ kind: "document", uri_or_ref: "review:review-1" }],
    gap_id: "gap-1",
    created_at: "2026-09-20T01:00:00.000Z",
    updated_at: "2026-09-20T01:00:00.000Z",
    ...overrides,
  };
}

describe("StandardGap contract", () => {
  it("keeps conversion state coherent and timestamps monotonic", () => {
    assert.equal(validateStandardGap(gap()).status, "open");
    assert.throws(() => validateStandardGap(gap({ status: "converted" })), /requires Proposal/);
    assert.throws(() => validateStandardGap(gap({ converted_proposal_id: "proposal-1" })), /cannot reference Proposal/);
    assert.throws(() => validateStandardGap(gap({ updated_at: "2026-09-19T00:00:00.000Z" })), /Invalid StandardGap/);
    assert.equal(validateStandardGap(gap({
      status: "converted",
      converted_proposal_id: "proposal-1",
      updated_at: "2026-09-20T01:00:00.000Z",
    })).converted_proposal_id, "proposal-1");
  });

  it("converts only to a snapshot-pinned draft Standard Proposal", () => {
    assert.doesNotThrow(() => validateStandardGapConversion(gap(), proposal()));
    assert.throws(() => validateStandardGapConversion(gap(), proposal({ kind: "decision" })), /Invalid StandardGap conversion/);
    assert.throws(() => validateStandardGapConversion(gap(), proposal({ gap_id: "other-gap" })), /Invalid StandardGap conversion/);
    assert.throws(() => validateStandardGapConversion(gap(), proposal({ context_snapshot_id: undefined })), /Invalid StandardGap conversion/);
    assert.throws(() => validateStandardGapConversion(gap(), proposal({ single_uncertainty: "Different uncertainty" })), /Invalid StandardGap conversion/);
    assert.throws(() => validateStandardGapConversion(gap(), proposal({ created_at: "2026-09-19T00:00:00.000Z" })), /Invalid StandardGap conversion/);
  });
});
