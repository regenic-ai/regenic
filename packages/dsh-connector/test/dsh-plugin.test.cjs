const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryConnectorRegistry, MemoryEgressRegistry } = require("@regenic/domain");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const { dshSessionPlugin, resolveDshTransport } = require("../dist/plugin");

describe("dshSessionPlugin", () => {
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

    const mounted = await host.plugin(dshSessionPlugin, {
      installation_id: "dsh-1",
      org_id: "local-owner",
      transport: "cli",
      mailbox: "dsh-main",
    });

    assert.equal(connectors.get("dsh-1")?.source, "dsh");
    assert.equal(egress.get("dsh-1")?.source, "dsh");
    await mounted.dispose();
    assert.equal(connectors.get("dsh-1"), undefined);
    assert.equal(egress.get("dsh-1"), undefined);
    await host.dispose();
  });

  it("resolves transport from the explicit field or from base_url", () => {
    assert.equal(resolveDshTransport({ transport: "web" }), "web");
    assert.equal(resolveDshTransport({ transport: "cli" }), "cli");
    assert.equal(resolveDshTransport({ base_url: "http://127.0.0.1:8080" }), "web");
    assert.equal(resolveDshTransport({ mailbox: "dsh-main" }), "cli");
  });
});
