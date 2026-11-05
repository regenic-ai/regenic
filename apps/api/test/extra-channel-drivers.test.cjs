const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { describe, it } = require("node:test");
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { LocalExecutorPluginRegistry } = require("@regenic/domain");
const {
  extraChannelDrivers,
  extraTaskExecutors,
  listPluginInventory,
  loadNewExtraPlugins,
  resolvePluginDirectory,
  resolvePluginSpecs,
} = require("../dist/extra-channel-drivers");
const {
  createChannelDriverRegistry,
  createExecutorPluginRegistry,
  firstPartyPluginSpecs,
} = require("../dist/channel-plugins");
const { PersonalPluginService } = require("../dist/personal-plugin.service");

function extraManifest(name, contributes, manifest = {}) {
  return JSON.stringify({
    name,
    main: "index.cjs",
    regenic: {
      plugin: true,
      contributes,
      ...manifest,
    },
  });
}

describe("extraChannelDrivers", () => {
  it("never throws when extra packages are missing or present", () => {
    const drivers = extraChannelDrivers();
    assert.ok(Array.isArray(drivers));
    for (const driver of drivers) {
      assert.equal(typeof driver.connector_type, "string");
      assert.equal(typeof driver.source, "string");
    }
  });

  it("does not hardcode an internal checkout path", () => {
    assert.equal(resolvePluginDirectory({}), null);
    assert.equal(
      resolvePluginDirectory({ HOME: "/tmp/regenic-home" }),
      "/tmp/regenic-home/.regenic/plugins",
    );
    assert.deepEqual(resolvePluginSpecs({}), []);
    assert.deepEqual(
      resolvePluginSpecs({ REGENIC_CHANNEL_PLUGIN: " /tmp/extra-connector " }),
      ["/tmp/extra-connector"],
    );
    assert.deepEqual(
      resolvePluginSpecs({ REGENIC_CRM_CONNECTOR: " /tmp/crm-connector " }),
      ["/tmp/crm-connector"],
    );
  });

  it("warns when an explicit plugin cannot be resolved", () => {
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(" "));
    try {
      assert.deepEqual(
        extraChannelDrivers({ REGENIC_CHANNEL_PLUGIN: "/no/such-plugin" }),
        [],
      );
    } finally {
      console.warn = original;
    }
    assert.match(warnings.join("\n"), /cannot resolve \/no\/such-plugin/);
  });

  it("loads a TaskExecutor from the same plugin path as a driver", () => {
    const root = mkdtempSync(join(tmpdir(), "regenic-plugin-"));
    writeFileSync(
      join(root, "package.json"),
      extraManifest("extra-exec", { executors: ["plugin"] }),
    );
    writeFileSync(
      join(root, "index.cjs"),
      `
        exports.plugin = {
          executor_type: "extra",
          capabilities() { return { start: true, resume: true, status: true }; },
          catalog() {
            return { executor_type: "extra", label: "Extra", source: "extra", fields: [] };
          },
          async start() { return { external_run_id: "1", status: "running" }; },
          async resume() { return { external_run_id: "1", status: "running" }; },
          async status() { return { external_run_id: "1", status: "running" }; },
        };
      `,
    );
    const executors = extraTaskExecutors({ REGENIC_CHANNEL_PLUGIN: root });
    assert.equal(executors.length, 1);
    assert.equal(executors[0].catalog().source, "extra");
    assert.deepEqual(extraChannelDrivers({ REGENIC_CHANNEL_PLUGIN: root }), []);
  });

  it("skips a driver that declares an unsupported protocol", () => {
    const root = mkdtempSync(join(tmpdir(), "regenic-plugin-"));
    writeFileSync(
      join(root, "package.json"),
      extraManifest("future-driver", { drivers: ["future"] }),
    );
    writeFileSync(
      join(root, "index.cjs"),
      `
        exports.future = {
          connector_type: "future",
          source: "future",
          connector_protocol: "2.0",
          install() { return { id: "1", org_id: "o", connector_type: "future", status: "enabled", config: {}, created_at: "" }; },
        };
      `,
    );
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(" "));
    try {
      assert.deepEqual(extraChannelDrivers({ REGENIC_CHANNEL_PLUGIN: root }), []);
    } finally {
      console.warn = original;
    }
    assert.match(warnings.join("\n"), /unsupported protocol 2.0/);
  });

  it("loads a webhook-only extra driver", () => {
    const root = mkdtempSync(join(tmpdir(), "regenic-plugin-"));
    writeFileSync(
      join(root, "package.json"),
      extraManifest("extra-webhook", { drivers: ["extraWebhookDriver"] }),
    );
    writeFileSync(
      join(root, "index.cjs"),
      `module.exports = require(${JSON.stringify(
        require.resolve("./fixtures/extra-webhook-driver.cjs"),
      )});\n`,
    );
    const drivers = extraChannelDrivers({ REGENIC_CHANNEL_PLUGIN: root });
    assert.equal(drivers.length, 1);
    assert.equal(drivers[0].source_mode, "webhook");
    assert.equal(typeof drivers[0].bindWebhook, "function");
    const extra = listPluginInventory().find((item) => item.spec === root);
    assert.equal(extra?.origin, "extra");
    assert.equal(extra?.package_name, "extra-webhook");
    assert.equal(extra?.trust, "unsigned");
    assert.equal(extra?.status, "loaded");
  });

  it("does not duck-type an extra package without contributes", () => {
    const root = mkdtempSync(join(tmpdir(), "regenic-plugin-"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "no-contributes", main: "index.cjs" }),
    );
    writeFileSync(
      join(root, "index.cjs"),
      `
        exports.one = {
          connector_type: "no-contributes",
          source: "no-contributes",
          install() { return { id: "1", org_id: "o", connector_type: "no-contributes", status: "enabled", config: {}, created_at: "" }; },
        };
      `,
    );
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(" "));
    try {
      assert.deepEqual(extraChannelDrivers({ REGENIC_CHANNEL_PLUGIN: root }), []);
    } finally {
      console.warn = original;
    }
    assert.match(warnings.join("\n"), /missing regenic.contributes/);
    const extra = listPluginInventory().find((item) => item.spec === root);
    assert.equal(extra?.status, "failed");
    assert.equal(extra?.trust, "unsigned");
  });

  it("skips an extra package with a newer engines.regenic", () => {
    const root = mkdtempSync(join(tmpdir(), "regenic-plugin-"));
    writeFileSync(
      join(root, "package.json"),
      extraManifest("future-engine", { drivers: ["one"] }, { engines: { regenic: "2.0" } }),
    );
    writeFileSync(
      join(root, "index.cjs"),
      `
        exports.one = {
          connector_type: "future-engine",
          source: "future-engine",
          install() { return { id: "1", org_id: "o", connector_type: "future-engine", status: "enabled", config: {}, created_at: "" }; },
        };
      `,
    );
    const warnings = [];
    const original = console.warn;
    console.warn = (...args) => warnings.push(args.map(String).join(" "));
    try {
      assert.deepEqual(extraChannelDrivers({ REGENIC_CHANNEL_PLUGIN: root }), []);
    } finally {
      console.warn = original;
    }
    assert.match(warnings.join("\n"), /engines.regenic 1.0, got 2.0/);
    assert.equal(listPluginInventory().find((item) => item.spec === root)?.status, "skipped");
  });
});

