const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ChannelDriverError,
  INGEST_SCHEMA_VERSION,
  IngestionService,
  MemoryAuthorityStore,
  MemoryBlobStore,
  MemoryConnectorRegistry,
  MemoryEgressRegistry,
  channelRecord,
  verifyChannelDriverConformance,
} = require("@regenic/domain");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const {
  FEISHU_STREAM_PACE,
  createFeishuStreams,
  feishuChatDriver,
  feishuWriteBackLabels,
  resolveFeishuChatTargets,
} = require("../dist/feishu-chat-driver");
const { createFeishuSyncSource } = require("../dist/feishu-sync-source");
const { feishuChatPlugin } = require("../dist/plugin");

describe("feishuChatPlugin", () => {
  it("registers on connectors and egress and unregisters when disposed", async () => {
    const host = await createHost();
    const connectors = new MemoryConnectorRegistry();
    const egress = new MemoryEgressRegistry();
    await host.plugin(definePlugin({
      name: "registries",
      apply(ctx) {
        ctx.provide("connectors", connectors);
        ctx.provide("egress", egress);
      },
    }));

    const mounted = await host.plugin(feishuChatPlugin, {
      installation_id: "feishu-1",
      org_id: "local-owner",
      chat_id: "oc_1",
      async spawn() {
        throw new Error("CLI should not run during register");
      },
    });

    assert.equal(connectors.get("feishu-1")?.source, "feishu");
    assert.equal(connectors.getStream("feishu-1")?.stream_key, "chat:oc_1");
    assert.equal(connectors.getStream("feishu-1")?.thread_id, "feishu:oc_1");
    assert.equal(egress.get("feishu-1")?.source, "feishu");
    await mounted.dispose();
    assert.equal(connectors.get("feishu-1"), undefined);
    assert.equal(egress.get("feishu-1"), undefined);
    await host.dispose();
  });

  it("registers one stream per chat on the same installation", async () => {
    const host = await createHost();
    const connectors = new MemoryConnectorRegistry();
    const egress = new MemoryEgressRegistry();
    await host.plugin(definePlugin({
      name: "registries",
      apply(ctx) {
        ctx.provide("connectors", connectors);
        ctx.provide("egress", egress);
      },
    }));
    const mounted = await host.plugin(feishuChatPlugin, {
      installation_id: "feishu-1",
      org_id: "local-owner",
      chats: [
        { chat_id: "oc_1", name: "Ada" },
        { chat_id: "oc_2", name: "Ben" },
      ],
      async spawn() {
        throw new Error("CLI should not run during register");
      },
    });
    assert.equal(connectors.get("feishu-1"), undefined);
    assert.deepEqual(
      connectors.listStreams("feishu-1").map((stream) => stream.thread_id),
      ["feishu:oc_1", "feishu:oc_2"],
    );
    assert.equal(egress.get("feishu-1", "chat:oc_2")?.source, "feishu");
    await mounted.dispose();
    assert.equal(connectors.listStreams("feishu-1").length, 0);
    await host.dispose();
  });
});

