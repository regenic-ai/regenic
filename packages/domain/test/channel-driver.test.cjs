const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ChannelDriverError,
  ChannelDriverRegistry,
  parseConversationThread,
} = require("../dist");

function stubDriver(partial) {
  return {
    install() {
      throw new Error("not used");
    },
    resolveStreams() {
      return Promise.resolve([]);
    },
    resolveThreadStream() {
      return Promise.reject(new Error("not used"));
    },
    bindEgress() {
      return Promise.reject(new Error("not used"));
    },
    outboundId() {
      return "out";
    },
    capabilities() {
      return { sync: true, reply: false, create: false };
    },
    createThread() {
      return Promise.reject(new Error("not used"));
    },
    ...partial,
  };
}

describe("channel driver registry", () => {
  it("parses source:target and rejects empty sides", () => {
    assert.deepEqual(parseConversationThread("dsh:sess-a"), {
      source: "dsh",
      target: "sess-a",
    });
    assert.deepEqual(parseConversationThread("slack:C123"), {
      source: "slack",
      target: "C123",
    });
    assert.throws(
      () => parseConversationThread("dsh"),
      (error) => error instanceof ChannelDriverError && error.code === "invalid_config",
    );
  });

  it("resolves reply from installation + thread, not channel name in the kernel", () => {
    const drivers = new ChannelDriverRegistry()
      .register(
        stubDriver({
          connector_type: "dsh-session",
          source: "dsh",
          matchesThread: (installation, thread) =>
            thread.source === "dsh" &&
            installation.status === "enabled" &&
            (!installation.config.session_id ||
              installation.config.session_id === thread.target),
          ownsThread: (installation, thread) =>
            installation.config.session_id === thread.target,
          canReply: (installation) => installation.status === "enabled",
        }),
      )
      .register(
        stubDriver({
          connector_type: "slack-channel",
          source: "slack",
          matchesThread: (installation, thread) =>
            thread.source === "slack" &&
            installation.config.channel_id === thread.target,
          ownsThread: (installation, thread) =>
            installation.config.channel_id === thread.target,
          canReply: () => false,
        }),
      );
    const dsh = {
      id: "dsh-1",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "web" },
      created_at: "2026-08-21T00:00:00.000Z",
    };
    const slack = {
      id: "slack-1",
      org_id: "local-owner",
      connector_type: "slack-channel",
      status: "enabled",
      config: { channel_id: "C123" },
      created_at: "2026-08-21T00:00:00.000Z",
    };

    const pinned = {
      ...dsh,
      id: "dsh-pinned",
      config: { transport: "web", session_id: "sess-a" },
    };

    assert.equal(drivers.canSend([dsh, slack], { source: "dsh", target: "sess-a" }), true);
    assert.equal(drivers.canSend([dsh, slack], { source: "slack", target: "C123" }), false);
    assert.equal(
      drivers.awaitReply([dsh, slack], { source: "dsh", target: "sess-a" }),
      false,
    );
    assert.equal(
      drivers.awaitReply([dsh, slack], { source: "slack", target: "C123" }),
      false,
    );
    assert.equal(drivers.findForThread([dsh], { source: "slack", target: "C123" }), undefined);
    assert.equal(
      drivers.findForThread([dsh, pinned], { source: "dsh", target: "sess-a" })
        .installation.id,
      "dsh-pinned",
    );
    assert.equal(
      drivers.findForThread([dsh, pinned], { source: "dsh", target: "sess-b" })
        .installation.id,
      "dsh-1",
    );
    assert.equal(drivers.canCreate([slack]), false);
    assert.equal(drivers.canCreate([dsh, slack]), false);
  });

  it("picks the first enabled installation that can create a thread", () => {
    const drivers = new ChannelDriverRegistry()
      .register(
        stubDriver({
          connector_type: "slack-channel",
          source: "slack",
          matchesThread: () => false,
          ownsThread: () => false,
          capabilities: () => ({ sync: true, reply: false, create: false }),
          canReply: () => false,
        }),
      )
      .register(
        stubDriver({
          connector_type: "dsh-session",
          source: "dsh",
          matchesThread: () => true,
          ownsThread: () => false,
          capabilities: (installation) => ({
            sync: true,
            reply: true,
            create: !installation.config.session_id,
          }),
          canReply: () => true,
        }),
      );
    const slack = {
      id: "slack-1",
      org_id: "local-owner",
      connector_type: "slack-channel",
      status: "enabled",
      config: { channel_id: "C123" },
      created_at: "2026-08-21T00:00:00.000Z",
    };
    const dsh = {
      id: "dsh-1",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "web" },
      created_at: "2026-08-21T00:00:00.000Z",
    };
    const pinned = {
      ...dsh,
      id: "dsh-pinned",
      config: { transport: "web", session_id: "sess-a" },
    };

    assert.equal(drivers.canCreate([slack]), false);
    assert.equal(drivers.findCreatable([slack, pinned]), undefined);
    assert.equal(drivers.findCreatable([slack, dsh])?.installation.id, "dsh-1");
    assert.equal(drivers.awaitReply([dsh], { source: "dsh", target: "sess-a" }), false);
  });

  it("reads list_title from the driver, not the channel name", async () => {
    const drivers = new ChannelDriverRegistry()
      .register(
        stubDriver({
          connector_type: "dsh-session",
          source: "dsh",
          matchesThread: (_installation, thread) => thread.source === "dsh",
          ownsThread: () => true,
          capabilities: () => ({
            sync: true,
            reply: true,
            create: true,
            await_reply: true,
          }),
          canReply: () => true,
        }),
      )
      .register(
        stubDriver({
          connector_type: "feishu-chat",
          source: "feishu",
          matchesThread: (_installation, thread) => thread.source === "feishu",
          ownsThread: () => true,
          capabilities: () => ({
            sync: true,
            reply: true,
            create: false,
            list_title: "conversation",
          }),
          canReply: () => true,
          async resolveConversationLabels(_installation, threads) {
            return new Map(
              threads.map((thread) => [
                `${thread.source}:${thread.target}`,
                "Ada",
              ]),
            );
          },
        }),
      );
    const dsh = {
      id: "dsh-1",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "web" },
      created_at: "2026-08-21T00:00:00.000Z",
    };
    const feishu = {
      id: "feishu-1",
      org_id: "local-owner",
      connector_type: "feishu-chat",
      status: "enabled",
      config: { selection: "all" },
      created_at: "2026-08-21T00:00:00.000Z",
    };
    assert.equal(
      drivers.listTitle([dsh], { source: "dsh", target: "sess-a" }),
      "face",
    );
    assert.equal(
      drivers.listTitle([feishu], { source: "feishu", target: "oc_1" }),
      "conversation",
    );
    const labels = await drivers.resolveConversationLabels(
      [feishu],
      [{ source: "feishu", target: "oc_1" }],
    );
    assert.equal(labels.get("feishu:oc_1"), "Ada");
  });

  it("reads await_reply from the driver, not the channel name", () => {
    const drivers = new ChannelDriverRegistry()
      .register(
        stubDriver({
          connector_type: "dsh-session",
          source: "dsh",
          matchesThread: (_installation, thread) => thread.source === "dsh",
          ownsThread: () => true,
          capabilities: () => ({
            sync: true,
            reply: true,
            create: true,
            await_reply: true,
          }),
          canReply: () => true,
        }),
      )
      .register(
        stubDriver({
          connector_type: "feishu-chat",
          source: "feishu",
          matchesThread: (_installation, thread) => thread.source === "feishu",
          ownsThread: () => true,
          capabilities: () => ({ sync: true, reply: true, create: false }),
          canReply: () => true,
        }),
      );
    const dsh = {
      id: "dsh-1",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "web" },
      created_at: "2026-08-21T00:00:00.000Z",
    };
    const feishu = {
      id: "feishu-1",
      org_id: "local-owner",
      connector_type: "feishu-chat",
      status: "enabled",
      config: { selection: "all" },
      created_at: "2026-08-21T00:00:00.000Z",
    };
    assert.equal(drivers.awaitReply([dsh], { source: "dsh", target: "sess-a" }), true);
    assert.equal(
      drivers.awaitReply([feishu], { source: "feishu", target: "oc_1" }),
      false,
    );
  });

  it("merges catalog probes from drivers and isolates probe failures", async () => {
    const drivers = new ChannelDriverRegistry()
      .register(
        stubDriver({
          connector_type: "dsh-session",
          source: "dsh",
          matchesThread: () => false,
          ownsThread: () => false,
          canReply: () => false,
          async probeCatalog() {
            return {
              services: {
                "dsh-web": { ready: true, hint: "dsh web is reachable." },
              },
            };
          },
        }),
      )
      .register(
        stubDriver({
          connector_type: "feishu-chat",
          source: "feishu",
          matchesThread: () => false,
          ownsThread: () => false,
          canReply: () => false,
          async probeCatalog() {
            throw new Error("lark-cli missing");
          },
        }),
      );
    const probed = await drivers.probeCatalog({});
    assert.deepEqual(probed.services, {
      "dsh-web": { ready: true, hint: "dsh web is reachable." },
    });
    assert.deepEqual(probed.field_options, {});
  });
});