describe("first-party channel plugins", () => {
  it("discovers kernel dependencies that declare regenic.plugin", () => {
    assert.deepEqual(firstPartyPluginSpecs(), [
      "@regenic/dsh-connector",
      "@regenic/feishu-connector",
      "@regenic/cursor-connector",
    ]);
  });

  it("hot-discovers a new extra type and does not replace a loaded one", () => {
    const pluginDir = mkdtempSync(join(tmpdir(), "regenic-hot-"));
    const firstDir = join(pluginDir, "one");
    mkdirSync(firstDir);
    writeFileSync(
      join(firstDir, "package.json"),
      extraManifest("extra-one", { drivers: ["one"] }),
    );
    writeFileSync(
      join(firstDir, "index.cjs"),
      `
        exports.one = {
          connector_type: "extra-one",
          source: "extra-one",
          install() { return { id: "1", org_id: "o", connector_type: "extra-one", status: "enabled", config: {}, created_at: "" }; },
        };
      `,
    );
    const env = { REGENIC_PLUGIN_DIR: pluginDir };
    const drivers = createChannelDriverRegistry(env);
    const executors = createExecutorPluginRegistry(env);
    assert.equal(drivers.has("extra-one"), true);

    writeFileSync(
      join(firstDir, "index.cjs"),
      `
        exports.one = {
          connector_type: "extra-replaced",
          source: "extra-one",
          install() { return { id: "1", org_id: "o", connector_type: "extra-replaced", status: "enabled", config: {}, created_at: "" }; },
        };
      `,
    );
    const secondDir = join(pluginDir, "two");
    mkdirSync(secondDir);
    writeFileSync(
      join(secondDir, "package.json"),
      extraManifest("extra-two", { drivers: ["two"] }),
    );
    writeFileSync(
      join(secondDir, "index.cjs"),
      `
        exports.two = {
          connector_type: "extra-two",
          source: "extra-two",
          install() { return { id: "2", org_id: "o", connector_type: "extra-two", status: "enabled", config: {}, created_at: "" }; },
        };
      `,
    );
    const loaded = loadNewExtraPlugins(drivers, executors, env);
    assert.deepEqual(loaded.drivers, ["extra-two"]);
    assert.equal(drivers.has("extra-one"), true);
    assert.equal(drivers.has("extra-two"), true);
    assert.equal(drivers.has("extra-replaced"), false);
  });

  it("can retry registration of an installed market package after a load failure", () => {
    const pluginDir = mkdtempSync(join(tmpdir(), "regenic-market-retry-"));
    const packageName = `retry-market-${Date.now()}`;
    const packageHash = createHash("sha256").update(packageName).digest("hex").slice(0, 24);
    const packageDir = join(pluginDir, `market-${packageHash}`);
    mkdirSync(packageDir);
    writeFileSync(
      join(packageDir, "package.json"),
      extraManifest(packageName, { drivers: ["retryDriver"] }),
    );
    writeFileSync(
      join(packageDir, ".regenic-market-install.json"),
      JSON.stringify({ package_name: packageName, version: "1.0.0" }),
    );
    const env = { REGENIC_PLUGIN_DIR: pluginDir };
    const drivers = createChannelDriverRegistry(env);
    const plugins = new PersonalPluginService(
      drivers,
      new LocalExecutorPluginRegistry(),
    );
    assert.equal(
      plugins.list().find((item) => item.package_name === packageName)?.status,
      "failed",
    );
    writeFileSync(
      join(packageDir, "index.cjs"),
      `exports.retryDriver = {
        connector_type: "retry-market-driver",
        source: "retry-market-driver",
        install() { return { id: "1", org_id: "o", connector_type: "retry-market-driver", status: "enabled", config: {}, created_at: "" }; },
      };`,
    );

    try {
      const result = plugins.retryMarketRegistration(packageName, env);
      assert.equal(result.registered, true);
      assert.deepEqual(result.driver_types, ["retry-market-driver"]);
      assert.deepEqual(result.registered_driver_types, ["retry-market-driver"]);
      assert.equal(drivers.has("retry-market-driver"), true);
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it("reports an executor source collision during market registration", () => {
    const pluginDir = mkdtempSync(join(tmpdir(), "regenic-market-executor-conflict-"));
    const packageName = `retry-market-executor-${Date.now()}`;
    const packageHash = createHash("sha256").update(packageName).digest("hex").slice(0, 24);
    const packageDir = join(pluginDir, `market-${packageHash}`);
    mkdirSync(packageDir);
    writeFileSync(
      join(packageDir, "package.json"),
      extraManifest(packageName, {
        drivers: ["marketDriver"],
        executors: ["marketExecutor"],
      }),
    );
    writeFileSync(
      join(packageDir, ".regenic-market-install.json"),
      JSON.stringify({ package_name: packageName, version: "1.0.0" }),
    );
    writeFileSync(
      join(packageDir, "index.cjs"),
      `
        exports.marketDriver = {
          connector_type: "executor-conflict-driver",
          source: "shared-executor-source",
          install() { return { id: "1", org_id: "o", connector_type: "executor-conflict-driver", status: "enabled", config: {}, created_at: "" }; },
        };
        exports.marketExecutor = {
          executor_type: "market",
          capabilities() { return { start: true }; },
          catalog() { return { source: "shared-executor-source" }; },
          async start() {},
          async resume() {},
          async status() {},
        };
      `,
    );
    const env = { REGENIC_PLUGIN_DIR: pluginDir };
    const drivers = createChannelDriverRegistry(env);
    const executors = new LocalExecutorPluginRegistry();
    executors.register({
      executor_type: "existing",
      capabilities() { return { start: true }; },
      catalog() { return { source: "shared-executor-source" }; },
      async start() {},
      async resume() {},
      async status() {},
    });
    const plugins = new PersonalPluginService(drivers, executors);

    try {
      const result = plugins.retryMarketRegistration(packageName, env);
      assert.equal(result.registered, false);
      assert.deepEqual(result.executor_sources, ["shared-executor-source"]);
      assert.deepEqual(result.registered_executor_sources, []);
      assert.match(result.error, /executor sources/u);
    } finally {
      rmSync(pluginDir, { recursive: true, force: true });
    }
  });

  it("assembles registries without Nest importing driver symbols", () => {
    const drivers = createChannelDriverRegistry({}).list().map((item) => item.connector_type);
    assert.deepEqual(drivers, [
      "dsh-session",
      "feishu-chat",
      "cursor-agent",
    ]);
    assert.equal(createExecutorPluginRegistry({}).default()?.executor_type, "dsh");
    const appModule = readFileSync(join(__dirname, "../src/app.module.ts"), "utf8");
    assert.equal(/from "@regenic\/(?:slack|dsh|feishu|cursor|whatsapp)/.test(appModule), false);
    const firstParty = listPluginInventory().filter((item) => item.origin === "first_party");
    assert.deepEqual(
      firstParty.map((item) => item.id),
      [
        "@regenic/cursor-connector",
        "@regenic/dsh-connector",
        "@regenic/feishu-connector",
      ],
    );
    assert.ok(firstParty.every((item) => item.trust === "core" && item.status === "loaded"));
    assert.deepEqual(
      firstParty.find((item) => item.id === "@regenic/dsh-connector")?.executors,
      ["dsh"],
    );
  });

  it("loads the four extra starter shapes from examples/connectors", () => {
    const pluginDir = join(__dirname, "../../../examples/connectors");
    const drivers = extraChannelDrivers({ REGENIC_PLUGIN_DIR: pluginDir });
    assert.deepEqual(
      drivers.map((item) => item.connector_type).sort(),
      [
        "example-catalog",
        "example-import",
        "example-poll",
        "example-webhook",
      ],
    );
    assert.equal(typeof drivers.find((item) => item.connector_type === "example-import")?.parseImport, "function");
    assert.equal(typeof drivers.find((item) => item.connector_type === "example-webhook")?.bindWebhook, "function");
  });
});
