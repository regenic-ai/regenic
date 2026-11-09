const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { connectorFieldValueIssue, matchesCatalogFieldWhen } = require("../dist/form");

describe("browser-safe connector form rules", () => {
  const field = (type, overrides = {}) => ({ key: "value", label: "Value", type, ...overrides });

  it("preserves required false and zero, and validates types and ranges", () => {
    assert.equal(connectorFieldValueIssue(field("boolean", { required: true }), false), undefined);
    assert.equal(connectorFieldValueIssue(field("number", { required: true }), 0), undefined);
    assert.equal(connectorFieldValueIssue(field("number", { min: 0, max: 1 }), 0.5), undefined);
    assert.equal(connectorFieldValueIssue(field("number", { min: 0, max: 1 }), 2), "range");
    assert.equal(connectorFieldValueIssue(field("number"), NaN), "type");
    assert.equal(connectorFieldValueIssue(field("boolean"), "false"), "type");
    assert.equal(connectorFieldValueIssue(field("string_array"), ["a", 1]), "type");
    assert.equal(connectorFieldValueIssue(field("string_array", { required: true }), []), "required");
  });

  it("distinguishes retaining a saved credential from explicitly removing it", () => {
    const secret = field("string", { widget: "password", required: true });
    for (const value of [undefined, "", "   "]) {
      assert.equal(connectorFieldValueIssue(secret, value, true), undefined);
      assert.equal(connectorFieldValueIssue(secret, value, false), "required");
    }
    assert.equal(connectorFieldValueIssue(secret, null, true), "required");
    assert.equal(connectorFieldValueIssue(secret, "replacement", true), undefined);
  });

  it("enforces static options without treating a dynamic page as the full enum", () => {
    const choice = field("string", { options: [{ value: "one", label: "One" }] });
    assert.equal(connectorFieldValueIssue(choice, "two"), "option");
    assert.equal(connectorFieldValueIssue({ ...choice, allow_custom: true }, "two"), undefined);
    assert.equal(connectorFieldValueIssue({ ...choice, dynamic_options: true }, "two"), undefined);
  });

  it("uses the same conditional rules for fields, prerequisites and confirmations", () => {
    assert.equal(matchesCatalogFieldWhen(undefined, {}), true);
    assert.equal(matchesCatalogFieldWhen({ field: "mode", value: "a|b" }, { mode: "b" }), true);
    assert.equal(matchesCatalogFieldWhen({ field: "mode", values: ["a"] }, { mode: "b" }), false);
    assert.equal(matchesCatalogFieldWhen({ field: "enabled", value: "false" }, { enabled: false }), true);
  });

  it("loads the pure entry point without importing host or connector runtime modules", () => {
    const { execFileSync } = require("node:child_process");
    execFileSync(process.execPath, ["-e", `
      require(${JSON.stringify(require.resolve("../dist/form"))});
      if (Object.keys(require.cache).some(path => /(?:plugin-host|services|domain|node_modules)/.test(path))) {
        throw new Error("Form entry loaded runtime dependencies");
      }
    `]);
  });
});
