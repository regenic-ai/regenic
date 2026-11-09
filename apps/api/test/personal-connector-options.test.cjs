const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { connectorOptionsPage } = require("../dist/personal-connector-options");

describe("connector option pages", () => {
  function driver(extra = {}) {
    return {
      connector_type: "example",
      installCatalog: () => ({
        fields: [
          { key: "credential", secret: true },
          { key: "kinds", type: "string_array" },
          { key: "ids", dynamic_options: true, options_depends_on: ["kinds"], filter_options_by: "kinds" },
        ],
      }),
      listCatalogFieldOptions: async () => ({
        ids: [
          { value: "a", label: "Alpha", kind: "group" },
          { value: "b", label: "Beta", kind: "group" },
          { value: "c", label: "Other", kind: "p2p" },
        ],
      }),
      ...extra,
    };
  }
  it("filters dependency values, searches and paginates legacy option loaders", async () => {
    const first = await connectorOptionsPage(driver(), {
      field: "ids", values: { kinds: ["group"] }, limit: 1,
    }, "en");
    assert.deepEqual(first, { options: [{ value: "a", label: "Alpha", kind: "group" }], next_cursor: "1" });
    const second = await connectorOptionsPage(driver(), {
      field: "ids", values: { kinds: ["group"] }, cursor: "1", limit: 1,
    }, "en");
    assert.deepEqual(second.options.map((item) => item.value), ["b"]);
    assert.equal(second.next_cursor, undefined);
    const search = await connectorOptionsPage(driver(), { field: "ids", query: "beta" }, "en");
    assert.deepEqual(search.options.map((item) => item.value), ["b"]);
  });
  it("passes only declared non-secret dependencies to a native backend pager", async () => {
    let received;
    const result = await connectorOptionsPage(driver({
      listCatalogFieldOptionsPage: async (request) => {
        received = request;
        return { options: [{ value: "one", label: "One" }], next_cursor: "opaque" };
      },
    }), { field: "ids", values: { kinds: ["group"], credential: "private", unknown: "ignored" } }, "en");
    assert.deepEqual(received.values, { kinds: ["group"] });
    assert.equal(result.next_cursor, "opaque");
  });
  it("rejects secret targets, malformed pagination and secret dependencies", async () => {
    for (const input of [
      { field: "credential" }, { field: "ids", limit: 101 },
      { field: "ids", cursor: "-1" }, { field: "ids", query: "x".repeat(201) },
    ]) await assert.rejects(connectorOptionsPage(driver(), input, "en"), { code: "invalid_config" });
    await assert.rejects(connectorOptionsPage(driver({
      installCatalog: () => ({ fields: [
        { key: "credential", secret: true },
        { key: "ids", options_depends_on: ["credential"] },
      ] }),
    }), { field: "ids" }, "en"), { code: "invalid_config" });
  });
  it("surfaces failures instead of producing empty successful pages", async () => {
    await assert.rejects(connectorOptionsPage(driver({
      listCatalogFieldOptions: async () => { throw new Error("Offline"); },
    }), { field: "ids" }, "en"), { code: "catalog_options_failed", httpStatus: 502 });
  });
});
