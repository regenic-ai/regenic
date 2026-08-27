const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  extraChannelDrivers,
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
});
