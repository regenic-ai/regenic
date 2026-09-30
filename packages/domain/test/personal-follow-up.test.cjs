const assert = require("node:assert/strict");
const { it } = require("node:test");
const {
  DEFAULT_PERSONAL_FOLLOW_UP_POLICY,
  collectFollowUpCandidates,
} = require("../dist");

const policy = {
  ...DEFAULT_PERSONAL_FOLLOW_UP_POLICY,
  wait_minutes: 60,
};

it("collects overdue outbound follow-ups after a prior inbound", () => {
  const candidates = collectFollowUpCandidates({
    policy,
    now: "2026-09-26T12:00:00.000Z",
    items: [
      { thread_id: "slack:dm-1", external_id: "in-1", occurred_at: "2026-09-26T09:00:00.000Z", direction: "inbound", kind: "user" },
      { thread_id: "slack:dm-1", external_id: "out-1", occurred_at: "2026-09-26T10:00:00.000Z", direction: "outbound", kind: "user" },
    ],
  });
  assert.deepEqual(candidates, [{
    thread_id: "slack:dm-1",
    outbound_external_id: "out-1",
    outbound_at: "2026-09-26T10:00:00.000Z",
    due_at: "2026-09-26T11:00:00.000Z",
    reason_codes: ["awaiting_reply"],
  }]);
});

it("does not follow up initial outbound, answered, working, or bot threads", () => {
  const candidates = collectFollowUpCandidates({
    policy,
    now: "2026-09-26T12:00:00.000Z",
    items: [
      { thread_id: "a", external_id: "out-1", occurred_at: "2026-09-26T09:00:00.000Z", direction: "outbound", kind: "user" },
      { thread_id: "b", external_id: "in-1", occurred_at: "2026-09-26T08:00:00.000Z", direction: "inbound", kind: "user" },
      { thread_id: "b", external_id: "out-1", occurred_at: "2026-09-26T09:00:00.000Z", direction: "outbound", kind: "user" },
      { thread_id: "b", external_id: "in-2", occurred_at: "2026-09-26T10:00:00.000Z", direction: "inbound", kind: "user" },
      { thread_id: "c", external_id: "in-1", occurred_at: "2026-09-26T08:00:00.000Z", direction: "inbound", kind: "user" },
      { thread_id: "c", external_id: "out-1", occurred_at: "2026-09-26T09:00:00.000Z", direction: "outbound", kind: "user", activity: "working" },
      { thread_id: "d", external_id: "in-1", occurred_at: "2026-09-26T08:00:00.000Z", direction: "inbound", kind: "user" },
      { thread_id: "d", external_id: "out-1", occurred_at: "2026-09-26T09:00:00.000Z", direction: "outbound", kind: "assistant" },
    ],
  });
  assert.deepEqual(candidates, []);
});

it("excludes groups, bots, system messages, tombstones, revisions, and later inbound replies", () => {
  const base = {
    thread_id: "slack:dm-1",
    external_id: "out-1",
    occurred_at: "2026-09-26T10:00:00.000Z",
    direction: "outbound",
    kind: "user",
  };
  const excluded = [
    { ...base, conversation_kind: "group" },
    { ...base, actor_label: "release bot" },
    { ...base, kind: "system" },
    { ...base, type: "thread_status" },
    { ...base, operation: "tombstone" },
    { ...base, operation: "revise" },
  ];
  for (const item of excluded) {
    assert.deepEqual(collectFollowUpCandidates({
      policy: { ...policy, include_initial_outbound: true },
      now: "2026-09-26T12:00:00.000Z",
      items: [
        { thread_id: item.thread_id, external_id: "in-1", occurred_at: "2026-09-26T09:00:00.000Z", direction: "inbound", kind: "user" },
        item,
      ],
    }), []);
  }
  const answered = collectFollowUpCandidates({
    policy,
    now: "2026-09-26T12:00:00.000Z",
    items: [
      { thread_id: "slack:dm-1", external_id: "in-1", occurred_at: "2026-09-26T09:00:00.000Z", direction: "inbound", kind: "user" },
      base,
      { thread_id: "slack:dm-1", external_id: "in-2", occurred_at: "2026-09-26T11:30:00.000Z", direction: "inbound", kind: "user" },
    ],
  });
  assert.deepEqual(answered, []);
});

it("can include an overdue initial outbound when configured", () => {
  const candidates = collectFollowUpCandidates({
    policy: { ...policy, include_initial_outbound: true },
    now: "2026-09-26T12:00:00.000Z",
    items: [{ thread_id: "a", external_id: "out-1", occurred_at: "2026-09-26T09:00:00.000Z", direction: "outbound", kind: "user" }],
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].thread_id, "a");
});