import { connectorFieldValueIssue, matchesCatalogFieldWhen, type DriverInstallCatalog } from "@regenic/domain";
import { PersonalConnectorError } from "./personal-errors";

interface PreparedConnectorForm {
  config: Record<string, unknown>;
  credentialChanges: Record<string, null>;
}

export function prepareConnectorForm(
  catalog: DriverInstallCatalog | undefined,
  config: Record<string, unknown>,
  editing: boolean,
  credentials: Record<string, boolean> = {},
  acceptLegacyCsv = false,
): PreparedConnectorForm {
  if (catalog?.form_version !== undefined && catalog.form_version !== 2) {
    throw new PersonalConnectorError("invalid_config", "Unsupported connector form version", 400);
  }
  const fields = catalog?.fields ?? [];
  if (catalog?.form_version !== 2) {
    return {
      config,
      credentialChanges: Object.fromEntries(fields
        .filter((field) => (field.secret || field.widget === "password") &&
          matchesCatalogFieldWhen(field.visible_when, config) && config[field.key] === null)
        .map((field) => [field.key, null])),
    };
  }
  const keys = new Set<string>();
  const widgets: Record<string, readonly string[]> = {
    string: ["text", "password", "directory", "select"],
    number: ["number"],
    boolean: ["switch"],
    string_array: ["multi_select"],
  };
  for (const field of fields) {
    const allowed = field.type && widgets[field.type];
    if (!field.key || keys.has(field.key) || !allowed ||
      (field.widget !== undefined && !allowed.includes(field.widget)) ||
      (field.secret && field.type !== "string") ||
      ((field.secret || field.widget === "password") && field.default !== undefined) ||
      (field.multiple && field.type !== "string_array") ||
      ((field.min !== undefined || field.max !== undefined) && field.type !== "number") ||
      (field.min !== undefined && !Number.isFinite(field.min)) ||
      (field.max !== undefined && !Number.isFinite(field.max)) ||
      (field.min !== undefined && field.max !== undefined && field.min > field.max)) {
      throw new PersonalConnectorError("invalid_config", "Invalid connector form declaration", 400);
    }
    keys.add(field.key);
  }
  const values = { ...Object.fromEntries(fields.flatMap((field) =>
    field.default === undefined ? [] : [[field.key, field.default]],
  )), ...config };
  if (acceptLegacyCsv) {
    for (const field of fields) {
      const value = values[field.key];
      if (field.type === "string_array" && typeof value === "string") {
        values[field.key] = value.split(",").map((item) => item.trim()).filter(Boolean);
      }
    }
  }
  const normalized = { ...values };
  const credentialChanges: Record<string, null> = {};
  for (const field of fields) {
    if (!matchesCatalogFieldWhen(field.visible_when, values)) {
      delete normalized[field.key];
      continue;
    }
    const value = values[field.key];
    const issue = connectorFieldValueIssue(field, value, editing && credentials[field.key] === true);
    if (issue) {
      const message = issue === "required" ? `${field.key} is required`
        : issue === "option" ? `Invalid option for ${field.key}` : `Invalid value for ${field.key}`;
      throw new PersonalConnectorError("invalid_config", message, 400);
    }
    if ((field.secret || field.widget === "password") && value === null) {
      credentialChanges[field.key] = null;
      delete normalized[field.key];
    }
  }
  return { config: normalized, credentialChanges };
}

export function validateConnectorForm(
  catalog: DriverInstallCatalog | undefined,
  config: Record<string, unknown>,
  editing: boolean,
  credentials: Record<string, boolean> = {},
  acceptLegacyCsv = false,
): Record<string, unknown> {
  return prepareConnectorForm(catalog, config, editing, credentials, acceptLegacyCsv).config;
}
