const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  MemoryAuthorityStore,
  MemoryBlobStore,
  MemoryConnectorRuntimeStore,
  ingestPlugin,
  setKeychainStoreForTests,
} = require("@regenic/domain");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const { DshApiError } = require("@regenic/dsh-connector");
const { createDshHostRpcServices } = require("../dist");

const HISTORY_EVENTS = [
  {
    type: "user/message",
    seq: 0,
    time: 1_724_208_000_000,
    data: { content: [{ type: "text", text: "Hello" }], source: { kind: "user" } },
  },
  {
    type: "assistant/message",
    seq: 1,
    time: 1_724_208_001_000,
    data: { message: { content: [{ type: "text", text: "Hi" }] } },
  },
];

describe("createDshHostRpcServices", () => {
  it("uses an installation token when listing DSH web sessions", async () => {
    setKeychainStoreForTests({
      async read(service, account) {
        assert.equal(service, "regenic-dsh-session");
        assert.equal(account, "dsh-1:token");
        return "installation-token";
      },
    });
    try {
      await withMemoryHost(async (host) => {
        await host.get("authority").createInstallation({
          id: "dsh-1",
          org_id: "local-owner",
          connector_type: "dsh-session",
          status: "enabled",
          config: { transport: "web", base_url: "http://127.0.0.1:3080" },
          created_at: "2026-08-21T00:00:00.000Z",
        });
        const services = createDshHostRpcServices(host, {
          org_id: "local-owner",
          fetch: async (url, init) => {
            if (String(url).includes("/connect?")) {
              assert.equal(new URL(url).searchParams.get("token"), "installation-token");
              return {
                ok: false,
                status: 302,
                headers: new Headers({
                  location: "./api/remote.mux",
                  "set-cookie": "dsh-auth-test=api-cookie; Path=/",
                }),
                async json() {
                  return {};
                },
              };
            }
            assert.equal(init.headers.cookie, "dsh-auth-test=api-cookie");
            const body = JSON.parse(init.body);
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  type: "server-response",
                  rpcId: body.rpcId,
                  result: { ok: true, value: { items: [], hasMore: false } },
                };
              },
            };
          },
        });
        assert.deepEqual(await services.listSessions(), []);
      });
    } finally {
      setKeychainStoreForTests();
    }
  });

  it("returns the requested history page on repeat receive calls", async () => {
    await withMemoryHost(async (host) => {
      await host.get("authority").createInstallation({
        id: "dsh-1",
        org_id: "local-owner",
        connector_type: "dsh-session",
        status: "enabled",
        config: {
          transport: "web",
          session_id: "dsh-main",
          base_url: "http://127.0.0.1:3080",
        },
        created_at: "2026-08-21T00:00:00.000Z",
      });
      const services = createDshHostRpcServices(host, {
        org_id: "local-owner",
        now: () => "2026-08-21T00:00:00.000Z",
        createId: () => "test",
        fetch: rejectFetch,
        mux_open: historyMux(HISTORY_EVENTS),
      });

      const first = await services.receive("dsh-main");
      const second = await services.receive("dsh-main");

      assert.deepEqual(first.events.map((event) => event.seq), [0, 1]);
      assert.equal(first.hasMore, false);
      assert.deepEqual(second.events.map((event) => event.seq), [0, 1]);
      assert.equal((await host.get("authority").listEvents("local-owner")).length, 2);
    });
  });

  it("fails receive when another worker holds the connector lease", async () => {
    await withMemoryHost(async (host) => {
      await host.get("authority").createInstallation({
        id: "dsh-1",
        org_id: "local-owner",
        connector_type: "dsh-session",
        status: "enabled",
        config: {
          transport: "web",
          session_id: "dsh-main",
          base_url: "http://127.0.0.1:3080",
        },
        created_at: "2026-08-21T00:00:00.000Z",
      });
      await host.get("authority").acquireLease({
        installation_id: "dsh-1",
        stream_key: "session:dsh-main",
        lease_owner: "worker-b",
        now: "2026-08-21T00:00:00.000Z",
        lease_duration_ms: 60_000,
      });
      const services = createDshHostRpcServices(host, {
        org_id: "local-owner",
        now: () => "2026-08-21T00:00:00.000Z",
        lease_owner: "api",
        fetch: rejectFetch,
        mux_open: historyMux(HISTORY_EVENTS),
      });

      await assert.rejects(
        () => services.receive("dsh-main"),
        (error) => error instanceof DshApiError && error.code === "agent-busy",
      );
    });
  });

  it("returns the history page when ingest poll fails", async () => {
    await withMemoryHost(async (host) => {
      await host.get("authority").createInstallation({
        id: "dsh-1",
        org_id: "local-owner",
        connector_type: "dsh-session",
        status: "enabled",
        config: {
          transport: "web",
          session_id: "dsh-main",
          base_url: "http://127.0.0.1:3080",
        },
        created_at: "2026-08-21T00:00:00.000Z",
      });
      const services = createDshHostRpcServices(host, {
        org_id: "local-owner",
        now: () => "2026-08-21T00:00:00.000Z",
        fetch: async () => {
          throw new Error("DSH walk failed");
        },
        mux_open: historyMux(
          [
            { ...HISTORY_EVENTS[0], seq: 100 },
            { ...HISTORY_EVENTS[1], seq: 101 },
          ],
          true,
        ),
      });

      const page = await services.receive("dsh-main");
      assert.deepEqual(page.events.map((event) => event.seq), [100, 101]);
      assert.equal(page.hasMore, true);
    });
  });

  it("creates a session and then histories that session id", async () => {
    await withMemoryHost(async (host) => {
      await host.get("authority").createInstallation({
        id: "dsh-1",
        org_id: "local-owner",
        connector_type: "dsh-session",
        status: "enabled",
        config: { transport: "web", base_url: "http://127.0.0.1:3080" },
        created_at: "2026-08-21T00:00:00.000Z",
      });
      const calls = [];
      const opened = [];
      const services = createDshHostRpcServices(host, {
        org_id: "local-owner",
        now: () => "2026-08-21T00:00:00.000Z",
        createId: () => "test",
        fetch: async (url, init) => {
          const body = JSON.parse(init.body);
          calls.push({ url, method: body.method });
          if (url.includes("session/create")) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  type: "server-response",
                  rpcId: body.rpcId,
                  result: { ok: true, value: { sessionId: "sess-real" } },
                };
              },
            };
          }
          if (url.includes("session/list")) {
            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  type: "server-response",
                  rpcId: body.rpcId,
                  result: { ok: true, value: { items: [{ sessionId: "sess-real" }], hasMore: false } },
                };
              },
            };
          }
          throw new Error(`unexpected ${url}`);
        },
        mux_open: historyMux(HISTORY_EVENTS, false, opened),
      });

      const created = await services.createSession();
      assert.deepEqual(created, { sessionId: "sess-real" });
      const listed = await services.listSessions();
      assert.deepEqual(listed.map((item) => item.sessionId), ["sess-real"]);
      const page = await services.receive("sess-real");
      assert.deepEqual(page.events.map((event) => event.seq), [0, 1]);
      assert.equal(
        opened.some((frame) =>
          frame.endpoint === "session/follow"
          && frame.payload.args.request.address.sessionId === "sess-real"),
        true,
      );
    });
  });

  it("uses REGENIC_DSH_BASE_URL when the stored install is cli", async () => {
    await withMemoryHost(async (host) => {
      await host.get("authority").createInstallation({
        id: "dsh-1",
        org_id: "local-owner",
        connector_type: "dsh-session",
        status: "enabled",
        config: { transport: "cli", mailbox: "dsh-main" },
        created_at: "2026-08-21T00:00:00.000Z",
      });
      const urls = [];
      const services = createDshHostRpcServices(host, {
        org_id: "local-owner",
        now: () => "2026-08-21T00:00:00.000Z",
        createId: () => "test",
        env: { REGENIC_DSH_BASE_URL: "http://regenic-dsh:3080" },
        fetch: rejectFetch,
        mux_open: async (input) => {
          urls.push(input.url);
          return historyMux(HISTORY_EVENTS)(input);
        },
      });

      await services.receive("dsh-main");
      assert.equal(urls[0], "ws://regenic-dsh:3080/api/remote.mux");
    });
  });
});

