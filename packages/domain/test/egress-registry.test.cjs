const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryEgressRegistry } = require("../dist");

describe("MemoryEgressRegistry", () => {
  it("registers an adapter and unregisters through the disposer", () => {
    const registry = new MemoryEgressRegistry();
    const dispose = registry.register("dsh-1", {
      source: "dsh",
      capabilities() {
        return { reply: true, edit: false, tombstone: false };
      },
      async send() {
        return { accepted: true };
      },
    });

    assert.equal(registry.get("dsh-1")?.source, "dsh");
    dispose();
    assert.equal(registry.get("dsh-1"), undefined);
  });

  it("rejects a second adapter for the same installation", () => {
    const registry = new MemoryEgressRegistry();
    const adapter = {
      source: "dsh",
      capabilities() {
        return { reply: true, edit: false, tombstone: false };
      },
      async send() {
        return { accepted: true };
      },
    };
    registry.register("dsh-1", adapter);
    assert.throws(
      () => registry.register("dsh-1", adapter),
      /Egress adapter already registered: dsh-1/,
    );
  });

  it("unregisters one stream adapter", () => {
    const registry = new MemoryEgressRegistry();
    const adapter = {
      source: "feishu",
      capabilities() {
        return { reply: true, edit: false, tombstone: false };
      },
      async send() {
        return { accepted: true };
      },
    };
    registry.register("feishu-1", adapter, "chat:oc_1");
    registry.register("feishu-1", { ...adapter }, "chat:oc_2");
    assert.equal(registry.unregister("feishu-1", "chat:oc_1"), true);
    assert.equal(registry.get("feishu-1", "chat:oc_1"), undefined);
    assert.equal(registry.get("feishu-1", "chat:oc_2")?.source, "feishu");
  });
});
