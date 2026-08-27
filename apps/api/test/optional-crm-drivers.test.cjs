const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  loadedPrivateConnectorServices,
  optionalCrmDrivers,
  resolvePluginSpecs,
} = require("../dist/optional-crm-drivers");

describe("optionalCrmDrivers", () => {
  it("never throws when the private package is missing or present", () => {
    const drivers = optionalCrmDrivers();
    assert.ok(Array.isArray(drivers));
    for (const driver of drivers) {
      assert.equal(typeof driver.connector_type, "string");
      assert.equal(typeof driver.source, "string");
    }
  });

  it("reports the private connector ready only after a driver is registered", () => {
    assert.deepEqual(loadedPrivateConnectorServices({ has: () => false }), {});
    assert.equal(
      loadedPrivateConnectorServices({
        has: (type) => type === "crm-ops-review",
      })["crm-connector"].ready,
      true,
    );
  });

  it("does not hardcode an internal checkout path", () => {
    assert.deepEqual(resolvePluginSpecs({}), []);
    assert.deepEqual(
      resolvePluginSpecs({ REGENIC_CRM_CONNECTOR: " /tmp/crm-connector " }),
      ["/tmp/crm-connector"],
    );
  });
});
