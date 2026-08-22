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
const { dshSessionDriver } = require("../dist/dsh-session-driver");
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
});
