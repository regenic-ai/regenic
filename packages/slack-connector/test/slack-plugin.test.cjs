const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryConnectorRegistry } = require("@regenic/domain");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const { slackChannelPlugin } = require("../dist/plugin");

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
});
