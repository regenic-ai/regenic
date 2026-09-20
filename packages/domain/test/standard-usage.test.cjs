const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { validateStandardUsage } = require("../dist");

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
    cited_at: "2026-09-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("StandardUsage contract", () => {
  it("requires a pinned source, version, snapshot, and timestamp", () => {
    assert.equal(validateStandardUsage(usage()).source_kind, "agent_run");
    assert.throws(() => validateStandardUsage(usage({ version_id: "" })), /Invalid StandardUsage/);
    assert.throws(() => validateStandardUsage(usage({ source_kind: "chat" })), /Invalid StandardUsage/);
    assert.throws(() => validateStandardUsage(usage({ cited_at: "invalid" })), /Invalid StandardUsage/);
  });
});
