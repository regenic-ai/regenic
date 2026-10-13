const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryConnectorRegistry, MemoryEgressRegistry } = require("../dist");

describe("connector test utils", () => {
  it("registers a connector and an egress adapter without the kernel", () => {
    const connectors = new MemoryConnectorRegistry();
    const egress = new MemoryEgressRegistry();
    const connector = { source: "example" };
    const adapter = { send: async () => ({ accepted: true }) };
    connectors.register("install-1", connector, { stream_key: "chat:1", label: "Ada" });
    egress.register("install-1", adapter, "chat:1");
    assert.equal(connectors.get("install-1", "chat:1"), connector);
    assert.equal(connectors.getStream("install-1", "chat:1").label, "Ada");
    assert.equal(egress.get("install-1", "chat:1"), adapter);
  });
});
