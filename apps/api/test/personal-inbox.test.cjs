const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { parseConversationThread } = require("@regenic/domain");
const { inboxStoreQuery } = require("../dist/personal-inbox.service");

describe("inboxStoreQuery", () => {
  it("opens a conversation by stored thread_id instead of an external_id prefix", () => {
    const thread = parseConversationThread("feishu:oc_yiki");
    assert.deepEqual(
      inboxStoreQuery({ thread_id: "feishu:oc_yiki", limit: 50 }, thread),
      {
        thread_ids: ["feishu:oc_yiki"],
        since: undefined,
        since_id: undefined,
        before: undefined,
        before_id: undefined,
        limit: 50,
        siblings: true,
      },
    );
  });

  it("keeps heads on the stored thread_id", () => {
    const thread = parseConversationThread("feishu:oc_yiki");
    assert.deepEqual(inboxStoreQuery({ heads: true, thread_id: "feishu:oc_yiki" }, thread), {
      heads: true,
      thread_ids: ["feishu:oc_yiki"],
    });
  });
});
