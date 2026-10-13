const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  createHttpApp,
  listenHttpApp,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  HTTP_HEADERS_TIMEOUT_MS,
} = require("../dist/http-app");

describe("http keep-alive behind Envoy", () => {
  it("raises keepAliveTimeout past Node's 5s default", async () => {
    const app = await createHttpApp({ logger: false });
    await listenHttpApp(app, 0, "127.0.0.1");
    try {
      const server = app.getHttpServer();
      assert.equal(server.keepAliveTimeout, HTTP_KEEP_ALIVE_TIMEOUT_MS);
      assert.equal(server.headersTimeout, HTTP_HEADERS_TIMEOUT_MS);
      assert.ok(server.keepAliveTimeout > 5_000);
      assert.ok(server.headersTimeout > server.keepAliveTimeout);
    } finally {
      await app.close();
    }
  });
});
