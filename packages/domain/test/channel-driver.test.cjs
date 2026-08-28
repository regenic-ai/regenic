const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ChannelDriverError,
  ChannelDriverRegistry,
  driverCanReply,
  parseConversationThread,
  requireBindEgress,
  requireCreateThread,
  requireReplyPorts,
  requireWebhookPorts,
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
          capabilities: (installation) => ({
            sync: installation.status === "enabled",
            reply: installation.status === "enabled",
            create: false,
          }),
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

  it("reads hydrate_on_open from the driver, not the channel name", () => {
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
            list_title: "prompt",
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
            hydrate_on_open: true,
          }),
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
    assert.equal(
      drivers.hydrateOnOpen([dsh], { source: "dsh", target: "sess-a" }),
      false,
    );
    assert.equal(
      drivers.hydrateOnOpen([feishu], { source: "feishu", target: "oc_1" }),
      true,
    );
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
            list_title: "prompt",
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
      "prompt",
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

  it("keeps the first registered driver when a later one reuses the type", () => {
    const first = stubDriver({
      connector_type: "slack-channel",
      source: "slack",
      matchesThread: () => false,
      ownsThread: () => false,
      canReply: () => false,
      installCatalog: () => ({
        title: "Slack",
        description: "First.",
        credential_hint: "REGENIC_SLACK_TOKEN",
      }),
    });
    const drivers = new ChannelDriverRegistry()
      .register(first)
      .register(
        stubDriver({
          connector_type: "slack-channel",
          source: "extra",
          matchesThread: () => false,
          ownsThread: () => false,
          canReply: () => false,
          installCatalog: () => ({
            title: "Impostor",
            description: "Should not win.",
            credential_hint: "EXTRA",
          }),
        }),
      );
    assert.equal(drivers.get("slack-channel"), first);
    assert.equal(drivers.installCatalogs()[0].title, "Slack");
  });

  it("labels a source from the driver catalog, not CHANNELS", () => {
    const drivers = new ChannelDriverRegistry().register(
      stubDriver({
        connector_type: "dingtalk-chat",
        source: "dingtalk",
        matchesThread: () => false,
        ownsThread: () => false,
        installCatalog: () => ({
          title: "DingTalk",
          channel_label: "DingTalk",
          description: "Loaded plugin.",
          credential_hint: "none",
        }),
      }),
    );
    assert.equal(drivers.sourceLabel("dingtalk"), "DingTalk");
    assert.equal(drivers.sourceLabel("mail"), "MAIL");
  });

  it("falls back to catalog title when CHANNELS has no entry", () => {
    const drivers = new ChannelDriverRegistry().register(
      stubDriver({
        connector_type: "extra-review",
        source: "extra",
        matchesThread: () => false,
        ownsThread: () => false,
        installCatalog: () => ({
          title: "Extra review",
          description: "Loaded plugin.",
          credential_hint: "none",
        }),
      }),
    );
    assert.equal(drivers.sourceLabel("extra"), "Extra review");
  });

  it("lists install cards only from drivers that declare them", () => {
    const drivers = new ChannelDriverRegistry()
      .register(
        stubDriver({
          connector_type: "slack-channel",
          source: "slack",
          matchesThread: () => false,
          ownsThread: () => false,
          canReply: () => false,
        }),
      )
      .register(
        stubDriver({
          connector_type: "extra-review",
          source: "extra",
          matchesThread: () => false,
          ownsThread: () => false,
          canReply: () => false,
          installCatalog: () => ({
            title: "Extra review",
            description: "Loaded plugin.",
            credential_hint: "EXTRA_URL",
            singleton: true,
          }),
        }),
      );
    assert.deepEqual(drivers.installCatalogs(), [
      {
        connector_type: "extra-review",
        title: "Extra review",
        description: "Loaded plugin.",
        credential_hint: "EXTRA_URL",
        singleton: true,
      },
    ]);
  });

  it("reads canSend from capabilities.reply and requires sink methods only when sending", () => {
    const slack = stubDriver({
      connector_type: "slack-channel",
      source: "slack",
      matchesThread: () => true,
      ownsThread: () => true,
      capabilities: () => ({ sync: true, reply: false, create: false }),
    });
    delete slack.bindEgress;
    delete slack.createThread;
    delete slack.outboundId;
    const drivers = new ChannelDriverRegistry().register(slack);
    const installation = {
      id: "slack-1",
      org_id: "local-owner",
      connector_type: "slack-channel",
      status: "enabled",
      config: {},
      created_at: "2026-08-21T00:00:00.000Z",
    };
    assert.equal(drivers.canSend([installation], { source: "slack", target: "C1" }), false);
    assert.throws(
      () => requireCreateThread(slack),
      (error) => error instanceof ChannelDriverError && error.code === "unsupported_channel",
    );
    assert.throws(
      () => requireBindEgress(slack),
      (error) => error instanceof ChannelDriverError && error.code === "unsupported_channel",
    );
  });

  it("does not treat reply as sendable without bindEgress and outboundId", () => {
    const extra = stubDriver({
      connector_type: "extra-review",
      source: "extra",
      matchesThread: () => true,
      ownsThread: () => true,
      capabilities: () => ({ sync: true, reply: true, create: false }),
    });
    delete extra.outboundId;
    const installation = {
      id: "extra-1",
      org_id: "local-owner",
      connector_type: "extra-review",
      status: "enabled",
      config: {},
      created_at: "2026-08-21T00:00:00.000Z",
    };
    assert.equal(driverCanReply(extra, installation), false);
    assert.throws(
      () => requireReplyPorts(extra),
      (error) => error instanceof ChannelDriverError && error.code === "unsupported_channel",
    );
  });

  it("requires bindWebhook for webhook ingest", () => {
    const extra = stubDriver({
      connector_type: "extra-push",
      source: "extra",
      source_mode: "webhook",
    });
    assert.throws(
      () => requireWebhookPorts(extra),
      (error) => error instanceof ChannelDriverError && error.code === "unsupported_channel",
    );
    extra.bindWebhook = async () => ({
      source: "extra",
      source_mode: "webhook",
      async verifyWebhook(request) {
        return { body: request.body, verified_at: request.received_at };
      },
      async handleWebhook() {
        return { records: [] };
      },
    });
    assert.equal(typeof requireWebhookPorts(extra).bindWebhook, "function");
  });
});