describe("feishuChatDriver", () => {
  const installation = {
    id: "feishu-1",
    org_id: "local-owner",
    connector_type: "feishu-chat",
    status: "enabled",
    config: { chat_id: "oc_1", chat_name: "engineering" },
    created_at: "2026-08-22T00:00:00.000Z",
  };

  it("titles lists from the conversation, not the message face", async () => {
    assert.deepEqual(feishuChatDriver.capabilities(installation), {
      sync: true,
      reply: true,
      create: false,
      list_title: "conversation",
      hydrate_on_open: true,
      attention: true,
      receipts: true,
    });
    const picked = feishuChatDriver.install({
      id: "feishu-2",
      org_id: "local-owner",
      config: {
        selection: "pick",
        chat_ids: ["oc_1"],
        chat_names: ["Ada"],
      },
      now: "2026-08-22T00:00:00.000Z",
    });
    const labels = await feishuChatDriver.resolveConversationLabels(
      picked,
      [{ source: "feishu", target: "oc_1" }],
      {},
    );
    assert.equal(labels.get("feishu:oc_1"), "Ada");
    const all = feishuChatDriver.install({
      id: "feishu-3",
      org_id: "local-owner",
      config: { selection: "all" },
      now: "2026-08-22T00:00:00.000Z",
    });
    const { LarkCliClient } = require("../dist/feishu-cli-client");
    const original = LarkCliClient.prototype.getChat;
    LarkCliClient.prototype.getChat = async function getChat(chatId) {
      assert.equal(chatId, "oc_hot");
      return { chat_id: chatId, name: "工程群", chat_mode: "group" };
    };
    try {
      const live = await feishuChatDriver.resolveConversationLabels(
        all,
        [{ source: "feishu", target: "oc_hot" }],
        {},
      );
      assert.equal(live.get("feishu:oc_hot"), "工程群");
    } finally {
      LarkCliClient.prototype.getChat = original;
    }
  });

  it("applies SyncEngine catalog labels when mounting known chats", async () => {
    const host = await createHost();
    const connectors = new MemoryConnectorRegistry();
    const egress = new MemoryEgressRegistry();
    await host.plugin(definePlugin({
      name: "registries",
      apply(ctx) {
        ctx.provide("connectors", connectors);
        ctx.provide("egress", egress);
      },
    }));
    const streams = await feishuChatDriver.resolveStreams(
      {
        id: "feishu-1",
        org_id: "local-owner",
        connector_type: "feishu-chat",
        status: "enabled",
        config: { selection: "all", kinds: ["group", "p2p"] },
        created_at: "2026-08-22T00:00:00.000Z",
      },
      host,
      { REGENIC_LARK_CLI: "/missing-lark-cli" },
      {
        threads: [{ source: "feishu", target: "oc_eng" }],
        catalog: [
          {
            stream_key: "chat:oc_eng",
            thread_id: "feishu:oc_eng",
            label: "工程群",
            kind: "group",
          },
        ],
      },
    );
    assert.equal(streams.length, 1);
    assert.equal(streams[0].thread_id, "feishu:oc_eng");
    assert.equal(connectors.getStream("feishu-1", "chat:oc_eng")?.label, "工程群");
    assert.equal(
      connectors.getStream("feishu-1", "chat:oc_eng")?.connector.describeChat().name,
      "工程群",
    );
    await host.dispose();
  });

  it("installs all groups or a picked set", () => {
    const all = feishuChatDriver.install({
      id: "feishu-1",
      org_id: "local-owner",
      config: { selection: "all" },
      now: "2026-08-22T00:00:00.000Z",
    });
    assert.deepEqual(all.config, { selection: "all", kinds: ["group", "p2p"] });
    assert.equal(all.credentials_ref, "keychain:lark-cli");
    assert.equal(feishuChatDriver.connector_protocol, "1.0");
    assert.equal(
      feishuChatDriver.matchesThread(all, { source: "feishu", target: "oc_9" }),
      true,
    );
    assert.equal(
      feishuChatDriver.ownsThread(all, { source: "feishu", target: "oc_9" }),
      false,
    );

    const picked = feishuChatDriver.install({
      id: "feishu-2",
      org_id: "local-owner",
      config: { selection: "pick", chat_ids: "oc_1,oc_2" },
      now: "2026-08-22T00:00:00.000Z",
    });
    assert.deepEqual(picked.config, { selection: "pick", chat_ids: ["oc_1", "oc_2"] });
    assert.equal(
      feishuChatDriver.matchesThread(picked, { source: "feishu", target: "oc_2" }),
      true,
    );
    assert.equal(
      feishuChatDriver.ownsThread(picked, { source: "feishu", target: "oc_2" }),
      true,
    );
    assert.equal(
      feishuChatDriver.matchesThread(picked, { source: "feishu", target: "oc_9" }),
      false,
    );
  });

  it("keeps a legacy single chat_id install", () => {
    const created = feishuChatDriver.install({
      id: "feishu-1",
      org_id: "local-owner",
      config: { chat_id: "oc_1", chat_name: "engineering" },
      now: "2026-08-22T00:00:00.000Z",
    });
    assert.deepEqual(created.config, {
      selection: "pick",
      chat_ids: ["oc_1"],
      chat_names: ["engineering"],
    });
    assert.deepEqual(feishuChatDriver.presentInstall(created).label, {
      literal: "engineering",
    });
    assert.equal(
      feishuChatDriver.matchesThread(installation, { source: "feishu", target: "oc_1" }),
      true,
    );
    assert.equal(
      feishuChatDriver.outboundId(
        { source: "feishu", target: "oc_1" },
        { accepted: true, rpc_id: "om_out" },
      ),
      "oc_1:out:om_out",
    );
  });

  it("dedupes a split Feishu image echo against reply outbound ids", async () => {
    const authority = new MemoryAuthorityStore();
    const blobs = new MemoryBlobStore();
    const service = new IngestionService(blobs, authority);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const outboundId = feishuChatDriver.outboundId(
      { source: "feishu", target: "oc_1" },
      { accepted: true, rpc_id: "om_text" },
    );
    const outbound = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "feishu-out-reply",
      received_at: "2026-09-02T00:15:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: outboundId,
          occurred_at: "2026-09-02T00:15:00.000Z",
          actor_id: "local-owner",
          scope_id: "oc_1",
          text: "记得我这个小技巧会更符合写代码逻辑",
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "tasks.png",
              bytes: png,
            },
          ],
        }),
      ],
    });
    const echoed = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "feishu-sync-reply",
      received_at: "2026-09-02T00:15:02.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: "oc_1:om_text",
          occurred_at: "2026-09-02T00:15:00.000Z",
          actor_id: "ou_1",
          scope_id: "oc_1",
          text: "记得我这个小技巧会更符合写代码逻辑",
        }),
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: "oc_1:om_image",
          occurred_at: "2026-09-02T00:15:01.000Z",
          actor_id: "ou_1",
          scope_id: "oc_1",
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "image.png",
              bytes: png,
            },
          ],
        }),
      ],
    });

    assert.equal(outbound.records[0].status, "accepted");
    assert.equal(echoed.records[0].status, "duplicate");
    assert.equal(echoed.records[1].status, "duplicate");
    assert.equal(echoed.records[0].event_id, outbound.records[0].event_id);
    assert.equal(echoed.records[1].event_id, outbound.records[0].event_id);
    assert.equal(authority.allEvents().length, 1);
  });

  it("installs all direct messages only", () => {
    const created = feishuChatDriver.install({
      id: "feishu-3",
      org_id: "local-owner",
      config: { selection: "all", kinds: "p2p" },
      now: "2026-08-22T00:00:00.000Z",
    });
    assert.deepEqual(created.config, { selection: "all", kinds: ["p2p"] });
  });

  it("mounts resolved chats through the host connector registry", async () => {
    const host = await createHost();
    const connectors = new MemoryConnectorRegistry();
    const egress = new MemoryEgressRegistry();
    await host.plugin(definePlugin({
      name: "registries",
      apply(ctx) {
        ctx.provide("connectors", connectors);
        ctx.provide("egress", egress);
      },
    }));
    const streams = await feishuChatDriver.resolveStreams(
      {
        id: "feishu-1",
        org_id: "local-owner",
        connector_type: "feishu-chat",
        status: "enabled",
        config: { selection: "pick", chat_ids: ["oc_1"], chat_names: ["Ada"] },
        created_at: "2026-08-22T00:00:00.000Z",
      },
      host,
      {},
    );
    assert.equal(streams.length, 1);
    assert.equal(streams[0].thread_id, "feishu:oc_1");
    assert.equal(connectors.getStream("feishu-1", "chat:oc_1")?.label, "Ada");
    const again = await feishuChatDriver.resolveStreams(
      {
        id: "feishu-1",
        org_id: "local-owner",
        connector_type: "feishu-chat",
        status: "enabled",
        config: { selection: "pick", chat_ids: ["oc_1"], chat_names: ["Ada"] },
        created_at: "2026-08-22T00:00:00.000Z",
      },
      host,
      {},
    );
    assert.equal(again.length, 1);
    assert.equal(connectors.listStreams("feishu-1").length, 1);
    const listed = await feishuChatDriver.resolveStreams(
      {
        id: "feishu-1",
        org_id: "local-owner",
        connector_type: "feishu-chat",
        status: "enabled",
        config: { selection: "all", kinds: ["group", "p2p"] },
        created_at: "2026-08-22T00:00:00.000Z",
      },
      host,
      { REGENIC_LARK_CLI: "/missing-lark-cli" },
      { threads: [{ source: "feishu", target: "oc_1" }] },
    );
    assert.equal(listed.length, 1);
    assert.equal(listed[0].thread_id, "feishu:oc_1");
    await host.dispose();
  });

  it("opens one thread without listing every Feishu chat", async () => {
    const host = await createHost();
    const connectors = new MemoryConnectorRegistry();
    const egress = new MemoryEgressRegistry();
    await host.plugin(definePlugin({
      name: "registries",
      apply(ctx) {
        ctx.provide("connectors", connectors);
        ctx.provide("egress", egress);
      },
    }));
    const stream = await feishuChatDriver.resolveThreadStream(
      {
        id: "feishu-1",
        org_id: "local-owner",
        connector_type: "feishu-chat",
        status: "enabled",
        config: { selection: "all", kinds: ["group", "p2p"] },
        created_at: "2026-08-22T00:00:00.000Z",
      },
      { source: "feishu", target: "oc_hot" },
      host,
      {},
    );
    assert.equal(stream.thread_id, "feishu:oc_hot");
    assert.equal(connectors.listStreams("feishu-1").length, 1);
    await host.dispose();
  });

  it("resolves all conversations including p2p", async () => {
    const chats = await resolveFeishuChatTargets(
      { selection: "all" },
      {
        async listRecentChats(types, options) {
          assert.deepEqual(types, ["group", "p2p"]);
          assert.equal(options?.names, false);
          return [
            { chat_id: "oc_g", name: "Team", chat_mode: "group" },
            { chat_id: "oc_p", name: "Ada", chat_mode: "p2p" },
          ];
        },
        async listAllChats() {
          throw new Error("resolveStreams must not census every chat");
        },
      },
    );
    assert.deepEqual(
      chats.map((chat) => chat.chat_id),
      ["oc_g", "oc_p"],
    );
    const streams = createFeishuStreams(
      {
        id: "feishu-1",
        org_id: "local-owner",
        connector_type: "feishu-chat",
        status: "enabled",
        config: { selection: "all" },
        created_at: "2026-08-22T00:00:00.000Z",
      },
      chats,
      { async listMessages() { return { items: [], has_more: false }; } },
    );
    assert.equal(streams.length, 2);
    assert.equal(streams[0].thread_id, "feishu:oc_g");
    assert.equal(streams[0].label, "Team");
    assert.equal(streams[1].thread_id, "feishu:oc_p");
    assert.deepEqual(streams[0].pace, FEISHU_STREAM_PACE);
    assert.deepEqual(streams[1].pace, FEISHU_STREAM_PACE);
  });

  it("does not list chats when picked names are already stored", async () => {
    let listed = 0;
    const chats = await resolveFeishuChatTargets(
      { selection: "pick", chat_ids: ["oc_1", "oc_2"], chat_names: ["Ada", "Ben"] },
      {
        async listAllChats() {
          listed += 1;
          return [];
        },
        async listRecentChats() {
          listed += 1;
          return [];
        },
      },
    );
    assert.equal(listed, 0);
    assert.deepEqual(chats, [
      { chat_id: "oc_1", name: "Ada" },
      { chat_id: "oc_2", name: "Ben" },
    ]);
  });

  it("fills missing picked names from the recent directory", async () => {
    let recent = 0;
    let all = 0;
    const chats = await resolveFeishuChatTargets(
      { selection: "pick", chat_ids: ["oc_1"] },
      {
        async listAllChats() {
          all += 1;
          return [];
        },
        async listRecentChats(types, options) {
          recent += 1;
          assert.equal(types, undefined);
          assert.equal(options?.names, true);
          return [{ chat_id: "oc_1", name: "Ada", chat_mode: "p2p" }];
        },
      },
    );
    assert.equal(recent, 1);
    assert.equal(all, 0);
    assert.deepEqual(chats, [
      { chat_id: "oc_1", name: "Ada", chat_mode: "p2p" },
    ]);
  });

  it("lists all chats when the recent page misses a picked name", async () => {
    let all = 0;
    const chats = await resolveFeishuChatTargets(
      { selection: "pick", chat_ids: ["oc_old"] },
      {
        async listRecentChats() {
          return [{ chat_id: "oc_hot", name: "Ada" }];
        },
        async listAllChats(maxPages) {
          all += 1;
          assert.equal(maxPages, require("../dist/probe").CATALOG_CHAT_PAGES);
          return [{ chat_id: "oc_old", name: "Legacy", chat_mode: "group" }];
        },
      },
    );
    assert.equal(all, 1);
    assert.deepEqual(chats, [
      { chat_id: "oc_old", name: "Legacy", chat_mode: "group" },
    ]);
  });

  it("censuses chats only when discover is full", async () => {
    let recent = 0;
    let all = 0;
    const chats = await resolveFeishuChatTargets(
      { selection: "all" },
      {
        async listRecentChats() {
          recent += 1;
          return [{ chat_id: "oc_hot", name: "Ada" }];
        },
        async listAllChats(maxPages) {
          all += 1;
          assert.equal(maxPages, require("../dist/probe").CATALOG_CHAT_PAGES);
          return [
            { chat_id: "oc_hot", name: "Ada" },
            { chat_id: "oc_old", name: "Legacy" },
          ];
        },
      },
      { discover: "full" },
    );
    assert.equal(recent, 0);
    assert.equal(all, 1);
    assert.deepEqual(
      chats.map((chat) => chat.chat_id),
      ["oc_hot", "oc_old"],
    );
    const known = await resolveFeishuChatTargets(
      { selection: "all" },
      {
        async listRecentChats() {
          recent += 1;
          return [];
        },
        async listAllChats() {
          all += 1;
          return [];
        },
      },
      {
        known: [{ chat_id: "oc_work", name: "Work" }],
        discover: "known",
      },
    );
    assert.equal(recent, 0);
    assert.equal(all, 1);
    assert.deepEqual(
      known.map((chat) => chat.chat_id),
      ["oc_work"],
    );
  });

  it("reuses known chats on a busy tick without listing", async () => {
    let listed = 0;
    const chats = await resolveFeishuChatTargets(
      { selection: "all" },
      {
        async listAllChats() {
          listed += 1;
          return [];
        },
        async listRecentChats() {
          listed += 1;
          return [];
        },
      },
      {
        known: [{ chat_id: "oc_hot", name: "Ada", chat_mode: "p2p" }],
        discover: "known",
      },
    );
    assert.equal(listed, 0);
    assert.deepEqual(chats, [
      { chat_id: "oc_hot", name: "Ada", chat_mode: "p2p" },
    ]);
  });

  it("keeps known chats when the recent directory page fails", async () => {
    const chats = await resolveFeishuChatTargets(
      { selection: "all" },
      {
        async listRecentChats() {
          throw new Error("lark down");
        },
      },
      {
        known: [{ chat_id: "oc_work", name: "Work" }],
        discover: "recent",
      },
    );
    assert.deepEqual(
      chats.map((chat) => ({ chat_id: chat.chat_id, name: chat.name })),
      [{ chat_id: "oc_work", name: "Work" }],
    );
  });

  it("mounts kernel-eligible Feishu chats without listing the directory", async () => {
    const host = await createHost();
    const connectors = new MemoryConnectorRegistry();
    const egress = new MemoryEgressRegistry();
    await host.plugin(definePlugin({
      name: "registries",
      apply(ctx) {
        ctx.provide("connectors", connectors);
        ctx.provide("egress", egress);
      },
    }));
    const streams = await feishuChatDriver.resolveStreams(
      {
        id: "feishu-1",
        org_id: "local-owner",
        connector_type: "feishu-chat",
        status: "enabled",
        config: { selection: "all", kinds: ["group", "p2p"] },
        created_at: "2026-08-22T00:00:00.000Z",
      },
      host,
      { REGENIC_LARK_CLI: "/missing-lark-cli" },
      { threads: [{ source: "feishu", target: "oc_work" }] },
    );
    assert.equal(streams.length, 1);
    assert.equal(streams[0].thread_id, "feishu:oc_work");
    await host.dispose();
  });

  it("keeps mounted Feishu chats that left this tick's eligible set", async () => {
    const host = await createHost();
    const connectors = new MemoryConnectorRegistry();
    const egress = new MemoryEgressRegistry();
    await host.plugin(definePlugin({
      name: "registries",
      apply(ctx) {
        ctx.provide("connectors", connectors);
        ctx.provide("egress", egress);
      },
    }));
    const installation = {
      id: "feishu-1",
      org_id: "local-owner",
      connector_type: "feishu-chat",
      status: "enabled",
      config: { selection: "all", kinds: ["group", "p2p"] },
      created_at: "2026-08-22T00:00:00.000Z",
    };
    await feishuChatDriver.resolveThreadStream(
      installation,
      { source: "feishu", target: "oc_old" },
      host,
      {},
    );
    assert.equal(connectors.listStreams("feishu-1").length, 1);
    const streams = await feishuChatDriver.resolveStreams(
      installation,
      host,
      { REGENIC_LARK_CLI: "/missing-lark-cli" },
      { threads: [{ source: "feishu", target: "oc_work" }] },
    );
    assert.deepEqual(
      streams.map((stream) => stream.thread_id),
      ["feishu:oc_work"],
    );
    assert.equal(connectors.listStreams("feishu-1").length, 2);
    assert.ok(connectors.getStream("feishu-1", "chat:oc_old"));
    assert.ok(egress.get("feishu-1", "chat:oc_old"));
    await host.dispose();
  });

  it("merges a recent directory page onto known chats", async () => {
    let all = 0;
    const chats = await resolveFeishuChatTargets(
      { selection: "all", kinds: ["group", "p2p"] },
      {
        async listAllChats() {
          all += 1;
          return [];
        },
        async listRecentChats() {
          return [{ chat_id: "oc_new", name: "New", chat_mode: "group" }];
        },
      },
      {
        known: [{ chat_id: "oc_hot", name: "Ada" }],
        discover: "recent",
      },
    );
    assert.equal(all, 0);
    assert.deepEqual(
      chats.map((chat) => chat.chat_id),
      ["oc_hot", "oc_new"],
    );
  });

  it("requires a picked conversation and cannot create a conversation", async () => {
    const recent = feishuChatDriver.install({
      id: "feishu-recent",
      org_id: "local-owner",
      config: { selection: "recent", kinds: ["group", "p2p"] },
      now: "2026-08-22T00:00:00.000Z",
    });
    assert.deepEqual(recent.config, {
      selection: "recent",
      kinds: ["group", "p2p"],
    });
    const bare = feishuChatDriver.install({
      id: "feishu-default",
      org_id: "local-owner",
      config: { kinds: ["group"] },
      now: "2026-08-22T00:00:00.000Z",
    });
    assert.deepEqual(bare.config, {
      selection: "recent",
      kinds: ["group"],
    });
    assert.throws(
      () =>
        feishuChatDriver.install({
          id: "feishu-1",
          org_id: "local-owner",
          config: { selection: "pick" },
          now: "2026-08-22T00:00:00.000Z",
        }),
      (error) => error instanceof ChannelDriverError && error.code === "invalid_config",
    );
    assert.throws(
      () =>
        feishuChatDriver.install({
          id: "feishu-1",
          org_id: "local-owner",
          config: { selection: "all", kinds: "none" },
          now: "2026-08-22T00:00:00.000Z",
        }),
      (error) => error instanceof ChannelDriverError && error.code === "invalid_config",
    );
    assert.equal(feishuChatDriver.createThread, undefined);
    verifyChannelDriverConformance({
      driver: feishuChatDriver,
      enabled: installation,
    });
  });

  it("advertises Feishu setup steps on the Engine catalog", () => {
    const catalog = feishuChatDriver.installCatalog();
    assert.equal(catalog.fields[0].default, "recent");
    const kinds = catalog.fields.find((field) => field.key === "kinds");
    assert.deepEqual(kinds?.visible_when, {
      field: "selection",
      values: ["all", "recent", "pick"],
    });
    assert.equal(
      catalog.setup_steps[0].command,
      "npx @larksuite/cli@latest install",
    );
    assert.equal(catalog.setup_steps[0].href, "https://github.com/larksuite/cli");
  });

  it("aliases Feishu approval labels for write-back", () => {
    assert.ok(feishuWriteBackLabels("同意").includes("通过"));
    assert.ok(feishuWriteBackLabels("通过").includes("同意"));
    assert.ok(feishuWriteBackLabels("拒绝").includes("驳回"));
    assert.deepEqual(feishuChatDriver.writeBackLabels("同意"), feishuWriteBackLabels("同意"));
  });
});

