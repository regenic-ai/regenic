const assert = require("node:assert/strict");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { ChannelDriverRegistry } = require("@regenic/domain");
const { createRoot, startPersonalApi } = require("./personal-api-harness.cjs");

describe("connector form HTTP boundary", { concurrency: 1 }, () => {
  it("passes scoped option dependencies and rejects bad input without invoking the connector", async () => {
    const root = await createRoot();
    const { app, origin } = await startPersonalApi(join(root, "authority.db"), join(root, "blobs"));
    const calls = [];
    app.get(ChannelDriverRegistry).register({
      connector_type: "form-fixture", source: "form-fixture",
      capabilities: () => ({ sync: false, reply: false, create: false }),
      installCatalog: () => ({
        title: "Fixture", description: "Fixture", credential_hint: "Fixture", form_version: 2,
        fields: [
          { key: "token", label: "Token", type: "string", secret: true },
          { key: "kinds", label: "Kinds", type: "string_array" },
          { key: "ids", label: "IDs", type: "string_array", dynamic_options: true, options_depends_on: ["kinds"] },
        ],
      }),
      async listCatalogFieldOptionsPage(request) {
        calls.push(request);
        return { options: [{ value: "one", label: "One" }], next_cursor: request.cursor ? undefined : "next" };
      },
    });
    const request = (body) => fetch(`${origin}/v1/me/engine/catalog-options`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    try {
      const first = await request({
        connector_type: "form-fixture", field: "ids", query: "on",
        values: { kinds: ["group"], token: "private" },
      });
      assert.equal(first.status, 201);
      assert.deepEqual(await first.json(), { options: [{ value: "one", label: "One" }], next_cursor: "next" });
      assert.deepEqual(calls[0].values, { kinds: ["group"] });
      const second = await request({ connector_type: "form-fixture", field: "ids", cursor: "next" });
      assert.equal(second.status, 201);
      assert.equal((await second.json()).next_cursor, undefined);
      const bad = await request({ connector_type: "form-fixture", field: "token" });
      assert.equal(bad.status, 400);
      assert.equal(calls.length, 2);
    } finally { await app.close(); }
  });
});
