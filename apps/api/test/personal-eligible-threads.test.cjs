const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { eligibleInstallationThreads } = require("../dist/personal-eligible-threads");

const installation = {
  id: "feishu-1",
  org_id: "local-owner",
  connector_type: "feishu-chat",
  status: "enabled",
  config: { selection: "all" },
  created_at: "2026-08-22T00:00:00.000Z",
  updated_at: "2026-08-22T00:00:00.000Z",
};

const feishuDriver = {
  matchesThread(_installation, thread) {
    return thread.source === "feishu";
  },
};

function item(source, externalId) {
  return {
    decision: {
      event_id: externalId,
      org_id: "local-owner",
      disposition: "current_work",
      layer: "L1_event",
      reason_codes: ["test"],
      score: 1,
      decided_at: "2026-08-27T00:00:00.000Z",
    },
    event: {
      id: `event-${externalId}`,
      org_id: "local-owner",
      source,
      external_id: externalId,
      operation: "create",
      occurred_at: "2026-08-27T00:00:00.000Z",
      ingested_at: "2026-08-27T00:00:00.000Z",
    },
  };
}

describe("eligibleInstallationThreads", () => {
  it("keeps current-work threads this install matches plus the open thread", () => {
    const threads = eligibleInstallationThreads(
      [item("feishu", "oc_work:om_1"), item("dsh", "sess-1:msg-1")],
      installation,
      feishuDriver,
      "feishu:oc_open",
    );
    assert.deepEqual(threads, [
      { source: "feishu", target: "oc_work" },
      { source: "feishu", target: "oc_open" },
    ]);
  });

  it("does not duplicate the open thread when it is already current work", () => {
    const threads = eligibleInstallationThreads(
      [item("feishu", "oc_work:om_1")],
      installation,
      feishuDriver,
      "feishu:oc_work",
    );
    assert.deepEqual(threads, [{ source: "feishu", target: "oc_work" }]);
  });
});
