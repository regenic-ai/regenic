const assert = require("node:assert/strict");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const {
  isAllowedPersonalCorsOrigin,
  isPersonalApiEnabled,
} = require("@regenic/config");
const {
  createRoot,
  PERSONAL_API_KEY,
  startPersonalApi,
} = require("./personal-api-harness.cjs");

describe("personal CORS origins", () => {
  it("does not grant WhatsApp Web CORS access to the personal inbox", async () => {
    const root = await createRoot();
    const database = join(root, "authority.db");
    const blobRoot = join(root, "blobs");
    const { app, origin } = await startPersonalApi(database, blobRoot);
    try {
      const denied = await fetch(`${origin}/v1/me/inbox`, {
        headers: { origin: "https://web.whatsapp.com" },
      });
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get("access-control-allow-origin"), null);

      const loopbackWithoutKey = await fetch(`${origin}/v1/me/inbox`, {
        headers: { origin: "http://127.0.0.1:5173" },
      });
      assert.equal(loopbackWithoutKey.status, 401);
      assert.equal(
        loopbackWithoutKey.headers.get("access-control-allow-origin"),
        "http://127.0.0.1:5173",
      );

      const loopback = await fetch(`${origin}/v1/me/inbox`, {
        headers: {
          origin: "http://127.0.0.1:5173",
          "x-regenic-personal-key": PERSONAL_API_KEY,
        },
      });
      assert.equal(loopback.status, 200);
      assert.equal(loopback.headers.get("access-control-allow-origin"), "http://127.0.0.1:5173");

      const extension = await fetch(`${origin}/v1/me/inbox`, {
        headers: {
          origin: "chrome-extension://abcdefghijklmnop",
          "x-regenic-personal-key": PERSONAL_API_KEY,
        },
      });
      assert.equal(extension.status, 200);
      assert.equal(
        extension.headers.get("access-control-allow-origin"),
        "chrome-extension://abcdefghijklmnop",
      );

      const opaqueWithoutKey = await fetch(`${origin}/v1/me/inbox`, {
        headers: { origin: "null" },
      });
      assert.equal(opaqueWithoutKey.status, 401);

      const opaque = await fetch(`${origin}/v1/me/inbox`, {
        headers: {
          origin: "null",
          "x-regenic-personal-key": PERSONAL_API_KEY,
        },
      });
      assert.equal(opaque.status, 200);
      assert.equal(opaque.headers.get("access-control-allow-origin"), "null");

      const preflight = await fetch(`${origin}/v1/me/context/ask`, {
        method: "OPTIONS",
        headers: {
          origin: "null",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,x-regenic-personal-key",
        },
      });
      assert.ok(preflight.status === 200 || preflight.status === 204);
      assert.match(
        preflight.headers.get("access-control-allow-headers") ?? "",
        /x-regenic-personal-key/i,
      );

      const extensionPreflight = await fetch(`${origin}/v1/me/engine`, {
        method: "OPTIONS",
        headers: {
          origin: "chrome-extension://abcdefghijklmnop",
          "access-control-request-method": "GET",
          "access-control-request-headers": "x-regenic-live-key",
        },
      });
      assert.ok(
        extensionPreflight.status === 200 || extensionPreflight.status === 204,
      );
      assert.match(
        extensionPreflight.headers.get("access-control-allow-headers") ?? "",
        /x-regenic-live-key/i,
      );
    } finally {
      await app.close();
    }
  });

  it("allows file, null, and loopback, and rejects public sites", () => {
    assert.equal(isAllowedPersonalCorsOrigin("null"), true);
    assert.equal(isAllowedPersonalCorsOrigin("file:///Users/local/index.html"), true);
    assert.equal(isAllowedPersonalCorsOrigin("http://localhost:5173"), true);
    assert.equal(isAllowedPersonalCorsOrigin("http://127.0.0.1:4370"), true);
    assert.equal(isAllowedPersonalCorsOrigin("chrome-extension://abcdefghijklmnop"), true);
    assert.equal(isAllowedPersonalCorsOrigin("https://web.whatsapp.com"), false);
    assert.equal(isAllowedPersonalCorsOrigin("https://example.com"), false);
    assert.equal(isAllowedPersonalCorsOrigin("http://127.0.0.1.evil.com"), false);
    assert.equal(isAllowedPersonalCorsOrigin("http://user@127.0.0.1"), false);
    assert.equal(isPersonalApiEnabled({ LISTEN_HOST: "127.0.0.1" }), true);
    assert.equal(isPersonalApiEnabled({ LISTEN_HOST: "::1" }), true);
    assert.equal(isPersonalApiEnabled({ LISTEN_HOST: "localhost" }), false);
    assert.equal(isPersonalApiEnabled({ LISTEN_HOST: "0.0.0.0" }), false);
    assert.equal(
      isPersonalApiEnabled({ LISTEN_HOST: "0.0.0.0", REGENIC_PERSONAL_API: "1" }),
      true,
    );
  });
});