describe("createFeishuRecentSyncSource", () => {
  it("lists only the recent directory page and marks the catalog complete", async () => {
    let all = 0;
    const { createFeishuRecentSyncSource } = require("../dist/feishu-sync-source");
    const source = createFeishuRecentSyncSource(
      {
        async listRecentChats(types, options) {
          assert.deepEqual(types, ["group"]);
          assert.equal(options?.names, true);
          return [{ chat_id: "oc_hot", name: "Ada", chat_mode: "group" }];
        },
        async listChats() {
          all += 1;
          return { items: [] };
        },
      },
      ["group"],
    );
    const page = await source.listDirectory(null);
    assert.equal(all, 0);
    assert.equal(page.complete, true);
    assert.deepEqual(
      page.members.map((member) => member.thread_id),
      ["feishu:oc_hot"],
    );
  });
});

describe("createFeishuSyncSource", () => {
  it("pages groups first then p2p so the group census can stay on HTTP", async () => {
    const calls = [];
    const source = createFeishuSyncSource(
      {
        async listChats(input) {
          calls.push(input);
          if (input.types?.length === 1 && input.types[0] === "group") {
            return {
              items: [{ chat_id: "oc_g", name: "Eng", chat_mode: "group" }],
              has_more: false,
            };
          }
          return {
            items: [{ chat_id: "oc_dm", name: "Ada", chat_mode: "p2p" }],
            has_more: false,
          };
        },
      },
      ["group", "p2p"],
    );
    const groups = await source.listDirectory(null);
    assert.deepEqual(
      groups.members.map((member) => member.thread_id),
      ["feishu:oc_g"],
    );
    assert.equal(groups.members[0].label, "Eng");
    assert.equal(groups.complete, false);
    assert.equal(calls[0].types[0], "group");
    assert.equal(calls[0].page_size, 100);
    assert.equal(calls[0].names, false);
    const p2p = await source.listDirectory(groups.next_cursor);
    assert.deepEqual(
      p2p.members.map((member) => member.thread_id),
      ["feishu:oc_dm"],
    );
    assert.equal(p2p.members[0].label, "Ada");
    assert.equal(p2p.complete, true);
    assert.deepEqual(calls[1].types, ["p2p"]);
    assert.equal(calls[1].names, true);
  });
});
