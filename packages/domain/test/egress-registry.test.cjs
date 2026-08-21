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
});
