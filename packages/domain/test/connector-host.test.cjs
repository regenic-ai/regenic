const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { asConnectorHost } = require("../dist/connector-host");

function fakeHost(services) {
  return {
    get(name) {
      if (!(name in services)) {
        throw new Error(`Service is not available: ${name}`);
      }
      return services[name];
    },
    async plugin() {
      return { ready: async () => undefined, dispose: async () => undefined };
    },
  };
}

describe("asConnectorHost", () => {
  it("exposes connectors and egress and hides authority", () => {
    const host = asConnectorHost(
      fakeHost({
        connectors: { kind: "connectors" },
        egress: { kind: "egress" },
        authority: { kind: "authority" },
      }),
    );
    assert.equal(host.get("connectors").kind, "connectors");
    assert.equal(host.get("egress").kind, "egress");
    assert.throws(() => host.get("authority"), /not available to drivers/);
    assert.match(host.now(), /T/);
  });

  it("wraps only once", () => {
    const first = asConnectorHost(fakeHost({ connectors: {}, egress: {} }));
    assert.equal(asConnectorHost(first), first);
  });

  it("narrows plugin apply so authority stays hidden", async () => {
    const { createHost } = require("@regenic/plugin-host");
    const kernel = await createHost();
    try {
      kernel.provide("connectors", { kind: "connectors" });
      kernel.provide("egress", { kind: "egress" });
      kernel.provide("authority", { kind: "authority" });
      const host = asConnectorHost(kernel);
      const seen = { connectors: "", authority: "" };
      await host.plugin({
        name: "probe-narrow",
        apply(ctx) {
          seen.connectors = ctx.get("connectors").kind;
          try {
            ctx.get("authority");
            seen.authority = "leaked";
          } catch {
            seen.authority = "blocked";
          }
        },
      });
      assert.equal(seen.connectors, "connectors");
      assert.equal(seen.authority, "blocked");
    } finally {
      await kernel.dispose();
    }
  });
});
