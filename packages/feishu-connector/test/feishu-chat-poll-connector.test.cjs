const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ConnectorRunner,
  IngestionService,
  MemoryAuthorityStore,
  MemoryBlobStore,
  MemoryConnectorRuntimeStore,
  verifyPollConnectorConformance,
} = require("@regenic/domain");
const {
  FeishuApiError,
  FeishuChatEgress,
  FeishuChatPollConnector,
  extractFeishuText,
  nextFeishuCursor,
} = require("../dist");

function createConnector(client) {
  return new FeishuChatPollConnector(client, {
    connector_id: "feishu-chat",
    org_id: "local-owner",
    chat_id: "oc_1",
    chat_name: "engineering",
    now: () => "2026-08-12T00:00:00.000Z",
  });
}

function textItem(overrides = {}) {
  return {
    message_id: "om_1",
    msg_type: "text",
    create_time: "1723420800000",
    sender: { id: "ou_1", sender_type: "user", name: "Ada" },
    body: { content: JSON.stringify({ text: "Root" }) },
    ...overrides,
  };
}

describe("FeishuChatPollConnector", () => {
  it("maps text, post, thread replies, and drops unknown types", async () => {
    const calls = [];
    const connector = createConnector({
      async listMessages(input) {
        calls.push(input);
        return {
          items: [
            textItem(),
            {
              message_id: "om_2",
              msg_type: "post",
              create_time: "1723420860000",
              root_id: "om_1",
              parent_id: "om_1",
              sender: { id: "cli_bot", sender_type: "app" },
              body: {
                content: JSON.stringify({
                  zh_cn: {
                    title: "Note",
                    content: [[{ tag: "text", text: "Reply" }]],
                  },
                }),
              },
            },
            {
              message_id: "om_3",
              msg_type: "image",
              sender: { id: "ou_1", sender_type: "user" },
              body: { content: "{}" },
            },
            {
              message_id: "om_4",
              msg_type: "text",
              deleted: true,
              sender: { id: "ou_1", sender_type: "user" },
              body: { content: JSON.stringify({ text: "gone" }) },
            },
          ],
          has_more: true,
          page_token: "page-2",
        };
      },
    });

    const result = await connector.poll({
      value: JSON.stringify({ page_token: "page-1" }),
    });

    assert.deepEqual(calls, [
      {
        chat_id: "oc_1",
        page_size: 50,
        page_token: "page-1",
        start_time: undefined,
      },
    ]);
    assert.equal(result.batch.records.length, 2);
    assert.equal(result.batch.records[0].external_id, "oc_1:om_1");
    assert.equal(result.batch.records[0].type, "message");
    assert.equal(result.batch.records[1].type, "thread_reply");
    assert.equal(result.batch.records[1].parent_external_id, "oc_1:om_1");
    assert.equal(result.batch.records[0].actor.display_name, "Ada");
    assert.equal(result.batch.records[0].scope.name, "engineering");
    assert.equal(result.batch.records[1].scope.name, "engineering");
    const surface = JSON.parse(
      result.batch.records[0].content.find((part) => part.role === "metadata").text,
    );
    assert.equal(surface.conversation_label, "engineering");
    assert.equal(surface.conversation_kind, "group");
    assert.equal(surface.actor_label, "Ada");
    assert.equal(
      result.next_cursor,
      JSON.stringify({ page_token: "page-2", start_time: "1723420860" }),
    );
    assert.equal(result.next_cursor, result.batch.next_cursor);
  });

  it("keeps a start_time cursor after the history page is caught up", async () => {
    const connector = createConnector({
      async listMessages() {
        return {
          items: [textItem({ create_time: "1723420800123" })],
          has_more: false,
        };
      },
    });
    const result = await connector.poll(null);
    assert.equal(result.next_cursor, JSON.stringify({ start_time: "1723420800" }));
  });

  it("settles a Feishu page through the shared connector runtime", async () => {
    const connector = createConnector({
      async listMessages() {
        return {
          items: [textItem()],
          has_more: false,
        };
      },
    });
    const runtime = new MemoryConnectorRuntimeStore();
    await runtime.createInstallation({
      id: "feishu-installation",
      org_id: "local-owner",
      connector_type: "feishu-chat",
      status: "enabled",
      config: { chat_id: "oc_1" },
      created_at: "2026-08-12T00:00:00.000Z",
    });
    const runner = new ConnectorRunner(
      connector,
      new IngestionService(new MemoryBlobStore(), new MemoryAuthorityStore()),
      runtime,
      () => "2026-08-12T00:00:00.000Z",
    );

    const run = await runner.poll({
      installation_id: "feishu-installation",
      stream_key: "chat:oc_1",
      lease_owner: "worker-a",
      lease_duration_ms: 30_000,
    });
    const cursor = await runtime.getCursor("feishu-installation", "chat:oc_1");

    assert.equal(run.status, "completed");
    assert.equal(run.result.records[0].status, "accepted");
    assert.equal(cursor.cursor, JSON.stringify({ start_time: "1723420800" }));
  });

  it("passes the reusable poll connector conformance suite", async () => {
    const connector = createConnector({
      async listMessages() {
        return {
          items: [textItem()],
          has_more: true,
          page_token: "page-2",
        };
      },
    });
    const report = await verifyPollConnectorConformance({
      connector,
      cursor: null,
      connector_id: "feishu-chat",
      source: "feishu",
    });
    assert.equal(report.record_count, 1);
    assert.equal(
      report.next_cursor,
      JSON.stringify({ page_token: "page-2", start_time: "1723420800" }),
    );
  });

  it("extracts post plain text and ignores unknown msg_type", () => {
    assert.equal(
      extractFeishuText("text", JSON.stringify({ text: " hi " })),
      "hi",
    );
    assert.equal(
      extractFeishuText(
        "post",
        JSON.stringify({
          en_us: { content: [[{ tag: "text", text: "Hello" }, { tag: "a", text: " link" }]] },
        }),
      ),
      "Hello link",
    );
    assert.equal(extractFeishuText("image", "{}"), undefined);
    assert.equal(
      extractFeishuText(
        "text",
        JSON.stringify({
          text: '<at user_id="ou_2">@_user_1</at> please look',
        }),
        new Map([["ou_2", "Ben"]]),
      ),
      "@Ben please look",
    );
  });

  it("uses native mentions so @ is readable without contact lookup", async () => {
    const searched = [];
    const connector = createConnector({
      async listMessages() {
        return {
          items: [
            textItem({
              message_id: "om_at",
              body: {
                content: JSON.stringify({
                  text: '<at user_id="ou_2">@_user_1</at> 看一下 <at user_id="all">@_all</at>',
                }),
              },
              mentions: [
                { key: "@_user_1", id: "ou_2", name: "Ben" },
                { key: "@_all", id: "all", name: "所有人" },
              ],
            }),
          ],
          has_more: false,
        };
      },
      async resolveUserNames(ids) {
        searched.push(ids);
        return new Map();
      },
    });
    const result = await connector.poll(null);
    const body = result.batch.records[0].content.find((part) => part.role === "body");
    assert.equal(body.text, "@Ben 看一下 @所有人");
    assert.deepEqual(searched, [["ou_1"]]);
  });

  it("keeps @_user_1 when mentions and lookup both miss, so the hash stays stable", () => {
    assert.equal(
      extractFeishuText(
        "text",
        JSON.stringify({
          text: '<at user_id="ou_2">@_user_1</at> 看一下',
        }),
      ),
      "@_user_1 看一下",
    );
    assert.equal(
      extractFeishuText(
        "text",
        JSON.stringify({
          text: '<at user_id="ou_2">@_user_1</at> 看一下',
        }),
        undefined,
        [{ key: "@_user_1", id: "ou_2", name: "张三" }],
      ),
      "@张三 看一下",
    );
    assert.equal(
      extractFeishuText(
        "post",
        JSON.stringify({
          zh_cn: {
            content: [[
              { tag: "at", user_id: "ou_2", user_name: "@_user_1" },
              { tag: "text", text: " 请看" },
            ]],
          },
        }),
        undefined,
        [{ key: "@_user_1", id: "ou_2", name: "张三" }],
      ),
      "@张三 请看",
    );
    assert.equal(
      extractFeishuText(
        "text",
        JSON.stringify({
          text: '<at user_id="all">@_all</at> standup',
        }),
      ),
      "@所有人 standup",
    );
  });

  it("does not keep paging once has_more is false", () => {
    assert.deepEqual(
      nextFeishuCursor(
        { page_token: "page-2", start_time: "100" },
        { items: [], has_more: false },
      ),
      { start_time: "100" },
    );
  });
});

describe("FeishuChatEgress", () => {
  it("sends the text body and returns the Feishu message_id", async () => {
    const calls = [];
    const egress = new FeishuChatEgress(
      {
        async sendText(input) {
          calls.push(input);
          return { message_id: "om_out" };
        },
      },
      { installation_id: "feishu-1", chat_id: "oc_1" },
    );
    const receipt = await egress.send({
      installation_id: "feishu-1",
      content: [{ role: "body", media_type: "text/plain", text: "hello" }],
    });
    assert.equal(calls[0].chat_id, "oc_1");
    assert.equal(calls[0].text, "hello");
    assert.equal(typeof calls[0].uuid, "string");
    assert.deepEqual(receipt, { accepted: true, rpc_id: "om_out" });
  });

  it("rejects a send without a text body", async () => {
    const egress = new FeishuChatEgress(
      { async sendText() { return { message_id: "om_out" }; } },
      { installation_id: "feishu-1", chat_id: "oc_1" },
    );
    await assert.rejects(
      () =>
        egress.send({
          installation_id: "feishu-1",
          content: [{
            role: "attachment",
            media_type: "image/png",
            source_filename: "a.png",
            bytes: new Uint8Array([1]),
          }],
        }),
      FeishuApiError,
    );
  });
});
