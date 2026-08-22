const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { ChannelDriverError, MemoryConnectorRegistry, MemoryEgressRegistry } = require("@regenic/domain");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const { feishuChatDriver } = require("../dist/feishu-chat-driver");
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
    assert.equal(egress.get("feishu-1")?.source, "feishu");
    await mounted.dispose();
    assert.equal(connectors.get("feishu-1"), undefined);
    assert.equal(egress.get("feishu-1"), undefined);
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

  it("installs a chat and can reply after enable", () => {
    const created = feishuChatDriver.install({
      id: "feishu-1",
      org_id: "local-owner",
      config: { chat_id: "oc_1", chat_name: "engineering" },
      now: "2026-08-22T00:00:00.000Z",
    });
    assert.equal(created.connector_type, "feishu-chat");
    assert.equal(created.credentials_ref, undefined);
    assert.deepEqual(created.config, { chat_id: "oc_1", chat_name: "engineering" });
    assert.deepEqual(feishuChatDriver.capabilities(installation), {
      sync: true,
      reply: true,
      create: false,
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

  it("requires chat_id and cannot create a conversation", async () => {
    assert.throws(
      () =>
        feishuChatDriver.install({
          id: "feishu-1",
          org_id: "local-owner",
          config: {},
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
