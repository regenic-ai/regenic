const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { mkdtempSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const {
  extraChannelDrivers,
  extraTaskExecutors,
  resolvePluginSpecs,
} = require("../dist/extra-channel-drivers");

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
      JSON.stringify({ name: "extra-exec", main: "index.cjs" }),
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
});
