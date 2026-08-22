const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  FeishuApiError,
  LarkCliClient,
  larkCliUserReady,
  parseHistoryPage,
  probeLarkCliAuth,
  resetLarkCliProbeCache,
  resolveLarkCommand,
  unwrapLarkCli,
} = require("../dist");

describe("LarkCliClient", () => {
  it("lists messages as the user and unwraps the CLI envelope", async () => {
    const calls = [];
    const client = new LarkCliClient({
      command: "lark-cli",
      async spawn(input) {
        calls.push(input);
        return {
          stdout: JSON.stringify({
            ok: true,
            identity: "user",
            data: {
              items: [{ message_id: "om_1", msg_type: "text" }],
              has_more: true,
              page_token: "next",
            },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });

    const page = await client.listMessages({
      chat_id: "oc_1",
      page_size: 20,
      page_token: "cur",
      start_time: "1723420800",
    });

    assert.deepEqual(calls[0].command, [
      "lark-cli",
      "api",
      "GET",
      "/open-apis/im/v1/messages",
      "--as",
      "user",
      "--format",
      "json",
      "--params",
      JSON.stringify({
        container_id_type: "chat",
        container_id: "oc_1",
        sort_type: "ByCreateTimeAsc",
        page_size: 20,
        page_token: "cur",
        start_time: "1723420800",
      }),
    ]);
    assert.equal(page.items[0].message_id, "om_1");
    assert.equal(page.has_more, true);
    assert.equal(page.page_token, "next");
  });

  it("sends text through the raw IM API", async () => {
    const calls = [];
    const client = new LarkCliClient({
      async spawn(input) {
        calls.push(input);
        return {
          stdout: JSON.stringify({
            ok: true,
            data: { message_id: "om_sent" },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });

    const result = await client.sendText({
      chat_id: "oc_1",
      text: "hello",
      uuid: "uuid-1",
    });

    assert.equal(calls[0].command.includes("POST"), true);
    assert.equal(calls[0].command.includes("/open-apis/im/v1/messages"), true);
    const params = JSON.parse(calls[0].command[calls[0].command.indexOf("--params") + 1]);
    const data = JSON.parse(calls[0].command[calls[0].command.indexOf("--data") + 1]);
    assert.deepEqual(params, { receive_id_type: "chat_id" });
    assert.equal(data.receive_id, "oc_1");
    assert.equal(data.msg_type, "text");
    assert.equal(data.content, JSON.stringify({ text: "hello" }));
    assert.equal(data.uuid, "uuid-1");
    assert.equal(result.message_id, "om_sent");
  });

  it("treats CLI ok:false and Feishu code!=0 as FeishuApiError", () => {
    assert.throws(
      () =>
        unwrapLarkCli({
          stdout: JSON.stringify({
            ok: false,
            error: { message: "not logged in", subtype: "auth" },
          }),
          stderr: "",
          exit_code: 1,
        }),
      (error) => error instanceof FeishuApiError && error.message === "not logged in",
    );
    assert.throws(
      () =>
        unwrapLarkCli({
          stdout: JSON.stringify({ code: 99991663, msg: "token invalid" }),
          stderr: "",
          exit_code: 0,
        }),
      (error) => error instanceof FeishuApiError && error.code === "99991663",
    );
  });

  it("parses a raw Feishu history page", () => {
    const page = parseHistoryPage({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_1",
            msg_type: "text",
            create_time: "1723420800000",
            sender: { id: "ou_1", sender_type: "user" },
            body: { content: "{\"text\":\"hi\"}" },
          },
        ],
        has_more: false,
      },
    });
    assert.equal(page.items[0].sender.id, "ou_1");
    assert.equal(page.has_more, false);
  });

  it("reads user identity from auth status JSON", () => {
    assert.equal(
      larkCliUserReady(JSON.stringify({ ok: true, identity: "user" }), 0),
      true,
    );
    assert.equal(
      larkCliUserReady(
        JSON.stringify({ ok: true, identities: { user: { userName: "Ada" } } }),
        0,
      ),
      true,
    );
    assert.equal(
      larkCliUserReady(JSON.stringify({ ok: true, identity: "bot" }), 0),
      false,
    );
    assert.equal(larkCliUserReady("{}", 1), false);
  });

  it("falls back to the global lark-cli command when an absolute path is missing", () => {
    assert.equal(resolveLarkCommand("/Users/missing/lark-cli"), "lark-cli");
    assert.equal(resolveLarkCommand("lark-cli"), "lark-cli");
  });

  it("caches lark-cli auth probes for about 20 seconds", async () => {
    resetLarkCliProbeCache();
    let calls = 0;
    const spawn = async () => {
      calls += 1;
      return {
        stdout: JSON.stringify({ ok: true, identity: "user" }),
        stderr: "",
        exit_code: 0,
      };
    };
    assert.equal(await probeLarkCliAuth({ spawn, now: () => 1_000 }), true);
    assert.equal(await probeLarkCliAuth({ spawn, now: () => 15_000 }), true);
    assert.equal(calls, 1);
    assert.equal(await probeLarkCliAuth({ spawn, now: () => 22_000 }), true);
    assert.equal(calls, 2);
    resetLarkCliProbeCache();
  });
});
