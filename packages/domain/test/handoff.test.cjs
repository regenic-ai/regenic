const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { assertHandoffTransition, validateHandoff } = require("../dist");

function handoff(overrides = {}) {
  return {
    schema_version: "1.0",
    id: "handoff-1",
    org_id: "example-org",
    direction: "human_to_agent",
    from: { actor_type: "human", actor_id: "person-1" },
    to: { actor_type: "agent", actor_id: "agent-1" },
    reason: "set_boundary",
    decision_id: "decision-1",
    context_snapshot_id: "snapshot-1",
    standard_bindings: [],
    payload: { boundary: "Release only" },
    status: "open",
    created_at: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("Handoff contract", () => {
  it("binds direction, actors, and reasons", () => {
    assert.equal(validateHandoff(handoff()).reason, "set_boundary");
    assert.throws(() => validateHandoff(handoff({ reason: "evidence_conflict" })), /direction or reason/);
    assert.throws(() => validateHandoff(handoff({ to: { actor_type: "human", actor_id: "person-2" } })), /direction or reason/);
    assert.equal(validateHandoff(handoff({
      direction: "agent_to_human",
      from: { actor_type: "agent", actor_id: "agent-1" },
      to: { actor_type: "human", actor_id: "person-1" },
      reason: "evidence_conflict",
    })).direction, "agent_to_human");
  });

  it("requires a snapshot, structured payload, and coherent resolution", () => {
    assert.throws(() => validateHandoff(handoff({ context_snapshot_id: "" })), /Invalid Handoff/);
    assert.throws(() => validateHandoff(handoff({ payload: {} })), /Invalid Handoff payload/);
    assert.throws(() => validateHandoff(handoff({ payload: { score: Number.POSITIVE_INFINITY } })), /Invalid Handoff payload/);
    assert.throws(() => validateHandoff(handoff({ status: "resolved" })), /requires resolved_at/);
    assert.equal(validateHandoff(handoff({
      status: "resolved",
      resolved_at: "2026-09-17T01:00:00.000Z",
    })).status, "resolved");
  });

  it("rejects duplicate StandardVersion bindings", () => {
    const binding = { standard_id: "standard-1", version_id: "version-1" };
    assert.throws(() => validateHandoff(handoff({
      standard_bindings: [binding, binding],
    })), /Invalid Handoff standard binding/);
  });

  it("requires acknowledgement before resolution and keeps terminal states closed", () => {
    assert.doesNotThrow(() => assertHandoffTransition("open", "acked"));
    assert.doesNotThrow(() => assertHandoffTransition("open", "cancelled"));
    assert.doesNotThrow(() => assertHandoffTransition("acked", "resolved"));
    assert.throws(() => assertHandoffTransition("open", "resolved"), /Invalid Handoff transition/);
    assert.throws(() => assertHandoffTransition("resolved", "cancelled"), /Invalid Handoff transition/);
  });
});
