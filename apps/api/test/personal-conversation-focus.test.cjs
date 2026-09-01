const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  conversationFocusThreadId,
  shouldMarkHumanPresent,
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
});
