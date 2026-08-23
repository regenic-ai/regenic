const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  escapeLikeLiteral,
  formatInboxDigest,
  inboxDigest,
  summarizeInboxItems,
  threadExternalIdLike,
} = require("../dist");

describe("inbox query helpers", () => {
  it("counts current work by conversation, not every event", () => {
    const items = [
      {
        decision: { disposition: "current_work" },
        event: {
          id: "e1",
          source: "dsh",
          external_id: "session-x:1",
          ingested_at: "2026-08-23T00:00:00.000Z",
        },
      },
      {
        decision: { disposition: "current_work" },
        event: {
          id: "e2",
          source: "dsh",
          external_id: "session-x:2",
          ingested_at: "2026-08-23T00:00:01.000Z",
        },
      },
    ];
    const summary = summarizeInboxItems(items);
    assert.equal(summary.count, 1);
    assert.equal(
      summary.digest,
      formatInboxDigest({
        count: 1,
        latest_at: "2026-08-23T00:00:01.000Z",
        latest_id: "e2",
        pref_count: 0,
        pref_updated_at: "",
      }),
    );
  });

  it("changes the digest when a conversation pref is saved", () => {
    const items = [
      {
        event: {
          id: "e1",
          source: "dsh",
          external_id: "session-x:1",
          ingested_at: "2026-08-23T00:00:00.000Z",
        },
      },
    ];
    const before = inboxDigest(items);
    const after = inboxDigest(items, [{ updated_at: "2026-08-23T00:01:00.000Z" }]);
    assert.notEqual(before, after);
    assert.match(after, /:1:2026-08-23T00:01:00.000Z$/);
  });

  it("escapes LIKE wildcards in a thread target prefix", () => {
    assert.equal(escapeLikeLiteral("a_b%c\\d"), "a\\_b\\%c\\\\d");
    assert.equal(threadExternalIdLike("a_b"), "a\\_b:%");
  });
});