async function rejectFetch(url) {
  throw new Error(`unexpected HTTP call ${url}`);
}

/** Fake `/api/remote.mux` that answers `session/follow` with one snapshot. */
function historyMux(events, hasMore = false, opened = []) {
  return async function open(input) {
    return {
      send(data) {
        const frame = JSON.parse(data);
        if (frame.type !== "open") {
          return;
        }
        opened.push(frame);
        queueMicrotask(() => {
          input.onMessage(JSON.stringify({
            type: "item",
            streamId: frame.streamId,
            value: {
              type: "snapshot",
              cursor: events.reduce((max, event) => Math.max(max, event.seq), 0),
              hasMore,
              records: events.map((event) => ({ type: "event", event })),
            },
          }));
        });
      },
      close() {},
    };
  };
}

function memoryAuthority() {
  const events = new MemoryAuthorityStore();
  const runtime = new MemoryConnectorRuntimeStore();
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") {
        return undefined;
      }
      if (prop === "commitSyncPage") {
        return async (input) => {
          const committed = await events.commitSyncPage(input);
          await runtime.commitSyncPage(input);
          return committed;
        };
      }
      const runtimeValue = runtime[prop];
      if (typeof runtimeValue === "function") {
        return runtimeValue.bind(runtime);
      }
      const eventValue = events[prop];
      if (typeof eventValue === "function") {
        return eventValue.bind(events);
      }
      return runtimeValue ?? eventValue;
    },
  });
}

async function withMemoryHost(run) {
  const host = await createHost();
  try {
    await host.plugin(definePlugin({
      name: "memory-core",
      apply(ctx) {
        ctx.provide("authority", memoryAuthority());
        ctx.provide("blobs", new MemoryBlobStore());
      },
    }));
    await host.plugin(ingestPlugin);
    await run(host);
  } finally {
    await host.dispose();
  }
}
