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
            thread.source === "dsh" && installation.status === "enabled",
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

    assert.equal(drivers.canSend([dsh, slack], { source: "dsh", target: "sess-a" }), true);
    assert.equal(drivers.canSend([dsh, slack], { source: "slack", target: "C123" }), false);
    assert.equal(drivers.findForThread([dsh], { source: "slack", target: "C123" }), undefined);
  });
});
