const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { CatalogProbeCache } = require("../dist/catalog-probe-cache");

describe("CatalogProbeCache", () => {
  it("does not wait for a live probe on peek", async () => {
    const cache = new CatalogProbeCache();
    let resolveProbe;
    const pending = new Promise((resolve) => {
      resolveProbe = resolve;
    });
    cache.schedule({
      probeCatalog: () => pending,
    });
    assert.deepEqual(cache.peek().services, {});
    resolveProbe({
      services: { "lark-cli": { ready: true } },
      field_options: {},
    });
    await pending;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    assert.equal(cache.peek().services["lark-cli"].ready, true);
  });
});
