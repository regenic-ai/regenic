const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  parseServerAppConnectionResponse,
  parseServerAppManifest,
} = require("../dist/index.js");

test("parses a source and Agent server manifest", () => {
  const manifest = parseServerAppManifest({
    protocol: "1.0",
    app_id: "acme.support",
    name: "Acme Support",
    capabilities: {
      source: { push: true, pull: true, reply: true, create: false },
      agent: true,
    },
  });
  assert.equal(manifest.endpoints.connect, "/v1/regenic/connections");
  assert.equal(manifest.endpoints.invoke, "/v1/regenic/invoke");
  assert.equal(manifest.endpoints.runs, "/v1/runs");
});

test("rejects an empty server capability declaration", () => {
  assert.throws(() =>
    parseServerAppManifest({
      protocol: "1.0",
      app_id: "empty",
      name: "Empty",
      capabilities: { source: {} },
    }),
  );
});

test("validates connection responses", () => {
  assert.deepEqual(
    parseServerAppConnectionResponse({
      protocol: "1.0",
      connection_id: "connection-1",
    }),
    { protocol: "1.0", connection_id: "connection-1" },
  );
});
