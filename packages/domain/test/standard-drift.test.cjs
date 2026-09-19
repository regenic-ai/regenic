const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { detectStandardDrift } = require("../dist");

function failedRun(id, finishedAt, overrides = {}) {
  return {
    schema_version: "1.0",
    id,
    org_id: "example-org",
    agent: { actor_type: "agent", actor_id: "agent-1" },
    intent: "Apply the release standard.",
    status: "failed",
    context_snapshot_id: `snapshot-${id}`,
    standard_bindings: [{ standard_id: "standard-1", version_id: "version-1" }],
    input: { release_id: id },
    output: {
      summary: "The release check failed.",
      artifacts: [],
      applied_standard_version_ids: ["version-1"],
      context_snapshot_id: `snapshot-${id}`,
      acceptance_check: "fail",
      exceptions: ["Acceptance failed."],
    },
    created_at: "2026-09-21T00:00:00.000Z",
    started_at: "2026-09-21T01:00:00.000Z",
    finished_at: finishedAt,
    ...overrides,
  };
}

describe("Standard drift detector", () => {
  it("requires repeated acceptance failures on one pinned version", () => {
    assert.deepEqual(detectStandardDrift([
      failedRun("run-1", "2026-09-21T02:00:00.000Z"),
    ]), []);
    const [candidate] = detectStandardDrift([
      failedRun("run-2", "2026-09-22T02:00:00.000Z"),
      failedRun("run-1", "2026-09-21T02:00:00.000Z"),
    ]);
    assert.deepEqual(candidate.run_ids, ["run-1", "run-2"]);
    assert.equal(candidate.context_snapshot_id, "snapshot-run-2");
    assert.equal(candidate.detected_at, "2026-09-22T02:00:00.000Z");
  });

  it("freezes the first threshold evidence and ignores later failures", () => {
    const first = detectStandardDrift([
      failedRun("run-1", "2026-09-21T02:00:00.000Z"),
      failedRun("run-2", "2026-09-22T02:00:00.000Z"),
    ]);
    const later = detectStandardDrift([
      failedRun("run-3", "2026-09-23T02:00:00.000Z"),
      failedRun("run-2", "2026-09-22T02:00:00.000Z"),
      failedRun("run-1", "2026-09-21T02:00:00.000Z"),
    ]);
    assert.deepEqual(later, first);
  });

  it("orders mixed-offset timestamps by their actual instant", () => {
    const [candidate] = detectStandardDrift([
      failedRun("run-later", "2026-09-21T00:30:00.000Z", {
        created_at: "2026-09-20T22:00:00.000Z",
        started_at: "2026-09-20T23:00:00.000Z",
      }),
      failedRun("run-earlier", "2026-09-21T01:00:00.000+01:00", {
        created_at: "2026-09-20T22:00:00.000Z",
        started_at: "2026-09-20T23:00:00.000Z",
      }),
    ]);
    assert.deepEqual(candidate.run_ids, ["run-earlier", "run-later"]);
    assert.equal(candidate.context_snapshot_id, "snapshot-run-later");
  });

  it("ignores non-failing acceptance and validates the threshold", () => {
    const succeeded = failedRun("run-pass", "2026-09-21T02:00:00.000Z", {
      status: "succeeded",
      output: {
        ...failedRun("run-pass", "2026-09-21T02:00:00.000Z").output,
        acceptance_check: "pass",
      },
    });
    assert.deepEqual(detectStandardDrift([
      succeeded,
      failedRun("run-1", "2026-09-21T02:00:00.000Z"),
    ]), []);
    assert.throws(() => detectStandardDrift([], 1), /Invalid Standard drift detection input/);
  });
});
