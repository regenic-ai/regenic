const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { DshApiError, DshWebRpcClient } = require("../dist");

describe("DshWebRpcClient", () => {
  it("posts the DSH web RPC envelope to session.history", async () => {
    const calls = [];
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:8080/",
      createId: () => "rpc-1",
      async fetch(url, init) {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              type: "server-response",
              rpcId: "rpc-1",
              result: {
                ok: true,
                value: {
                  hasMore: false,
                  events: [{
                    event: {
                      type: "user/message",
                      seq: 2,
                      time: 1,
                      data: { content: [{ type: "text", text: "Hello" }] },
                    },
                  }],
                },
              },
            };
          },
        };
      },
    });

    const page = await client.sessionHistory({ sessionId: "sess-1", maxMessages: 20 });
    assert.equal(calls[0].url, "http://127.0.0.1:8080/api/session.history");
    assert.equal(JSON.parse(calls[0].init.body).method, "session.history");
    assert.equal(page.events[0].seq, 2);
    assert.equal(page.events[0].type, "user/message");
  });

  it("accepts a bare SessionEvent when the host does not wrap it", async () => {
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:3080",
      createId: () => "rpc-1",
      async fetch() {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              type: "server-response",
              rpcId: "rpc-1",
              result: {
                ok: true,
                value: {
                  hasMore: false,
                  events: [{
                    type: "session/title",
                    seq: 0,
                    time: 1,
                    data: { title: "pong" },
                  }],
                },
              },
            };
          },
        };
      },
    });
    const page = await client.sessionHistory({ sessionId: "sess-1" });
    assert.equal(page.events[0].type, "session/title");
  });

  it("raises DshApiError when result.ok is false", async () => {
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:8080",
      createId: () => "rpc-1",
      async fetch() {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              type: "server-response",
              rpcId: "rpc-1",
              result: { ok: false, error: { code: "session-not-found", message: "missing" } },
            };
          },
        };
      },
    });
    await assert.rejects(() => client.sessionPrompt({ sessionId: "sess-1", text: "Hi" }), DshApiError);
  });

  it("explains a connection failure instead of a bare fetch failed", async () => {
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:8080",
      async fetch() {
        throw new TypeError("fetch failed");
      },
    });
    await assert.rejects(
      () => client.sessionPrompt({ sessionId: "sess-1", text: "Hi" }),
      (error) => {
        assert.equal(error.name, "DshApiError");
        assert.match(error.message, /Cannot reach DSH web/);
        assert.match(error.message, /dsh web/);
        return true;
      },
    );
  });

  it("lists session ids from session.list pages", async () => {
    const calls = [];
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:3080",
      createId: () => `rpc-${calls.length + 1}`,
      async fetch(url, init) {
        calls.push({ url, body: JSON.parse(init.body) });
        const cursor = calls[calls.length - 1].body.payload.cursor;
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              type: "server-response",
              rpcId: `rpc-${calls.length}`,
              result: {
                ok: true,
                value: cursor
                  ? { items: [{ id: "sess-2" }], hasMore: false }
                  : {
                      items: [{ sessionId: "sess-1" }],
                      nextCursor: "page-2",
                      hasMore: true,
                    },
              },
            };
          },
        };
      },
    });

    const ids = await client.listAllSessionIds();
    assert.deepEqual(ids, ["sess-1", "sess-2"]);
    assert.equal(calls[0].url, "http://127.0.0.1:3080/api/session.list");
    assert.equal(calls[0].body.method, "session.list");
    assert.equal(calls[1].body.payload.cursor, "page-2");
  });
});
