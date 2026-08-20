const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createHost, definePlugin } = require("../dist/index");

describe("plugin-host", () => {
  it("provides a service and removes it when the plugin is disposed", async () => {
    const host = await createHost();
    let closed = false;
    await host.plugin(definePlugin({
      name: "demo",
      apply(ctx) {
        ctx.provide("demo", { id: "live" });
        ctx.effect(() => () => {
          closed = true;
        });
      },
    }));

    assert.deepEqual(host.get("demo"), { id: "live" });
    await host.dispose();
    assert.equal(closed, true);
    assert.throws(() => host.get("demo"), /Service is not available: demo/);
  });

  it("activates an injected plugin only after its service exists", async () => {
    const host = await createHost();
    let seen;
    const dependent = await host.plugin(definePlugin({
      name: "dependent",
      inject: ["source"],
      apply(ctx) {
        seen = ctx.get("source");
      },
    }));

    assert.equal(seen, undefined);
    await host.plugin(definePlugin({
      name: "source",
      apply(ctx) {
        ctx.provide("source", { ready: true });
      },
    }));
    await dependent.ready();

    assert.deepEqual(seen, { ready: true });
    await host.dispose();
  });

  it("removes event listeners when the owning plugin unloads", async () => {
    const host = await createHost();
    const seen = [];
    const listener = await host.plugin(definePlugin({
      name: "listener",
      apply(ctx) {
        ctx.on("ping", (value) => {
          seen.push(value);
        });
      },
    }));

    host.emit("ping", "before");
    await listener.dispose();
    host.emit("ping", "after");

    assert.deepEqual(seen, ["before"]);
    await host.dispose();
  });
});
