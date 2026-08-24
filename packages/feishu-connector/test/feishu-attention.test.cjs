const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const {
  LarkCliClient,
  cacheFeishuReadStatus,
  cachedFeishuReadStatus,
  feishuAttentionOf,
  lastFeishuInbound,
  markFeishuChatRead,
  parseFeishuReadStatus,
  rememberFeishuInbound,
  resetFeishuAttention,
  resolveFeishuInbound,
} = require("../dist");

afterEach(() => {
  resetFeishuAttention();
});

describe("Feishu attention", () => {
  it("parses user read_status items", () => {
    const statuses = parseFeishuReadStatus({
      data: {
        items: [
          { message_id: "om_1", is_read: true },
          { message_id: "om_2", is_read: false },
        ],
      },
    });
    assert.equal(statuses.get("om_1"), true);
    assert.equal(statuses.get("om_2"), false);
  });

  it("uses a store inbound hint only when the poll cache is empty", () => {
    assert.equal(resolveFeishuInbound("oc_1", "om_store"), "om_store");
    assert.equal(resolveFeishuInbound("oc_1", "not-om"), undefined);
    rememberFeishuInbound("oc_1", "om_live");
    assert.equal(resolveFeishuInbound("oc_1", "om_store"), "om_live");
  });

  it("remembers the latest inbound om_ and falls back when no overlay exists", () => {
    rememberFeishuInbound("oc_1", "om_new");
    assert.equal(lastFeishuInbound("oc_1"), "om_new");
    assert.equal(feishuAttentionOf("oc_1"), undefined);
    assert.deepEqual(feishuAttentionOf("oc_1", false), {
      unread: true,
      unread_count: 1,
    });
    assert.deepEqual(feishuAttentionOf("oc_1", true), {
      unread: false,
      unread_count: 0,
    });
  });

  it("acks locally without pretending the official chat list has a count", () => {
    rememberFeishuInbound("oc_1", "om_new");
    markFeishuChatRead("oc_1");
    assert.deepEqual(feishuAttentionOf("oc_1", false), {
      unread: false,
      unread_count: 0,
    });
  });

  it("caches a source read_status briefly", () => {
    cacheFeishuReadStatus("om_1", false);
    assert.equal(cachedFeishuReadStatus("om_1"), false);
  });

  it("asks lark-cli for user read_status and ignores non-om ids", async () => {
    const calls = [];
    const client = new LarkCliClient({
      command: "lark-cli",
      async spawn(input) {
        calls.push(input);
        return {
          stdout: JSON.stringify({
            ok: true,
            identity: "user",
            data: { items: [{ message_id: "om_1", is_read: false }] },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });
    const statuses = await client.readMessageStatus(["om_1", "bad"]);
    assert.equal(statuses.get("om_1"), false);
    assert.match(calls[0].command.join(" "), /\/open-apis\/im\/v1\/messages\/read_status/);
    assert.equal(calls[0].command.includes("--as"), true);
    assert.equal(calls[0].command[calls[0].command.indexOf("--as") + 1], "user");
  });
});
