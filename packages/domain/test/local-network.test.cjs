const assert = require("node:assert/strict");
const net = require("node:net");
const { describe, it } = require("node:test");
const {
  LOCAL_NETWORK_BLOCKED_HINT,
  LOCAL_PROXY_HINT,
  classifyLocalNetwork,
  hostPortFromHttpUrl,
  probeTcp,
  readProxyEnv,
  targetUrlFromError,
  watchLocalFetchFailure,
} = require("../dist");

describe("local network watch", () => {
  it("reads a proxy env and redacts credentials", () => {
    assert.deepEqual(
      readProxyEnv({
        HTTP_PROXY: "http://user:secret@127.0.0.1:7890",
        NO_PROXY: "localhost,127.0.0.1",
      }),
      {
        proxy: "HTTP_PROXY=http://...:...@127.0.0.1:7890/",
        loopback_bypassed: true,
      },
    );
  });

  it("classifies a listening port plus failed fetch as proxy intercept", () => {
    assert.deepEqual(
      classifyLocalNetwork({
        proxy: null,
        loopback_bypassed: false,
        tcp: "ok",
        fetch: "failed",
      }),
      {
        kind: "proxy",
        proxy: null,
        hint: LOCAL_PROXY_HINT,
      },
    );
  });

  it("does not call a refused loopback a network fault", () => {
    assert.deepEqual(
      classifyLocalNetwork({
        proxy: null,
        loopback_bypassed: false,
        tcp: "refused",
        fetch: "failed",
      }),
      { kind: "ok", proxy: null, hint: null },
    );
  });

  it("uses the proxy hint when HTTP_PROXY is set and loopback is not bypassed", () => {
    assert.equal(
      classifyLocalNetwork({
        proxy: "HTTP_PROXY=http://127.0.0.1:7890",
        loopback_bypassed: false,
        tcp: "refused",
        fetch: "failed",
      }).kind,
      "proxy",
    );
    assert.equal(
      classifyLocalNetwork({
        proxy: "HTTP_PROXY=http://127.0.0.1:7890",
        loopback_bypassed: true,
        tcp: "refused",
        fetch: "failed",
      }).kind,
      "ok",
    );
  });

  it("parses the loopback URL out of a connector fetch error", () => {
    assert.equal(
      targetUrlFromError(
        new Error(
          "Cannot reach DSH web at http://127.0.0.1:3080 (is `dsh web` running?): fetch failed",
        ),
      ),
      "http://127.0.0.1:3080",
    );
    assert.equal(
      targetUrlFromError(
        new Error("Cannot reach service at http://127.0.0.1:3080: fetch failed"),
      ),
      "http://127.0.0.1:3080",
    );
    assert.deepEqual(hostPortFromHttpUrl("http://127.0.0.1:3080"), {
      host: "127.0.0.1",
      port: 3080,
    });
  });

  it("watches a fetch failure with a TCP connect that still works", async () => {
    const watch = await watchLocalFetchFailure({
      error: new Error("Cannot reach service at http://127.0.0.1:3080: fetch failed"),
      async connect(target) {
        assert.deepEqual(target, { host: "127.0.0.1", port: 3080 });
        return "ok";
      },
    });
    assert.equal(watch.kind, "proxy");
    assert.equal(watch.hint, LOCAL_PROXY_HINT);
  });

  it("watches a blocked TCP path as a network block", async () => {
    const watch = await watchLocalFetchFailure({
      error: new Error("fetch failed"),
      url: "http://127.0.0.1:3080",
      async connect() {
        return "blocked";
      },
    });
    assert.equal(watch.kind, "blocked");
    assert.equal(watch.hint, LOCAL_NETWORK_BLOCKED_HINT);
  });

  it("probes TCP without going through HTTP", async () => {
    const server = net.createServer();
    await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    assert.equal(await probeTcp({ host: "127.0.0.1", port: address.port }), "ok");
    await new Promise((resolve) => {
      server.close(resolve);
    });
    assert.equal(
      await probeTcp({ host: "127.0.0.1", port: address.port }),
      "refused",
    );
  });
});
