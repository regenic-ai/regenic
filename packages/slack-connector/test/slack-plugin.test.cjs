const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryConnectorRegistry, verifyChannelDriverConformance } = require("@regenic/domain");
const { createHost, definePlugin } = require("@regenic/plugin-host");
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
    assert.equal(registry.getStream("slack-1")?.stream_key, "channel:C123");
    assert.equal(registry.getStream("slack-1")?.thread_id, "slack:C123");
    await slack.dispose();
    assert.equal(registry.get("slack-1"), undefined);
    await host.dispose();
  });

  it("mounts the channel through the host connector registry", async () => {
    const host = await createHost();
    const registry = new MemoryConnectorRegistry();
    await host.plugin(definePlugin({
      name: "connectors",
      apply(ctx) {
        ctx.provide("connectors", registry);
      },
    }));
    const installation = {
      id: "slack-1",
      org_id: "local-owner",
      connector_type: "slack-channel",
      status: "enabled",
      config: { channel_id: "C123", channel_name: "eng" },
      created_at: "2026-08-21T00:00:00.000Z",
    };
    const streams = await slackChannelDriver.resolveStreams(installation, host, {
      REGENIC_SLACK_TOKEN: "xoxb-test",
    });
    assert.equal(streams.length, 1);
    assert.equal(streams[0].thread_id, "slack:C123");
    assert.equal(registry.getStream("slack-1", "channel:C123")?.label, "eng");
    const again = await slackChannelDriver.resolveStreams(installation, host, {
      REGENIC_SLACK_TOKEN: "xoxb-test",
    });
    assert.equal(again.length, 1);
    assert.equal(registry.listStreams("slack-1").length, 1);
    await host.dispose();
  });

  it("exposes the configured channel as a complete sync directory", async () => {
    const source = await slackChannelDriver.bindSyncSource({
      id: "slack-1",
      org_id: "local-owner",
      connector_type: "slack-channel",
      status: "enabled",
      config: { channel_id: "C123", channel_name: "eng" },
      created_at: "2026-08-21T00:00:00.000Z",
    });
    const page = await source.listDirectory(null);
    assert.deepEqual(page, {
      members: [
        {
          stream_key: "channel:C123",
          thread_id: "slack:C123",
          label: "eng",
          kind: "channel",
        },
      ],
      complete: true,
    });
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
    assert.equal(slackChannelDriver.createThread, undefined);
    assert.equal(slackChannelDriver.bindEgress, undefined);
    assert.equal(slackChannelDriver.connector_protocol, "1.0");
    assert.equal(
      slackChannelDriver.install({
        id: "slack-1",
        org_id: "local-owner",
        config: { channel_id: "C123" },
        now: "2026-08-21T00:00:00.000Z",
      }).credentials_ref,
      "env:REGENIC_SLACK_TOKEN",
    );
    verifyChannelDriverConformance({
      driver: slackChannelDriver,
      enabled: installation,
    });
  });

  it("advertises Slack setup steps on the Engine catalog", () => {
    const catalog = slackChannelDriver.installCatalog();
    assert.equal(catalog.setup_steps[0].href, "https://api.slack.com/apps");
    assert.equal(catalog.setup_steps.length, 3);
  });
});
