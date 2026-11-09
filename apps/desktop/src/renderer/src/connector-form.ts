import { configWithOptionNames, optionTitle, splitValues } from "./connector-config.ts";
import { matchesCatalogFieldWhen } from "./connector-install-guard.ts";
import type { ConnectorField, ConnectorFieldOption } from "./types.ts";
import { connectorFieldValueIssue } from "@regenic/connector-contract/form";

export type ConnectorFormValues = Record<string, unknown>;

export function initialConnectorOptions(
  fields: ConnectorField[],
  existing: ConnectorFormValues = {},
): Record<string, ConnectorFieldOption[]> {
  const result: Record<string, ConnectorFieldOption[]> = {};
  for (const field of fields) {
    if (!field.option_labels_key) continue;
    const ids = splitValues(existing[field.key]);
    const names = splitValues(existing[field.option_labels_key]);
    if (ids.length && ids.length === names.length) {
      result[field.key] = ids.map((value, index) => ({ value, label: names[index], title: names[index] }));
    }
  }
  return result;
}

export function initialConnectorValues(
  fields: ConnectorField[],
  existing: ConnectorFormValues = {},
): ConnectorFormValues {
  const values: ConnectorFormValues = { ...existing };
  for (const field of fields) {
    let value = values[field.key] ?? field.default;
    if (value === undefined && field.type === "boolean") value = false;
    if (field.type === "string_array" && value !== undefined) {
      value = splitValues(value);
    }
    if (value !== undefined) values[field.key] = value;
  }
  return values;
}

export function connectorFieldMissing(field: ConnectorField, value: unknown, savedCredential = false): boolean {
  return connectorFieldValueIssue(field, value, savedCredential) === "required";
}

export function connectorFieldInvalid(field: ConnectorField, value: unknown): boolean {
  const issue = connectorFieldValueIssue(field, value);
  return issue !== undefined && issue !== "required";
}

export function connectorFormPayload(
  fields: ConnectorField[],
  values: ConnectorFormValues,
): ConnectorFormValues {
  const legacy: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") legacy[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      legacy[key] = value.join(",");
    }
  }
  const visible = fields.filter((field) => matchesCatalogFieldWhen(field.visible_when, values));
  const withNames = configWithOptionNames(legacy, visible);
  const result: ConnectorFormValues = { ...values, ...withNames };
  for (const field of fields) {
    if (field.type && !matchesCatalogFieldWhen(field.visible_when, values)) {
      delete result[field.key];
      if (field.option_labels_key) delete result[field.option_labels_key];
    } else if (field.type && values[field.key] !== undefined) {
      result[field.key] = values[field.key];
    }
    if (field.option_labels_key && !(field.option_labels_key in withNames)) {
      delete result[field.option_labels_key];
    }
    if (field.type === "string_array" && field.option_labels_key &&
      matchesCatalogFieldWhen(field.visible_when, values)) {
      const selected = splitValues(values[field.key]);
      const titles = selected.map((id) => {
        const option = field.options?.find((item) => item.value === id);
        return option ? optionTitle(option) : "";
      });
      if (titles.length > 0 && titles.every(Boolean)) result[field.option_labels_key] = titles;
      else delete result[field.option_labels_key];
    }
  }
  return result;
}
