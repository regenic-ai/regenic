const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const {
  LarkCliClient,
  cacheFeishuReceipt,
  cachedFeishuReceipt,
  feishuSentMessageId,
  receiptFromReadUsers,
  resetFeishuReceipts,
} = require("../dist");

afterEach(() => {
  resetFeishuReceipts();
});

describe("Feishu receipts", () => {
  it("extracts om_ from console outbound and history echo ids", () => {
    assert.equal(feishuSentMessageId("om_sent"), "om_sent");
    assert.equal(feishuSentMessageId("oc_1:out:om_sent"), "om_sent");
    assert.equal(feishuSentMessageId("oc_1:om_history"), "om_history");
    assert.equal(feishuSentMessageId("local:out:draft"), undefined);
    assert.equal(feishuSentMessageId("oc_1:draft"), undefined);
  });

  it("treats empty read_users as sent, not unread", () => {
    assert.deepEqual(receiptFromReadUsers({ data: { items: [] } }), { state: "sent" });
    assert.deepEqual(
      receiptFromReadUsers({
        data: {
          items: [
            { user_id: "ou_1", timestamp: "2026-08-24T12:00:00.000Z" },
            { user_id: "ou_2", timestamp: "2026-08-24T12:01:00.000Z" },
          ],
        },
      }),
      {
        state: "read",
        read_count: 2,
        read_at: "2026-08-24T12:01:00.000Z",
      },
    );
  });

  it("caches a receipt briefly", () => {
    cacheFeishuReceipt("om_1", { state: "read", read_count: 1 });
    assert.deepEqual(cachedFeishuReceipt("om_1"), { state: "read", read_count: 1 });
  });

  it("asks lark-cli for user read_users and ignores non-om ids", async () => {
    const calls = [];
    const client = new LarkCliClient({
      command: "lark-cli",
      async spawn(input) {
        calls.push(input);
        return {
          stdout: JSON.stringify({
            ok: true,
            identity: "user",
            data: { items: [{ user_id: "ou_1", timestamp: "2026-08-24T12:00:00.000Z" }] },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });
    const empty = await client.readMessageUsers("bad");
    assert.deepEqual(empty, { items: [] });
    const users = await client.readMessageUsers("om_1");
    assert.equal(users.items[0].user_id, "ou_1");
    assert.match(calls[0].command.join(" "), /\/open-apis\/im\/v1\/messages\/om_1\/read_users/);
    assert.equal(calls[0].command.includes("--as"), true);
    assert.equal(calls[0].command[calls[0].command.indexOf("--as") + 1], "user");
  });
});
