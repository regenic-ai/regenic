const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { validateDecision } = require("../dist");

function decision(overrides = {}) {
  return {
    schema_version: "1.0",
    id: "decision-1",
    org_id: "example-org",
    proposal_id: "proposal-1",
    summary: "Proceed with the bounded launch.",
    rationale: "The accepted evidence supports the launch.",
    decided_by: { actor_type: "human", actor_id: "person-1" },
    co_deciders: [],
    rights_level: "coach",
    context_snapshot_id: "snapshot-1",
    standard_bindings: [],
    status: "committed",
    committed_at: "2026-09-15T01:00:00.000Z",
    ...overrides,
  };
}

describe("Decision contract", () => {
  it("requires co-deciders only for negotiated decisions", () => {
    assert.throws(() => validateDecision(decision({ rights_level: "negotiate" })), /requires a co-decider/);
    assert.equal(validateDecision(decision({
      rights_level: "negotiate",
      co_deciders: [{ actor_type: "human", actor_id: "person-2" }],
    })).rights_level, "negotiate");
    assert.throws(() => validateDecision(decision({
      co_deciders: [{ actor_type: "human", actor_id: "person-2" }],
    })), /Only negotiated/);
  });
});