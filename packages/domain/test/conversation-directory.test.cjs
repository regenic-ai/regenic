const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  conversationDirectoryLabel,
  conversationNamesFromRecords,
  opaqueConversationName,
  shouldRememberConversationName,
} = require("../dist/conversation-directory");
const { channelRecord } = require("../dist/message-contract");

describe("conversation directory names", () => {
  it("prefers a catalog title over a stored prompt, and an id over nothing", () => {
    assert.equal(opaqueConversationName("feishu:oc_abc", "feishu:oc_abc"), true);
    assert.equal(opaqueConversationName("oc_abc", "feishu:oc_abc"), true);
    assert.equal(opaqueConversationName("合合信息日报", "feishu:oc_abc"), false);
    const named = conversationDirectoryLabel({
      thread_id: "feishu:oc_abc",
      pref_title: null,
      catalog_label: "项目群",
      display_name: "第一条消息",
    });
    assert.equal(named.label, "项目群");
    assert.equal(named.conversation_name, "项目群");
    const stored = conversationDirectoryLabel({
      thread_id: "dsh:session-1",
      pref_title: null,
      catalog_label: null,
      display_name: "只用一句话回复：pong",
    });
    assert.equal(stored.label, "只用一句话回复：pong");
    const bare = conversationDirectoryLabel({
      thread_id: "feishu:oc_abc",
      pref_title: null,
      catalog_label: "oc_abc",
      display_name: null,
    });
    assert.equal(bare.label, "feishu:oc_abc");
    assert.equal(bare.conversation_name, undefined);
  });

  it("stores a chat title from the record and ignores message text", () => {
    const names = conversationNamesFromRecords([
      channelRecord({
        channel: "dsh",
        kind: "user",
        direction: "outbound",
        external_id: "session-x:7",
        occurred_at: "2026-08-21T00:00:00.000Z",
        actor_id: "user",
        scope_id: "session-x",
        text: "只用一句话回复：pong",
      }),
      channelRecord({
        channel: "feishu",
        kind: "user",
        direction: "inbound",
        external_id: "oc_abc:m1",
        occurred_at: "2026-08-21T00:00:00.000Z",
        actor_id: "user",
        scope_id: "oc_abc",
        scope_name: "项目群",
        text: "你好",
      }),
    ]);
    const dsh = names.find((item) => item.thread_id === "dsh:session-x");
    const feishu = names.find((item) => item.thread_id === "feishu:oc_abc");
    assert.equal(dsh, undefined);
    assert.equal(feishu?.kind, "conversation");
    assert.equal(feishu?.display_name, "项目群");
    assert.equal(shouldRememberConversationName("项目群", {
      display_name: "你好",
      kind: "prompt",
    }, "feishu:oc_abc"), false);
    assert.equal(shouldRememberConversationName("你好", {
      display_name: "项目群",
      kind: "conversation",
    }, "feishu:oc_abc"), true);
  });
});
