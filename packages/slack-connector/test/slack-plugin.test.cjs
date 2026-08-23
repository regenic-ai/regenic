const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryConnectorRegistry } = require("@regenic/domain");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const { ChannelDriverError } = require("@regenic/domain");
const { slackChannelPlugin } = require("../dist/plugin");
const { slackChannelDriver } = require("../dist/slack-channel-driver");

describe("slackChannelPlugin", () => {
  it("registers on connectors and unregisters when disposed", async () => {
    const host = await createHost();
    const registry = new MemoryConnectorRegistry();
    await host.plugin(definePlugin({
      name: "connectors",
      apply(ctx) {
        ctx.provide("connectors", registry);
      },
    }));

    const slack = await host.plugin(slackChannelPlugin, {
      installation_id: "slack-1",
      org_id: "local-owner",
      channel_id: "C123",
      access_token: "runtime-only-token",
    });

    assert.equal(registry.get("slack-1")?.source, "slack");
    await slack.dispose();
    assert.equal(registry.get("slack-1"), undefined);
    await host.dispose();
  });

  it("is sync-only and cannot create a conversation", async () => {
    const installation = {
      id: "slack-1",
      org_id: "local-owner",
      connector_type: "slack-channel",
      status: "enabled",
      config: { channel_id: "C123" },
      created_at: "2026-08-21T00:00:00.000Z",
    };
    assert.deepEqual(slackChannelDriver.capabilities(installation), {
      sync: true,
      reply: false,
      create: false,
      list_title: "conversation",
    });
    await assert.rejects(
      () => slackChannelDriver.createThread(installation, {}, process.env),
      (error) => error instanceof ChannelDriverError && error.code === "unsupported_channel",
    );
  });
});
