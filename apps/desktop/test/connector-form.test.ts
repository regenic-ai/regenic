import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  connectorFieldMissing,
  connectorFieldInvalid,
  connectorFormPayload,
  initialConnectorValues,
  initialConnectorOptions,
} from "../src/renderer/src/connector-form.ts";
import type { ConnectorField } from "../src/renderer/src/types.ts";

describe("connector form values", () => {
  const fields: ConnectorField[] = [
    { key: "selection", label: "Selection", required: true, default: "pick" },
    {
      key: "ids", label: "Conversations", required: true, type: "string_array",
      option_labels_key: "names", visible_when: { field: "selection", value: "pick" },
      options: [{ value: "id,1", label: "Team", title: "Team, West" }],
    },
    { key: "enabled", label: "Enabled", required: true, type: "boolean", default: false },
    { key: "limit", label: "Limit", required: true, type: "number", default: 0 },
  ];

  it("preserves typed defaults and arrays containing commas", () => {
    const values = initialConnectorValues(fields, { ids: ["id,1"] });
    assert.deepEqual(values, { selection: "pick", ids: ["id,1"], enabled: false, limit: 0 });
    assert.deepEqual(connectorFormPayload(fields, values), {
      selection: "pick", ids: ["id,1"], names: ["Team, West"], enabled: false, limit: 0,
    });
    assert.equal(connectorFieldMissing(fields[2], false), false);
    assert.equal(connectorFieldMissing(fields[3], 0), false);
  });

  it("adapts legacy CSV values and removes hidden typed values only on submit", () => {
    const values = initialConnectorValues(fields, { selection: "other", ids: "one,two" });
    assert.deepEqual(values.ids, ["one", "two"]);
    assert.deepEqual(connectorFormPayload(fields, values), { selection: "other", enabled: false, limit: 0 });
    assert.deepEqual(values.ids, ["one", "two"]);
  });

  it("preserves selected titles while searching or loading incomplete option pages", () => {
    const existing = { selection: "pick", ids: ["id,1"], names: ["Team, West"] };
    const options = initialConnectorOptions(fields, existing);
    const resolved = fields.map((field) => ({ ...field, options: options[field.key] ?? field.options }));
    assert.deepEqual(connectorFormPayload(resolved, initialConnectorValues(fields, existing)).names, ["Team, West"]);
  });

  it("keeps an explicit credential-clear intent separate from an empty input", () => {
    const secret: ConnectorField[] = [{ key: "token", label: "Token", required: false, type: "string", secret: true }];
    assert.deepEqual(connectorFormPayload(secret, { token: null }), { token: null });
    assert.deepEqual(connectorFormPayload(secret, { token: "" }), { token: "" });
  });

  it("uses core enum validation but accepts selected IDs outside a loaded dynamic page", () => {
    const field: ConnectorField = {
      key: "id", label: "ID", required: true, type: "string",
      options: [{ value: "one", label: "One" }],
    };
    assert.equal(connectorFieldInvalid(field, "two"), true);
    assert.equal(connectorFieldInvalid({ ...field, dynamic_options: true }, "two"), false);
    const secret = { ...field, options: undefined, secret: true };
    assert.equal(connectorFieldMissing(secret, "", true), false);
    assert.equal(connectorFieldMissing(secret, null, true), true);
  });
});
