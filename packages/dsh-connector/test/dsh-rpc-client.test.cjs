const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { DshApiError, DshWebRpcClient } = require("../dist");

describe("DshWebRpcClient", () => {
  it("uses a cached cookie for HTTP RPC and a fresh cookie per Mux socket", async () => {
    const calls = [];
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:3080",
      access_token: "launch-token",
      createId: () => "rpc-1",
      async fetch(url, init) {
        calls.push({ url: String(url), init });
        if (String(url).includes("/connect?")) {
          const peer = calls.filter((call) => call.url.includes("/connect?")).length;
          return {
            ok: false,
            status: 302,
            headers: new Headers({
              location: "./api/remote.mux",
              "set-cookie": `dsh-auth-test=peer-${peer}; Path=/; HttpOnly`,
            }),
            async json() {
              return {};
            },
          };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              type: "server-response",
              rpcId: "rpc-1",
              result: { ok: true, value: { items: [], hasMore: false } },
            };
          },
        };
      },
    });

    await client.sessionList();
    const mux = await client.muxConnection();
    const secondMux = await client.muxConnection();
    await client.sessionList();

    assert.equal(calls.length, 5);
    assert.equal(new URL(calls[0].url).pathname, "/connect");
    assert.equal(new URL(calls[0].url).searchParams.get("interactions"), "none");
    assert.equal(calls[0].init.redirect, "manual");
    assert.equal(calls[0].init.headers.authorization, undefined);
    assert.equal(calls[1].url, "http://127.0.0.1:3080/api/session/list");
    assert.deepEqual(JSON.parse(calls[1].init.body).payload, { args: { _request: {} } });
    assert.equal(calls[1].init.headers.cookie, "dsh-auth-test=peer-1");
    assert.equal(calls[1].init.headers.authorization, undefined);
    assert.equal(mux.url, "ws://127.0.0.1:3080/api/remote.mux");
    assert.equal(mux.cookie, "dsh-auth-test=peer-2");
    assert.equal(secondMux.cookie, "dsh-auth-test=peer-3");
    assert.equal(calls[4].url, "http://127.0.0.1:3080/api/session/list");
    assert.equal(calls[4].init.headers.cookie, "dsh-auth-test=peer-1");
  });

  it("shares one HTTP peer across clients of the same DSH and token", async () => {
    let connects = 0;
    const fetch = async (url) => {
      if (String(url).includes("/connect?")) {
        connects += 1;
        return {
          ok: false,
          status: 302,
          headers: new Headers({
            location: "./api/remote.mux",
            "set-cookie": `dsh-auth-test=peer-${connects}; Path=/`,
          }),
          async json() {
            return {};
          },
        };
      }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            type: "server-response",
            rpcId: "rpc-1",
            result: { ok: true, value: { items: [], hasMore: false } },
          };
        },
      };
    };
    const client = (token) =>
      new DshWebRpcClient({
        base_url: "http://127.0.0.1:3081",
        access_token: token,
        createId: () => "rpc-1",
        fetch,
      });

    await Promise.all([client("t1").sessionList(), client("t1").sessionList()]);
    await client("t1").sessionList();
    assert.equal(connects, 1);
    await client("t2").sessionList();
    assert.equal(connects, 2);
  });

  it("renews an expired API cookie once after an unauthorized RPC", async () => {
    let exchanges = 0;
    const requestCookies = [];
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:3080",
      access_token: "launch-token",
      createId: () => "rpc-1",
      async fetch(url, init) {
        if (String(url).includes("/connect?")) {
          exchanges += 1;
          return {
            ok: false,
            status: 302,
            headers: new Headers({
              location: "./api/remote.mux",
              "set-cookie": `dsh-auth-test=api-cookie-${exchanges}; Path=/`,
            }),
            async json() {
              return {};
            },
          };
        }
        requestCookies.push(init.headers.cookie);
        if (requestCookies.length === 1) {
          return { ok: false, status: 401, async json() { return {}; } };
        }
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              type: "server-response",
              rpcId: "rpc-1",
              result: { ok: true, value: { items: [], hasMore: false } },
            };
          },
        };
      },
    });

    await client.sessionList();

    assert.equal(exchanges, 2);
    assert.deepEqual(requestCookies, [
      "dsh-auth-test=api-cookie-1",
      "dsh-auth-test=api-cookie-2",
    ]);
  });

  it("reads the newest history window from the session/follow snapshot", async () => {
    const sent = [];
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:8080/",
      access_token: "launch-token",
      createId: () => "stream-1",
      async fetch() {
        return connectResponse();
      },
      async openSocket(input) {
        assert.equal(input.url, "ws://127.0.0.1:8080/api/remote.mux");
        assert.equal(input.cookie, "dsh-auth-test=api-cookie");
        return {
          send(data) {
            const frame = JSON.parse(data);
            sent.push(frame);
            if (frame.type === "open") {
              input.onMessage(JSON.stringify({
                type: "item",
                streamId: frame.streamId,
                value: {
                  type: "snapshot",
                  cursor: 7,
                  hasMore: true,
                  records: [{
                    type: "event",
                    event: {
                      type: "user/message",
                      seq: 2,
                      time: 1,
                      data: { content: [{ type: "text", text: "Hello" }] },
                    },
                  }],
                },
              }));
            }
          },
          close() {},
        };
      },
    });

    const page = await client.sessionHistory({ sessionId: "sess-1", maxMessages: 20 });
    assert.deepEqual(sent[0], {
      type: "open",
      streamId: "stream-1",
      endpoint: "session/follow",
      payload: {
        args: {
          request: { address: { kind: "session", sessionId: "sess-1" }, maxMessages: 20 },
        },
      },
    });
    assert.deepEqual(sent[1], { type: "cancel", streamId: "stream-1" });
    assert.equal(page.hasMore, true);
    assert.equal(page.events[0].seq, 2);
    assert.equal(page.events[0].type, "user/message");
  });

  it("pages older history through session/page bounded by the snapshot cursor", async () => {
    const calls = [];
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:3080",
      access_token: "launch-token",
      createId: () => "rpc-1",
      async fetch(url, init) {
        if (String(url).includes("/connect?")) {
          return connectResponse();
        }
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return rpcResponse({
          hasMore: false,
          records: [{ type: "session/title", seq: 0, time: 1, data: { title: "pong" } }],
        });
      },
      async openSocket(input) {
        return {
          send(data) {
            const frame = JSON.parse(data);
            if (frame.type === "open") {
              input.onMessage(JSON.stringify({
                type: "item",
                streamId: frame.streamId,
                value: { type: "snapshot", cursor: 9, hasMore: true, records: [] },
              }));
            }
          },
          close() {},
        };
      },
    });

    const page = await client.sessionHistory({ sessionId: "sess-1", beforeSeq: 5, maxMessages: 10 });
    assert.equal(calls[0].url, "http://127.0.0.1:3080/api/session/page");
    assert.deepEqual(calls[0].body.payload.args, {
      request: {
        address: { kind: "session", sessionId: "sess-1" },
        throughSeq: 9,
        beforeSeq: 5,
        maxMessages: 10,
      },
    });
    assert.equal(page.events[0].type, "session/title");
  });

  it("surfaces a session/follow stream error as DshApiError", async () => {
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:3080",
      access_token: "launch-token",
      createId: () => "stream-1",
      async fetch() {
        return connectResponse();
      },
      async openSocket(input) {
        return {
          send(data) {
            const frame = JSON.parse(data);
            if (frame.type === "open") {
              input.onMessage(JSON.stringify({
                type: "error",
                streamId: frame.streamId,
                error: { code: "session-not-found", message: "missing" },
              }));
            }
          },
          close() {},
        };
      },
    });
    await assert.rejects(
      () => client.sessionHistory({ sessionId: "sess-1" }),
      (error) => error instanceof DshApiError && error.code === "session-not-found",
    );
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

  it("explains how to resolve an unauthorized DSH web response", async () => {
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:3080",
      async fetch() {
        return {
          ok: false,
          status: 401,
          async json() {
            return {};
          },
        };
      },
    });
    await assert.rejects(
      () => client.sessionList(),
      (error) => {
        assert.equal(error.name, "DshApiError");
        assert.match(error.message, /authentication failed \(HTTP 401\)/);
        assert.match(error.message, /DSH web token field/);
        assert.match(error.message, /REGENIC_DSH_TOKEN/);
        return true;
      },
    );
  });

  it("explains when DSH rejects a configured token", async () => {
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:3080",
      access_token: "do-not-include-in-errors",
      async fetch() {
        return {
          ok: false,
          status: 401,
          async json() {
            return {};
          },
        };
      },
    });
    await assert.rejects(
      () => client.sessionList(),
      (error) => {
        assert.equal(error.name, "DshApiError");
        assert.match(error.message, /rejected the configured token/);
        assert.match(error.message, /current token printed by the running dsh web server/);
        assert.equal(error.message.includes("do-not-include-in-errors"), false);
        return true;
      },
    );
  });

  it("sends a strict session/prompt request with wire image parts", async () => {
    const calls = [];
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:3080",
      createId: () => "rpc-1",
      async fetch(url, init) {
        calls.push({ url, body: JSON.parse(init.body) });
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              type: "server-response",
              rpcId: "rpc-1",
              result: { ok: true, value: {} },
            };
          },
        };
      },
    });

    await client.sessionPrompt({
      sessionId: "sess-1",
      text: "Look at this",
      content: [
        { type: "text", text: "Look at this" },
        {
          type: "image",
          mimeType: "image/png",
          mediaType: "image/png",
          data: "aa",
          name: "shot.png",
        },
      ],
    });

    assert.equal(calls[0].url, "http://127.0.0.1:3080/api/session/prompt");
    assert.equal(calls[0].body.method, "session/prompt");
    assert.deepEqual(calls[0].body.payload.args.request, {
      requestId: "rpc-1",
      sessionId: "sess-1",
      mode: "queue",
      content: [
        { type: "text", text: "Look at this" },
        { type: "image", mediaType: "image/png", data: "aa", name: "shot.png" },
      ],
    });
  });

  it("creates a session with an empty payload", async () => {
    const calls = [];
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:3080",
      createId: () => "rpc-1",
      async fetch(url, init) {
        calls.push({ url, body: JSON.parse(init.body) });
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              type: "server-response",
              rpcId: "rpc-1",
              result: { ok: true, value: { sessionId: "sess-new" } },
            };
          },
        };
      },
    });

    const created = await client.sessionCreate();
    assert.equal(created.sessionId, "sess-new");
    assert.equal(calls[0].url, "http://127.0.0.1:3080/api/session/create");
    assert.equal(calls[0].body.method, "session/create");
    assert.deepEqual(calls[0].body.payload, { args: { request: {} } });
  });

  it("lists non-blank session ids from session/list pages", async () => {
    const calls = [];
    const client = new DshWebRpcClient({
      base_url: "http://127.0.0.1:3080",
      createId: () => `rpc-${calls.length + 1}`,
      async fetch(url, init) {
        calls.push({ url, body: JSON.parse(init.body) });
        const cursor = calls[calls.length - 1].body.payload.args._request.cursor;
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
                      items: [
                        { sessionId: "sess-1", blank: false },
                        { sessionId: "sess-blank", blank: true },
                      ],
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
    assert.equal(calls[0].url, "http://127.0.0.1:3080/api/session/list");
    assert.equal(calls[0].body.method, "session/list");
    assert.equal(calls[1].body.payload.args._request.cursor, "page-2");
  });
});

function connectResponse() {
  return {
    ok: false,
    status: 302,
    headers: new Headers({
      location: "./api/remote.mux",
      "set-cookie": "dsh-auth-test=api-cookie; Path=/; HttpOnly",
    }),
    async json() {
      return {};
    },
  };
}

function rpcResponse(value) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { type: "server-response", rpcId: "rpc-1", result: { ok: true, value } };
    },
  };
}
