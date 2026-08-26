const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { optionalCrmDrivers } = require("../dist/optional-crm-drivers");

describe("optionalCrmDrivers", () => {
  it("never throws when the private package is missing or present", () => {
    const drivers = optionalCrmDrivers();
    assert.ok(Array.isArray(drivers));
    for (const driver of drivers) {
      assert.equal(typeof driver.connector_type, "string");
      assert.equal(driver.source, "crm");
    }
  });
});
