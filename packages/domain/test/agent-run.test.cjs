const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  cancelAgentRun,
  handoffAgentRun,
  settleAgentRun,
  startAgentRun,
  validateAgentRun,
} = require("../dist");

function run(overrides = {}) {
  return {
    schema_version: "1.0",
    id: "run-1",
    org_id: "example-org",
    agent: { actor_type: "agent", actor_id: "agent-1" },
    on_behalf_of: { actor_type: "human", actor_id: "person-1" },
    intent: "Apply the release standard.",
    status: "queued",
    context_snapshot_id: "snapshot-1",
    standard_bindings: [{ standard_id: "standard-1", version_id: "version-1" }],
    input: { release_id: "release-1" },
    created_at: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

function output(overrides = {}) {
  return {
    summary: "The release check passed.",
    artifacts: [{ kind: "report", ref: "artifact-1" }],
    applied_standard_version_ids: ["version-1"],
    context_snapshot_id: "snapshot-1",
    acceptance_check: "pass",
    exceptions: [],
    confidence: 0.9,
    ...overrides,
  };
}

describe("AgentRun contract", () => {
  it("requires an explicit agent, snapshot, bindings, and structured input", () => {
    assert.equal(validateAgentRun(run()).status, "queued");
    assert.throws(() => validateAgentRun(run({ agent: { actor_type: "human", actor_id: "person-1" } })), /Invalid AgentRun/);
    assert.throws(() => validateAgentRun(run({ standard_bindings: [] })), /Invalid AgentRun/);
    assert.throws(() => validateAgentRun(run({ input: [] })), /Invalid AgentRun/);
  });

  it("starts and settles with exact binding and snapshot echoes", () => {
    const running = startAgentRun(run(), "2026-09-21T01:00:00.000Z");
    assert.equal(running.status, "running");
    assert.throws(() => settleAgentRun(running, "succeeded", output({
      context_snapshot_id: "other-snapshot",
    }), "2026-09-21T02:00:00.000Z"), /Invalid AgentRun output/);
    assert.throws(() => settleAgentRun(running, "succeeded", output({
      applied_standard_version_ids: ["other-version"],
    }), "2026-09-21T02:00:00.000Z"), /echo pinned/);
    assert.throws(() => settleAgentRun(running, "succeeded", output({
      acceptance_check: "fail",
    }), "2026-09-21T02:00:00.000Z"), /cannot fail acceptance/);
    assert.equal(settleAgentRun(running, "succeeded", output(), "2026-09-21T02:00:00.000Z").status, "succeeded");
  });

  it("cancels only queued or running runs with monotonic time", () => {
    assert.equal(cancelAgentRun(run(), "2026-09-21T00:30:00.000Z").status, "cancelled");
    const running = startAgentRun(run(), "2026-09-21T01:00:00.000Z");
    assert.throws(() => cancelAgentRun(running, "2026-09-21T00:30:00.000Z"), /Invalid AgentRun cancellation/);
    const cancelled = cancelAgentRun(running, "2026-09-21T02:00:00.000Z");
    assert.throws(() => startAgentRun(cancelled, "2026-09-21T03:00:00.000Z"), /Invalid AgentRun start/);
  });

  it("hands off a running run only through a matching Agent-to-Human object", () => {
    const running = startAgentRun(run(), "2026-09-21T01:00:00.000Z");
    const handoff = {
      schema_version: "1.0",
      id: "handoff-1",
      org_id: "example-org",
      direction: "agent_to_human",
      from: { actor_type: "agent", actor_id: "agent-1" },
      to: { actor_type: "human", actor_id: "person-1" },
      reason: "evidence_conflict",
      agent_run_id: running.id,
      context_snapshot_id: running.context_snapshot_id,
      standard_bindings: running.standard_bindings,
      payload: { summary: "Two claims disagree." },
      status: "open",
      created_at: "2026-09-21T02:00:00.000Z",
    };
    assert.equal(handoffAgentRun(running, handoff, handoff.created_at).handoff_id, handoff.id);
    assert.throws(() => handoffAgentRun(running, {
      ...handoff, context_snapshot_id: "other-snapshot",
    }, handoff.created_at), /Invalid AgentRun Handoff/);
    assert.throws(() => handoffAgentRun(running, {
      ...handoff, to: { actor_type: "human", actor_id: "person-2" },
    }, handoff.created_at), /Invalid AgentRun Handoff/);
  });
});
