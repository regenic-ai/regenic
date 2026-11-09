const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { validateConnectorForm } = require("../dist/personal-connector-form");
const { catalogFromDrivers, installationSettings } = require("../dist/personal-connector-view");

describe("connector form v2", () => {
  const catalog = {
    form_version: 2,
    title: "Test", description: "Test", credential_hint: "Test",
    fields: [
      { key: "mode", label: "Mode", type: "string", required: true,
        options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
      { key: "ids", label: "IDs", type: "string_array", required: true,
        visible_when: { field: "mode", value: "a" } },
      { key: "limit", label: "Limit", type: "number", min: 0, max: 10 },
      { key: "credential", label: "Credential", type: "string", secret: true },
    ],
  };

  it("checks types, required values, options, ranges and conditional fields", () => {
    assert.doesNotThrow(() => validateConnectorForm(catalog, { mode: "a", ids: ["x"], limit: 0 }, false));
    assert.doesNotThrow(() => validateConnectorForm(catalog, { mode: "b" }, false));
    for (const input of [
      { mode: "a", ids: "x" }, { mode: "a", ids: [] },
      { mode: "unknown" }, { mode: "b", limit: 11 },
    ]) assert.throws(() => validateConnectorForm(catalog, input, false), { code: "invalid_config" });
    assert.doesNotThrow(() => validateConnectorForm({ ...catalog, form_version: undefined }, { mode: "a", ids: "x" }, false));
  });

  it("returns typed settings and redacts declared secrets regardless of their names", () => {
    assert.deepEqual(
      installationSettings({ ids: ["a,b"], names: ["Team, West"], limit: 2, credential: "private" }, catalog),
      { ids: ["a,b"], names: ["Team, West"], limit: 2 },
    );
    assert.deepEqual(installationSettings({ ids: ["a", "b"] }), { ids: "a,b" });
  });

  it("applies defaults, omits hidden fields and rejects incompatible declarations", () => {
    const withDefault = { ...catalog, fields: [
      { ...catalog.fields[0], default: "b" }, catalog.fields[1],
    ] };
    assert.deepEqual(validateConnectorForm(withDefault, { ids: ["x"] }, false), { mode: "b" });
    assert.throws(() => validateConnectorForm({
      ...catalog, fields: [{ key: "x", label: "X", type: "boolean", widget: "directory" }],
    }, {}, false), { code: "invalid_config" });
  });

  it("projects the version and field metadata into the catalog", () => {
    const [item] = catalogFromDrivers({ list: () => [{
      connector_type: "example", source: "example",
      installCatalog: () => ({
        ...catalog,
        fields: [{ key: "limit", label: "Limit", type: "number", widget: "number",
          default: 0, min: 0, max: 10, description: "Help", group: "Advanced", advanced: true }],
      }),
    }] });
    assert.equal(item.form_version, 2);
    assert.equal(item.fields[0].default, 0);
    assert.equal(item.fields[0].description, "Help");
    assert.equal(item.fields[0].group, "Advanced");
    assert.equal(item.fields[0].advanced, true);
    assert.equal(item.fields[0].min, 0);
  });

  it("does not publish secret defaults", () => {
    const badCatalog = { ...catalog, fields: [{
      key: "credential", label: "Credential", type: "string", secret: true, default: "private",
    }] };
    const [item] = catalogFromDrivers({ list: () => [{
      connector_type: "example", source: "example", installCatalog: () => badCatalog,
    }] });
    assert.equal(item.fields[0].default, undefined);
    assert.throws(() => validateConnectorForm(badCatalog, {}, false), { code: "invalid_config" });
  });

  it("keeps required secrets only when saved and rejects clearing them", () => {
    const secret = { ...catalog, fields: [{
      key: "credential", label: "Credential", type: "string", secret: true, required: true,
    }] };
    assert.throws(() => validateConnectorForm(secret, {}, true), { code: "invalid_config" });
    assert.doesNotThrow(() => validateConnectorForm(secret, {}, true, { credential: true }));
    assert.throws(() => validateConnectorForm(secret, { credential: null }, true, { credential: true }),
      { code: "invalid_config" });
  });

  it("adapts old API CSV inputs without weakening strict validation", () => {
    assert.deepEqual(
      validateConnectorForm(catalog, { mode: "a", ids: "one,two" }, false, {}, true),
      { mode: "a", ids: ["one", "two"] },
    );
    assert.throws(() => validateConnectorForm(catalog, { mode: "a", ids: "one,two" }, false),
      { code: "invalid_config" });
  });

  it("treats allow_custom options as suggestions rather than a closed enum", () => {
    const custom = { ...catalog, fields: [{ ...catalog.fields[0], allow_custom: true }] };
    assert.deepEqual(validateConnectorForm(custom, { mode: "custom" }, false), { mode: "custom" });
  });

  it("does not validate a dynamic choice against an incomplete catalog page", () => {
    const dynamic = { ...catalog, fields: [{ ...catalog.fields[0], dynamic_options: true }] };
    assert.deepEqual(validateConnectorForm(dynamic, { mode: "selected-on-another-page" }, false),
      { mode: "selected-on-another-page" });
  });
});
