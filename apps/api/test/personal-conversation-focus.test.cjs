const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  conversationFocusThreadId,
  shouldMarkHumanPresent,
  shouldPullOlderFocus,
} = require("../dist/personal-conversation-focus");

describe("conversation focus", () => {
  it("requires a thread id", () => {
    assert.equal(conversationFocusThreadId({ thread_id: " feishu:oc_1 " }), "feishu:oc_1");
    assert.equal(conversationFocusThreadId({}), undefined);
  });

  it("marks human presence by default", () => {
    assert.equal(shouldMarkHumanPresent({ thread_id: "feishu:oc_1" }), true);
    assert.equal(shouldMarkHumanPresent({ thread_id: "feishu:oc_1", present: false }), false);
  });

  it("pulls older only when explicitly requested with a cursor", () => {
    assert.equal(
      shouldPullOlderFocus({
        thread_id: "feishu:oc_1",
        pull_older: true,
        before: "2026-01-01T00:00:00.000Z",
      }),
      true,
    );
    assert.equal(
      shouldPullOlderFocus({ thread_id: "feishu:oc_1", before: "2026-01-01" }),
      false,
    );
  });
});
