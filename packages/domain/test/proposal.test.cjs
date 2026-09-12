const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { validateProposal } = require("../dist");

function proposal(overrides = {}) {
  return {
    schema_version: "1.0",
    id: "proposal-1",
    org_id: "example-org",
    kind: "hypothesis",
    title: "Review launch timing",
    summary: "The launch timing needs review.",
    status: "draft",
    author: { actor_type: "human", actor_id: "person-1" },
    rights_level: "coach",
    boundary: "product launch",
    standard_bindings: [],
    evidence: [{ kind: "document", uri_or_ref: "event:event-1" }],
    created_at: "2026-08-30T01:00:00.000Z",
    updated_at: "2026-08-30T01:00:00.000Z",
    ...overrides,
  };
}

describe("Proposal contract", () => {
  it("requires non-other evidence before submission", () => {
    assert.throws(() => validateProposal(proposal({
      status: "submitted",
      evidence: [{ kind: "other", uri_or_ref: "note:1" }],
    })), /non-other evidence/);
    assert.equal(validateProposal(proposal({ status: "submitted" })).status, "submitted");
  });

  it("requires a snapshot and one uncertainty for submitted standard proposals", () => {
    assert.throws(() => validateProposal(proposal({
      kind: "new_standard", status: "submitted",
    })), /snapshot and uncertainty/);
    assert.equal(validateProposal(proposal({
      kind: "new_standard", status: "submitted",
      context_snapshot_id: "snapshot-1", single_uncertainty: "Will this improve acceptance?",
    })).kind, "new_standard");
  });
});
