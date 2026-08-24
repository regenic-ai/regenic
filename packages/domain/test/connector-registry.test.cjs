const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ChannelDriverError,
  MemoryConnectorRegistry,
  requireConnectorStream,
} = require("../dist");

function stubConnector(source = "feishu") {
  return {
    source,
    async poll() {
      throw new Error("not used");
    },
  };
}

describe("MemoryConnectorRegistry streams", () => {
  it("keeps get(installationId) for a single mounted stream", () => {
    const registry = new MemoryConnectorRegistry();
    registry.register("feishu-1", stubConnector(), {
      stream_key: "chat:oc_1",
      thread_id: "feishu:oc_1",
      label: "Ada",
    });
    assert.equal(registry.get("feishu-1")?.source, "feishu");
    assert.equal(registry.getStream("feishu-1")?.thread_id, "feishu:oc_1");
    assert.equal(registry.get("feishu-1", "chat:oc_1")?.source, "feishu");
  });

  it("lists many streams on one installation and requires a stream key", () => {
    const registry = new MemoryConnectorRegistry();
    registry.register("feishu-1", stubConnector(), {
      stream_key: "chat:oc_1",
      thread_id: "feishu:oc_1",
    });
    registry.register("feishu-1", stubConnector(), {
      stream_key: "chat:oc_2",
      thread_id: "feishu:oc_2",
    });
    assert.equal(registry.get("feishu-1"), undefined);
    assert.equal(registry.listStreams("feishu-1").length, 2);
    assert.equal(
      requireConnectorStream(registry, "feishu-1", "chat:oc_2").thread_id,
      "feishu:oc_2",
    );
    assert.throws(
      () => requireConnectorStream(registry, "feishu-1", "chat:missing"),
      (error) => error instanceof ChannelDriverError && error.code === "sync_failed",
    );
  });

  it("rejects a second connector for the same stream", () => {
    const registry = new MemoryConnectorRegistry();
    registry.register("slack-1", stubConnector("slack"));
    assert.throws(
      () => registry.register("slack-1", stubConnector("slack")),
      /Connector already registered: slack-1/,
    );
    registry.register("feishu-1", stubConnector(), { stream_key: "chat:oc_1" });
    assert.throws(
      () => registry.register("feishu-1", stubConnector(), { stream_key: "chat:oc_1" }),
      /Connector already registered: feishu-1:chat:oc_1/,
    );
  });
});
