const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  contextArtifactPreview,
  contextArtifactPreviewFromStored,
  readableContextMessages,
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

describe("context artifact previews", () => {
  it("keeps the newest readable line and drops the rest of the transcript", () => {
    const value = artifact({
      thread_id: " chat-1 ",
      message_count: 99,
      messages: [
        { text: "time-newest", occurred_at: "2026-08-30T02:00:00.000Z" },
        { text: "  stored last  ", occurred_at: "2026-08-30T01:00:00.000Z" },
        { text: "   " },
      ],
    });
    const preview = contextArtifactPreview(value);
    assert.equal(preview.last_text, "time-newest");
    assert.equal(preview.readable_count, 2);
    assert.equal(preview.thread_id, "chat-1");
    assert.equal(JSON.stringify(preview).includes("stored last"), false);
    assert.equal(preview.message_count, undefined);
    assert.deepEqual(
      readableContextMessages(value).map((message) => message.text),
      ["stored last", "time-newest"],
    );
    assert.deepEqual(contextArtifactPreviewFromStored(JSON.stringify(preview)), preview);
  });

  it("uses digest lines when the artifact has no messages", () => {
    const preview = contextArtifactPreview({
      ...artifact({
        utc_date: "2026-08-30",
        item_count: 9,
        directions: [{
          items: [
            { text: "later", occurred_at: "2026-08-30T02:00:00.000Z" },
            { text: " earlier ", occurred_at: "2026-08-30T01:00:00.000Z" },
          ],
        }],
      }),
      kind: "daily_digest",
    });
    assert.equal(preview.last_text, "later");
    assert.equal(preview.readable_count, 2);
    assert.equal(preview.utc_date, "2026-08-30");
  });
});
