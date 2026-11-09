const assert = require("node:assert/strict");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { ChannelDriverRegistry, readInstallSecret } = require("@regenic/domain");
const { createRoot, startPersonalApi } = require("./personal-api-harness.cjs");

describe("connector form HTTP boundary", { concurrency: 1 }, () => {
  it("only executes credential clears validated for visible fields", async () => {
    const root = await createRoot();
    const { app, origin } = await startPersonalApi(join(root, "authority.db"), join(root, "blobs"));
    const clears = [];
    const installedConfigs = [];
    app.get(ChannelDriverRegistry).register({
      connector_type: "credential-fixture", source: "credential-fixture",
      capabilities: () => ({ sync: false, reply: false, create: false }),
      installCatalog: () => ({
        title: "Fixture", description: "Fixture", credential_hint: "Fixture", form_version: 2,
        fields: [
          { key: "mode", label: "Mode", type: "string", required: true,
            options: [{ value: "web", label: "Web" }, { value: "cli", label: "CLI" }] },
          { key: "token", label: "Token", type: "string", secret: true,
            visible_when: { field: "mode", value: "web" } },
          { key: "password", label: "Password", type: "string", widget: "password", required: true,
            visible_when: { field: "mode", value: "web" } },
        ],
      }),
      install(input) {
        installedConfigs.push(input.config);
        return {
          id: input.id, org_id: input.org_id, connector_type: "credential-fixture",
          status: "enabled", config: input.config, created_at: input.now,
        };
      },
      async clearCatalogCredential(_installation, field) { clears.push(field); },
    });
    const post = (path, body) => fetch(`${origin}/v1/me/${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    try {
      const created = await post("connectors", {
        connector_type: "credential-fixture",
        config: { mode: "web", token: "optional-secret", password: "required-secret" },
      });
      const installation = await created.json();
      assert.equal(created.status, 201, JSON.stringify(installation));
      const update = (config) => post(`connectors/${installation.id}/config`, { config });
      const hidden = await update({ mode: "cli", token: null, password: null });
      assert.equal(hidden.status, 201, JSON.stringify(await hidden.json()));
      assert.deepEqual(installedConfigs.at(-1), { mode: "cli" });
      assert.deepEqual(clears, [], "Hidden clear intents must not reach connector-owned storage");
      assert.equal(await readInstallSecret("credential-fixture", installation.id, "token"), "optional-secret");
      assert.equal(await readInstallSecret("credential-fixture", installation.id, "password"), "required-secret");
      const kept = await update({ mode: "web" });
      assert.equal(kept.status, 201, JSON.stringify(await kept.json()));
      const rejected = await update({ mode: "web", token: null, password: null });
      assert.equal(rejected.status, 400);
      assert.deepEqual(clears, []);
      assert.equal(await readInstallSecret("credential-fixture", installation.id, "token"), "optional-secret");
      const cleared = await update({ mode: "web", token: null });
      assert.equal(cleared.status, 201, JSON.stringify(await cleared.json()));
      assert.deepEqual(clears, ["token"]);
      assert.deepEqual(installedConfigs.at(-1), { mode: "web" }, "Driver input must not contain clear commands");
      assert.equal(await readInstallSecret("credential-fixture", installation.id, "token"), undefined);
      assert.equal(await readInstallSecret("credential-fixture", installation.id, "password"), "required-secret");
    } finally { await app.close(); }
  });

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
