const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { contextRecordPage, contextRecordSummary } = require("../dist/context-record-view");

function artifact(attrs) {
  return {
    id: "artifact-1",
    org_id: "example-org",
    kind: "thread_summary",
    schema_version: "1.0",
    algorithm_version: "v1",
    generation: "generation-1",
    input_refs: [],
    input_hash: "a".repeat(64),
    status: "proposed",
    required_scope_ids: [],
    recorded_at: "2026-10-12T09:00:00.000Z",
    attrs,
  };
}

describe("context record view", () => {
  it("clips the title and pages the same lines the preview counted", () => {
    const value = artifact({
      messages: [
        { text: "x".repeat(90), occurred_at: "2026-08-30T02:00:00.000Z" },
        { text: "earlier", occurred_at: "2026-08-30T01:00:00.000Z" },
      ],
    });
    const page = contextRecordPage(value, { limit: 1 });
    assert.equal(page.title.length, 81);
    assert.equal(page.title.endsWith("…"), true);
    assert.equal(page.message_count, 2);
    assert.equal(page.message_total, 2);
    assert.equal(page.message_offset, 1);
    assert.equal(page.message_limit, 1);
    assert.deepEqual(page.messages.map((message) => message.text), ["x".repeat(90)]);
    assert.equal(contextRecordSummary({
      id: value.id,
      kind: value.kind,
      status: value.status,
      recorded_at: value.recorded_at,
      preview: { readable_count: 0, utc_date: "2026-08-30" },
    }).title, "2026-08-30");
  });
});
