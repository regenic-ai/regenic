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
    assert.deepEqual(
      receiptFromReadUsers({
        data: {
          items: [{ user_id: "ou_1", timestamp: "1609484183000" }],
        },
      }),
      {
        state: "read",
        read_count: 1,
        read_at: "2021-01-01T06:56:23.000Z",
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
    assert.match(calls[0].command.join(" "), /\+message-read-users/);
    assert.match(calls[0].command.join(" "), /--message-id om_1/);
    assert.equal(calls[0].command.includes("--page-all"), false);
    assert.equal(calls[0].command.includes("--as"), true);
    assert.equal(calls[0].command[calls[0].command.indexOf("--as") + 1], "user");
  });

  it("reads message users over HTTP when a user token is available", async () => {
    const spawned = [];
    const fetched = [];
    const client = new LarkCliClient({
      command: "lark-cli",
      async spawn(input) {
        spawned.push(input);
        throw new Error("CLI should not run when HTTP works");
      },
      userToken: {
        async token() {
          return "u-test";
        },
        async refresh() {},
        async identity() {
          return { app_id: "cli_1", user_open_id: "ou_1", brand: "feishu" };
        },
        async brand() {
          return "feishu";
        },
      },
      async fetch(url, init) {
        fetched.push({ url: String(url), init });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                items: [{ user_id: "ou_http", timestamp: "2026-08-24T12:00:00.000Z" }],
              },
            });
          },
          async json() {
            return JSON.parse(await this.text());
          },
        };
      },
    });
    const users = await client.readMessageUsers("om_1");
    assert.equal(spawned.length, 0);
    assert.equal(users.items[0].user_id, "ou_http");
    assert.match(fetched[0].url, /\/open-apis\/im\/v1\/messages\/om_1\/read_users/);
    assert.equal(fetched[0].init.headers.Authorization, "Bearer u-test");
  });

  it("falls back to user CLI read_users when the shortcut is missing", async () => {
    const calls = [];
    const client = new LarkCliClient({
      command: "lark-cli",
      async spawn(input) {
        calls.push(input.command.join(" "));
        if (String(input.command.join(" ")).includes("+message-read-users")) {
          return {
            stdout: "",
            stderr: "unknown command: +message-read-users",
            exit_code: 2,
          };
        }
        return {
          stdout: JSON.stringify({
            ok: true,
            identity: "user",
            data: { items: [{ user_id: "ou_2", timestamp: "1609484183000" }] },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });
    const users = await client.readMessageUsers("om_2");
    assert.equal(users.items[0].user_id, "ou_2");
    assert.match(calls[0], /\+message-read-users/);
    assert.match(calls[1], /\/open-apis\/im\/v1\/messages\/om_2\/read_users/);
    assert.match(calls[1], /--as user/);
  });
});
