const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryConnectorRegistry, MemoryEgressRegistry } = require("@regenic/domain");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const {
  dshSessionPlugin,
  dshSessionPluginConfigFromInstallation,
  resolveDshTransport,
  resolveEffectiveDshTransport,
} = require("../dist/plugin");
const { ChannelDriverError } = require("@regenic/domain");
const { createDshConversation, dshSessionDriver } = require("../dist/dsh-session-driver");
const { loopbackHttpUrl, operatorHttpUrl, resolveOperatorDshBaseUrl } = require("../dist/dsh-url");

function withEnv(overrides, run) {
  const previous = {};
  for (const [key, value] of Object.entries(overrides)) {
    previous[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe("dshSessionPlugin", () => {
  it("registers on connectors and egress and unregisters when disposed", async () => {
    const host = await createHost();
    const connectors = new MemoryConnectorRegistry();
    const egress = new MemoryEgressRegistry();
    await host.plugin(definePlugin({
      name: "registries",
      apply(ctx) {
        ctx.provide("connectors", connectors);
        ctx.provide("egress", egress);
      },
    }));

    const mounted = await host.plugin(dshSessionPlugin, {
      installation_id: "dsh-1",
      org_id: "local-owner",
      transport: "cli",
      mailbox: "dsh-main",
    });

    assert.equal(connectors.get("dsh-1")?.source, "dsh");
    assert.equal(egress.get("dsh-1")?.source, "dsh");
    await mounted.dispose();
    assert.equal(connectors.get("dsh-1"), undefined);
    assert.equal(egress.get("dsh-1"), undefined);
    await host.dispose();
  });

  it("resolves transport from the explicit field or from base_url", () => {
    assert.equal(resolveDshTransport({ transport: "web" }), "web");
    assert.equal(resolveDshTransport({ transport: "cli" }), "cli");
    assert.equal(resolveDshTransport({ base_url: "http://127.0.0.1:8080" }), "web");
    assert.equal(resolveDshTransport({ mailbox: "dsh-main" }), "cli");
  });

  it("overrides stored cli transport when REGENIC_DSH_BASE_URL is set", () => {
    const env = { REGENIC_DSH_BASE_URL: "http://regenic-dsh:3080" };
    assert.equal(resolveEffectiveDshTransport({ transport: "cli" }, env), "web");
    assert.equal(resolveOperatorDshBaseUrl(env), "http://regenic-dsh:3080");
    assert.equal(operatorHttpUrl("https://dsh.example/"), "https://dsh.example");
    assert.throws(() => loopbackHttpUrl("http://regenic-dsh:3080"));
    const config = dshSessionPluginConfigFromInstallation(
      {
        id: "dsh-main",
        org_id: "local-owner",
        config: { transport: "cli", mailbox: "dsh-main" },
      },
      { env },
    );
    assert.equal(config.transport, "web");
    assert.equal(config.base_url, "http://regenic-dsh:3080");
  });

  it("matches web sessions for a stored cli install when operator URL is set", () => {
    const installation = {
      id: "dsh-main",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "cli", mailbox: "dsh-main" },
      created_at: "2026-08-21T00:00:00.000Z",
    };
    withEnv({ REGENIC_DSH_BASE_URL: undefined }, () => {
      assert.equal(
        dshSessionDriver.matchesThread(installation, {
          source: "dsh",
          target: "session-abc",
        }),
        false,
      );
      assert.equal(
        dshSessionDriver.matchesThread(installation, {
          source: "dsh",
          target: "dsh-main",
        }),
        true,
      );
    });
    withEnv({ REGENIC_DSH_BASE_URL: "http://regenic-dsh:3080" }, () => {
      assert.equal(
        dshSessionDriver.matchesThread(installation, {
          source: "dsh",
          target: "session-abc",
        }),
        true,
      );
      assert.equal(
        dshSessionDriver.ownsThread(installation, {
          source: "dsh",
          target: "session-abc",
        }),
        false,
      );
    });
  });

  it("installs web without persisting a public URL when operator URL is set", () => {
    withEnv({ REGENIC_DSH_BASE_URL: "http://regenic-dsh:3080" }, () => {
      const installed = dshSessionDriver.install({
        id: "dsh-1",
        org_id: "local-owner",
        config: {
          transport: "web",
          base_url: "https://regenic-dsh.sealosbja.site",
        },
        now: "2026-08-21T00:00:00.000Z",
      });
      assert.equal(installed.config.transport, "web");
      assert.equal(installed.config.base_url, undefined);
    });
    withEnv({ REGENIC_DSH_BASE_URL: undefined }, () => {
      assert.throws(() =>
        dshSessionDriver.install({
          id: "dsh-1",
          org_id: "local-owner",
          config: {
            transport: "web",
            base_url: "https://regenic-dsh.sealosbja.site",
          },
          now: "2026-08-21T00:00:00.000Z",
        }),
      );
    });
  });

  it("declares create only for unpinned web installs", () => {
    const web = {
      id: "dsh-1",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "web" },
      created_at: "2026-08-21T00:00:00.000Z",
    };
    const pinned = {
      ...web,
      config: { transport: "web", session_id: "sess-a" },
    };
    const cli = {
      ...web,
      config: { transport: "cli", mailbox: "dsh-main" },
    };
    withEnv({ REGENIC_DSH_BASE_URL: undefined }, () => {
      assert.deepEqual(dshSessionDriver.capabilities(web), {
        sync: true,
        reply: true,
        create: true,
        await_reply: true,
        list_title: "prompt",
      });
      assert.deepEqual(dshSessionDriver.capabilities(pinned), {
        sync: true,
        reply: true,
        create: false,
        await_reply: true,
        list_title: "prompt",
      });
      assert.deepEqual(dshSessionDriver.capabilities(cli), {
        sync: true,
        reply: true,
        create: false,
        await_reply: true,
        list_title: "prompt",
      });
    });
  });

  it("returns no streams when DSH web has no sessions", async () => {
    const installation = {
      id: "dsh-1",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "web", base_url: "http://127.0.0.1:3080" },
      created_at: "2026-08-21T00:00:00.000Z",
    };
    const previous = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
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
    };
    const host = await createHost();
    try {
      const streams = await dshSessionDriver.resolveStreams(installation, host, {});
      assert.deepEqual(streams, []);
    } finally {
      globalThis.fetch = previous;
      await host.dispose();
    }
  });

  it("creates a DSH web session and rejects pinned or CLI installs", async () => {
    const web = {
      id: "dsh-1",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "web", base_url: "http://127.0.0.1:3080" },
      created_at: "2026-08-21T00:00:00.000Z",
    };
    const created = await createDshConversation(web, {}, {
      async fetch(_url, init) {
        const body = JSON.parse(init.body);
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              type: "server-response",
              rpcId: body.rpcId,
              result: { ok: true, value: { sessionId: "sess-new" } },
            };
          },
        };
      },
    });
    assert.deepEqual(created, { source: "dsh", target: "sess-new" });

    await assert.rejects(
      () => createDshConversation({
        ...web,
        config: { transport: "web", session_id: "sess-a" },
      }, {}),
      (error) => error instanceof ChannelDriverError && error.code === "unsupported_channel",
    );
    await assert.rejects(
      () => createDshConversation({
        ...web,
        config: { transport: "cli", mailbox: "dsh-main" },
      }, {}),
      (error) => error instanceof ChannelDriverError && error.code === "unsupported_channel",
    );
  });
});
