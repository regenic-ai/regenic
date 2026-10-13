const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  contextArtifactPreview,
  readContextArtifactRecord,
  summarizeContextArtifact,
} = require("../dist");

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

describe("context artifact summaries", () => {
  it("titles the list from the last stored line and keeps message text out of the preview", () => {
    const value = artifact({
      thread_id: "chat-1",
      message_count: 2,
      messages: [
        { text: "time-newest", occurred_at: "2026-08-30T02:00:00.000Z" },
        { text: "  stored last  ", occurred_at: "2026-08-30T01:00:00.000Z" },
      ],
    });
    const preview = contextArtifactPreview(value);
    assert.equal(JSON.stringify(preview).includes("time-newest"), false);
    const summary = summarizeContextArtifact(value);
    assert.equal(summary.title, "stored last");
    assert.equal(summary.message_count, 2);
    assert.equal(summary.thread_id, "chat-1");
    assert.equal(summary.messages, undefined);

    const page = readContextArtifactRecord(value, { limit: 1 });
    assert.equal(page.message_total, 2);
    assert.equal(page.message_offset, 1);
    assert.deepEqual(page.messages.map((message) => message.text), ["time-newest"]);
  });

  it("clips a long title and pages a daily digest from the newest items", () => {
    const clipped = summarizeContextArtifact(artifact({
      messages: [{ text: "x".repeat(90) }],
    }));
    assert.equal(clipped.title.length, 81);
    assert.equal(clipped.title.endsWith("…"), true);

    const digest = readContextArtifactRecord({
      ...artifact({
        utc_date: "2026-08-30",
        item_count: 2,
        directions: [{
          items: [
            { text: "later", occurred_at: "2026-08-30T02:00:00.000Z" },
            { text: " earlier ", occurred_at: "2026-08-30T01:00:00.000Z" },
            { text: "   " },
          ],
        }],
      }),
      kind: "daily_digest",
    }, { offset: 0, limit: 1 });
    assert.equal(digest.title, "2026-08-30");
    assert.equal(digest.message_count, 2);
    assert.equal(digest.message_total, 2);
    assert.deepEqual(digest.messages, [{
      text: "earlier",
      occurred_at: "2026-08-30T01:00:00.000Z",
    }]);
  });
});
