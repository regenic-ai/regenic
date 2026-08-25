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
  extractFeishuMedia,
  extractFeishuText,
  lastFeishuInbound,
  nextFeishuCursor,
  planFeishuHistoryRequest,
  needsMediaReseed,
  needsRecentSeed,
  resetFeishuAttention,
} = require("../dist");

function createConnector(client, extras = {}) {
  return new FeishuChatPollConnector(client, {
    connector_id: "feishu-chat",
    org_id: "local-owner",
    chat_id: "oc_1",
    chat_name: "engineering",
    now: () => "2026-08-12T00:00:00.000Z",
    ...extras,
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
      value: JSON.stringify({
        page_token: "page-1",
        recent_seeded: true,
        media_synced: true,
      }),
    });

    assert.deepEqual(calls, [
      {
        chat_id: "oc_1",
        page_size: 50,
        page_token: "page-1",
        start_time: undefined,
        sort_type: "ByCreateTimeAsc",
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
    assert.equal(surface.direction, "inbound");
    assert.equal(
      result.next_cursor,
      JSON.stringify({
        page_token: "page-2",
        start_time: "1723420860",
        recent_seeded: true,
        media_synced: true,
      }),
    );
    assert.equal(result.next_cursor, result.batch.next_cursor);
    assert.equal(result.has_more, true);
  });

  it("marks my Feishu history as outbound and remembers only newer peer inbound", async () => {
    resetFeishuAttention();
    const connector = createConnector(
      {
        async listMessages() {
          return {
            items: [
              textItem({
                message_id: "om_old",
                create_time: "1723420860000",
                sender: { id: "ou_peer", sender_type: "user", name: "Bea" },
                body: { content: JSON.stringify({ text: "old peer" }) },
              }),
              textItem({
                message_id: "om_mine",
                create_time: "1723420900000",
                sender: { id: "ou_me", sender_type: "user", name: "Me" },
                body: { content: JSON.stringify({ text: "from phone" }) },
              }),
              textItem({
                message_id: "om_new",
                create_time: "1723420800000",
                sender: { id: "ou_peer", sender_type: "user", name: "Bea" },
                body: { content: JSON.stringify({ text: "listed last" }) },
              }),
            ],
            has_more: false,
          };
        },
      },
      { self_user_id: "ou_me" },
    );
    const result = await connector.poll(null);
    assert.equal(result.batch.records.length, 3);
    const directions = result.batch.records.map((record) =>
      JSON.parse(record.content.find((part) => part.role === "metadata").text)
        .direction,
    );
    assert.deepEqual(directions, ["inbound", "outbound", "inbound"]);
    assert.equal(lastFeishuInbound("oc_1"), "om_old");
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
    assert.equal(
      result.next_cursor,
      JSON.stringify({
        start_time: "1723420800",
        recent_seeded: true,
        media_synced: true,
      }),
    );
  });

  it("seeds the latest page first on a new conversation", async () => {
    const calls = [];
    const connector = createConnector({
      async listMessages(input) {
        calls.push(input);
        return {
          items: [
            textItem({
              message_id: "om_new",
              create_time: "1723500000000",
            }),
          ],
          has_more: true,
          page_token: "older",
        };
      },
    });
    const result = await connector.poll(null);
    assert.deepEqual(calls, [
      {
        chat_id: "oc_1",
        page_size: 50,
        sort_type: "ByCreateTimeDesc",
      },
    ]);
    assert.equal(result.batch.records[0].external_id, "oc_1:om_new");
    assert.equal(
      result.next_cursor,
      JSON.stringify({
        page_token: "older",
        sort: "desc",
        head_time: "1723500000",
        recent_seeded: true,
        media_synced: true,
      }),
    );
    assert.equal(result.has_more, true);
  });

  it("seeds recent messages without dropping a mid-history asc cursor", async () => {
    const calls = [];
    const connector = createConnector({
      async listMessages(input) {
        calls.push(input);
        return {
          items: [
            textItem({
              message_id: "om_latest",
              create_time: "1723600000000",
            }),
          ],
          has_more: true,
          page_token: "desc-2",
        };
      },
    });
    const result = await connector.poll({
      value: JSON.stringify({ page_token: "asc-20", start_time: "100" }),
    });
    assert.deepEqual(calls[0], {
      chat_id: "oc_1",
      page_size: 50,
      sort_type: "ByCreateTimeDesc",
    });
    assert.equal(
      result.next_cursor,
      JSON.stringify({
        page_token: "asc-20",
        start_time: "100",
        head_time: "1723600000",
        recent_seeded: true,
        media_synced: true,
      }),
    );
    assert.equal(result.has_more, true);
  });

  it("reseeds a live start_time cursor that never stored recent messages", async () => {
    const calls = [];
    const connector = createConnector({
      async listMessages(input) {
        calls.push(input);
        return {
          items: [textItem({ message_id: "om_recent", create_time: "1723600000000" })],
          has_more: true,
          page_token: "older",
        };
      },
    });
    const result = await connector.poll({
      value: JSON.stringify({ start_time: "1723420800" }),
    });
    assert.deepEqual(calls[0], {
      chat_id: "oc_1",
      page_size: 50,
      sort_type: "ByCreateTimeDesc",
    });
    assert.equal(result.batch.records[0].external_id, "oc_1:om_recent");
    assert.equal(result.has_more, true);
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
    assert.equal(
      cursor.cursor,
      JSON.stringify({
        start_time: "1723420800",
        recent_seeded: true,
        media_synced: true,
      }),
    );
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
      JSON.stringify({
        page_token: "page-2",
        sort: "desc",
        head_time: "1723420800",
        recent_seeded: true,
        media_synced: true,
      }),
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
    assert.deepEqual(
      extractFeishuMedia("image", JSON.stringify({ image_key: "img_1" })),
      [{ kind: "image", key: "img_1", filename: "image.png", media_type: "image/png" }],
    );
    assert.deepEqual(
      extractFeishuMedia(
        "file",
        JSON.stringify({ file_key: "file_1", file_name: "notes.pdf" }),
      ),
      [
        {
          kind: "file",
          key: "file_1",
          filename: "notes.pdf",
          media_type: "application/pdf",
        },
      ],
    );
    assert.deepEqual(
      extractFeishuMedia(
        "post",
        JSON.stringify({
          zh_cn: {
            content: [[{ tag: "img", image_key: "img_post" }, { tag: "text", text: "see" }]],
          },
        }),
      ),
      [{ kind: "image", key: "img_post", filename: "image.png", media_type: "image/png" }],
    );
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
        { page_token: "page-2", start_time: "100", recent_seeded: true },
        { items: [], has_more: false },
        "ByCreateTimeAsc",
      ),
      { start_time: "100", recent_seeded: true, media_synced: true },
    );
    assert.deepEqual(
      nextFeishuCursor(
        { page_token: "older", sort: "desc", head_time: "200", recent_seeded: true },
        { items: [], has_more: false },
        "ByCreateTimeDesc",
      ),
      { start_time: "200", recent_seeded: true, media_synced: true },
    );
    assert.equal(needsRecentSeed({}), true);
    assert.equal(needsRecentSeed({ page_token: "p1" }), true);
    assert.equal(needsRecentSeed({ start_time: "100" }), true);
    assert.equal(needsRecentSeed({ start_time: "100", recent_seeded: true }), false);
    assert.equal(needsMediaReseed({ start_time: "100", recent_seeded: true }), true);
    assert.equal(
      needsMediaReseed({ start_time: "100", recent_seeded: true, media_synced: true }),
      false,
    );
    assert.deepEqual(
      planFeishuHistoryRequest("oc_1", 50, {}),
      { chat_id: "oc_1", page_size: 50, sort_type: "ByCreateTimeDesc" },
    );
    assert.deepEqual(
      planFeishuHistoryRequest("oc_1", 50, { start_time: "100", recent_seeded: true }),
      { chat_id: "oc_1", page_size: 50, sort_type: "ByCreateTimeDesc" },
    );
    assert.deepEqual(
      planFeishuHistoryRequest("oc_1", 50, {
        start_time: "100",
        recent_seeded: true,
        media_synced: true,
      }),
      {
        chat_id: "oc_1",
        page_size: 50,
        page_token: undefined,
        start_time: "100",
        sort_type: "ByCreateTimeAsc",
      },
    );
  });

  it("downloads image and file history into attachment parts", async () => {
    const downloads = [];
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const connector = createConnector({
      async listMessages() {
        return {
          items: [
            {
              message_id: "om_img",
              msg_type: "image",
              create_time: "1723420800000",
              sender: { id: "ou_1", sender_type: "user", name: "Ada" },
              body: { content: JSON.stringify({ image_key: "img_shot" }) },
            },
            {
              message_id: "om_file",
              msg_type: "file",
              create_time: "1723420860000",
              sender: { id: "ou_1", sender_type: "user", name: "Ada" },
              body: {
                content: JSON.stringify({
                  file_key: "file_notes",
                  file_name: "notes.pdf",
                }),
              },
            },
            {
              message_id: "om_post",
              msg_type: "post",
              create_time: "1723420900000",
              sender: { id: "ou_1", sender_type: "user", name: "Ada" },
              body: {
                content: JSON.stringify({
                  zh_cn: {
                    content: [
                      [
                        { tag: "text", text: "see this" },
                        { tag: "img", image_key: "img_inline" },
                      ],
                    ],
                  },
                }),
              },
            },
          ],
          has_more: false,
        };
      },
      async downloadResource(input) {
        downloads.push(input);
        if (input.file_key === "file_notes") {
          return {
            bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
            media_type: "application/pdf",
            filename: "notes.pdf",
          };
        }
        return {
          bytes: png,
          media_type: "application/octet-stream",
          filename: "shot.png",
        };
      },
    });
    const result = await connector.poll({
      value: JSON.stringify({
        start_time: "1723420800",
        recent_seeded: true,
        media_synced: true,
      }),
    });
    assert.equal(result.batch.records.length, 3);
    assert.deepEqual(downloads, [
      { message_id: "om_img", file_key: "img_shot", type: "image" },
      { message_id: "om_file", file_key: "file_notes", type: "file" },
      { message_id: "om_post", file_key: "img_inline", type: "image" },
    ]);
    const image = result.batch.records[0].content.find((part) => part.role === "attachment");
    assert.equal(image.media_type, "image/png");
    assert.equal(image.source_filename, "shot.png");
    assert.deepEqual(Array.from(image.bytes), Array.from(png));
    const file = result.batch.records[1].content.find((part) => part.role === "attachment");
    assert.equal(file.media_type, "application/pdf");
    assert.equal(file.source_filename, "notes.pdf");
    const post = result.batch.records[2];
    assert.equal(
      post.content.find((part) => part.role === "body").text,
      "see this",
    );
    assert.equal(
      post.content.find((part) => part.role === "attachment").source_filename,
      "shot.png",
    );
  });

  it("keeps an image row when download is unavailable", async () => {
    const connector = createConnector({
      async listMessages() {
        return {
          items: [
            {
              message_id: "om_img",
              msg_type: "image",
              create_time: "1723420800000",
              sender: { id: "ou_1", sender_type: "user", name: "Ada" },
              body: { content: JSON.stringify({ image_key: "img_shot" }) },
            },
          ],
          has_more: false,
        };
      },
    });
    const result = await connector.poll({
      value: JSON.stringify({
        start_time: "1723420800",
        recent_seeded: true,
        media_synced: true,
      }),
    });
    assert.equal(result.batch.records.length, 1);
    const attachment = result.batch.records[0].content.find(
      (part) => part.role === "attachment",
    );
    assert.equal(attachment.source_filename, "image.png");
    assert.equal(attachment.bytes.byteLength, 0);
  });

  it("reseeds a live cursor once so previously dropped media can ingest", async () => {
    const calls = [];
    const connector = createConnector({
      async listMessages(input) {
        calls.push(input);
        return {
          items: [
            {
              message_id: "om_img",
              msg_type: "image",
              create_time: "1723600000000",
              sender: { id: "ou_1", sender_type: "user", name: "Ada" },
              body: { content: JSON.stringify({ image_key: "img_shot" }) },
            },
          ],
          has_more: false,
        };
      },
    });
    const result = await connector.poll({
      value: JSON.stringify({ start_time: "1723420800", recent_seeded: true }),
    });
    assert.deepEqual(calls[0], {
      chat_id: "oc_1",
      page_size: 50,
      sort_type: "ByCreateTimeDesc",
    });
    assert.equal(result.batch.records[0].external_id, "oc_1:om_img");
    assert.equal(
      result.next_cursor,
      JSON.stringify({
        start_time: "1723600000",
        recent_seeded: true,
        media_synced: true,
      }),
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

  it("uploads an image and sends it as an image message", async () => {
    const uploads = [];
    const messages = [];
    const texts = [];
    const egress = new FeishuChatEgress(recordingClient(uploads, messages, texts), {
      installation_id: "feishu-1",
      chat_id: "oc_1",
    });
    const receipt = await egress.send({
      installation_id: "feishu-1",
      content: [{
        role: "attachment",
        media_type: "image/png",
        source_filename: "shot.png",
        bytes: new Uint8Array([1, 2, 3]),
      }],
    });
    assert.deepEqual(uploads, [{
      filename: "shot.png",
      media_type: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    }]);
    assert.equal(texts.length, 0);
    assert.equal(messages[0].msg_type, "image");
    assert.deepEqual(messages[0].content, { image_key: "img_shot.png" });
    assert.deepEqual(receipt, { accepted: true, rpc_id: "om_image" });
  });

  it("sends text and the image as separate IM messages", async () => {
    const uploads = [];
    const messages = [];
    const texts = [];
    const egress = new FeishuChatEgress(recordingClient(uploads, messages, texts), {
      installation_id: "feishu-1",
      chat_id: "oc_1",
    });
    const receipt = await egress.send({
      installation_id: "feishu-1",
      content: [
        { role: "body", media_type: "text/plain", text: "Agent OS准备改成这样" },
        {
          role: "attachment",
          media_type: "image/png",
          source_filename: "tasks.png",
          bytes: new Uint8Array([9]),
        },
      ],
    });
    assert.equal(texts[0].text, "Agent OS准备改成这样");
    assert.equal(uploads.length, 1);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].msg_type, "image");
    assert.deepEqual(messages[0].content, { image_key: "img_tasks.png" });
    assert.deepEqual(receipt, { accepted: true, rpc_id: "om_text" });
  });

  it("rejects an attachment without bytes instead of sending text only", async () => {
    const egress = new FeishuChatEgress(
      recordingClient([], []),
      { installation_id: "feishu-1", chat_id: "oc_1" },
    );
    await assert.rejects(
      () =>
        egress.send({
          installation_id: "feishu-1",
          content: [
            { role: "body", media_type: "text/plain", text: "hello" },
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "a.png",
            },
          ],
        }),
      /attachment without bytes/,
    );
  });
});

function recordingClient(uploads, messages, texts = []) {
  return {
    async sendText(input) {
      texts.push(input);
      return { message_id: "om_text" };
    },
    async sendMessage(input) {
      messages.push(input);
      return { message_id: "om_image" };
    },
    async uploadImage(input) {
      uploads.push(input);
      return { image_key: `img_${input.filename}` };
    },
    async uploadFile(input) {
      uploads.push(input);
      return { file_key: `file_${input.filename}` };
    },
  };
}
