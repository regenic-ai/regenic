const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ChannelDriverError,
  MemoryConnectorRegistry,
  MemoryEgressRegistry,
} = require("@regenic/domain");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const {
  FEISHU_STREAM_PACE,
  createFeishuStreams,
  feishuChatDriver,
  resolveFeishuChatTargets,
} = require("../dist/feishu-chat-driver");
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
    const live = await feishuChatDriver.resolveConversationLabels(
      all,
      [{ source: "feishu", target: "oc_hot" }],
      {},
    );
    assert.equal(live.size, 0);
  });

  it("installs all groups or a picked set", () => {
    const all = feishuChatDriver.install({
      id: "feishu-1",
      org_id: "local-owner",
      config: { selection: "all" },
      now: "2026-08-22T00:00:00.000Z",
    });
    assert.deepEqual(all.config, { selection: "all", kinds: ["group", "p2p"] });
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
    assert.deepEqual(created.config, { selection: "pick", chat_ids: ["oc_1"] });
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

  it("does not list chats to fill missing picked names", async () => {
    let listed = 0;
    const chats = await resolveFeishuChatTargets(
      { selection: "pick", chat_ids: ["oc_1"] },
      {
        async listAllChats() {
          listed += 1;
          return [{ chat_id: "oc_1", name: "Ada" }];
        },
        async listRecentChats() {
          listed += 1;
          return [{ chat_id: "oc_1", name: "Ada" }];
        },
      },
    );
    assert.equal(listed, 0);
    assert.deepEqual(chats, [{ chat_id: "oc_1", name: undefined }]);
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

  it("unmounts Feishu chats that left the eligible set", async () => {
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
    assert.equal(connectors.listStreams("feishu-1").length, 1);
    assert.equal(connectors.getStream("feishu-1", "chat:oc_old"), undefined);
    assert.equal(egress.get("feishu-1", "chat:oc_old"), undefined);
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
    await assert.rejects(
      () => feishuChatDriver.createThread(installation, {}, process.env),
      (error) => error instanceof ChannelDriverError && error.code === "unsupported_channel",
    );
  });
});
