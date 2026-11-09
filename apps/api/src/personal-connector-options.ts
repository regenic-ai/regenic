import {
  DEFAULT_CATALOG_OPTIONS_TIMEOUT_MS,
  resolveCopyText,
  withDeadline,
  type ChannelDriver,
  type ConnectorCatalogFieldOption,
  type ConnectorFieldOptionsRequest,
  type CopyLocale,
} from "@regenic/domain";
import { PersonalConnectorError } from "./personal-errors";

function invalid(message: string): never {
  throw new PersonalConnectorError("invalid_config", message, 400);
}

export async function loadConnectorOptions<T>(work: Promise<T>, connectorType: string): Promise<T> {
  try {
    return await withDeadline(work, DEFAULT_CATALOG_OPTIONS_TIMEOUT_MS, `catalog options ${connectorType}`);
  } catch {
    throw new PersonalConnectorError("catalog_options_failed", "Could not load connector options", 502);
  }
}

export async function connectorOptionsPage(
  driver: ChannelDriver | undefined,
  request: ConnectorFieldOptionsRequest,
  locale: CopyLocale,
) {
  if (!driver) invalid("Unknown connector");
  const fields = driver.installCatalog?.({ env: process.env }).fields ?? [];
  const field = fields.find((item) => item.key === request.field);
  if (!field || field.secret || field.widget === "password") invalid("Unknown option field");
  if (field.dynamic_options && !driver.listCatalogFieldOptions && !driver.listCatalogFieldOptionsPage) {
    throw new PersonalConnectorError("invalid_config", "Connector has no option loader", 502);
  }
  if (request.query !== undefined && (typeof request.query !== "string" || request.query.length > 200)) {
    invalid("Invalid option search");
  }
  if (request.cursor !== undefined && (typeof request.cursor !== "string" || request.cursor.length > 500)) {
    invalid("Invalid option cursor");
  }
  const limit = request.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid("Invalid option page size");
  const values: NonNullable<ConnectorFieldOptionsRequest["values"]> = {};
  for (const key of field.options_depends_on ?? []) {
    const dependency = fields.find((item) => item.key === key);
    if (!dependency || dependency.secret || dependency.widget === "password") {
      invalid("Invalid option dependency declaration");
    }
    const value = request.values?.[key];
    if (value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value)) &&
      !(Array.isArray(value) && value.every((item) => typeof item === "string"))) {
      invalid("Invalid option dependency value");
    }
    values[key] = value;
  }
  const tables = driver.locales?.() ?? [];
  const resolve = (options: ConnectorCatalogFieldOption[]) => {
    if (!Array.isArray(options) ||
      options.some((option) => !option || typeof option.value !== "string") ||
      new Set(options.map((option) => option.value)).size !== options.length) {
      throw new PersonalConnectorError("invalid_config", "Invalid connector options", 502);
    }
    return options.map((option) => ({
      value: option.value,
      label: resolveCopyText(tables, locale, option.label),
      ...(typeof option.kind === "string" ? { kind: option.kind } : {}),
      ...(typeof option.title === "string" ? { title: option.title } : {}),
    }));
  };
  if (driver.listCatalogFieldOptionsPage) {
    const page = await loadConnectorOptions(driver.listCatalogFieldOptionsPage({
      env: process.env, field: field.key, query: request.query,
      cursor: request.cursor, limit, values,
    }), driver.connector_type);
    if (!Array.isArray(page.options) || page.options.length > limit ||
      (page.next_cursor !== undefined && (typeof page.next_cursor !== "string" ||
        page.next_cursor.length > 500 || page.next_cursor === request.cursor))) {
      throw new PersonalConnectorError("invalid_config", "Invalid connector options page", 502);
    }
    return { options: resolve(page.options), next_cursor: page.next_cursor };
  }
  const raw = driver.listCatalogFieldOptions
    ? await loadConnectorOptions(driver.listCatalogFieldOptions({ env: process.env }), driver.connector_type)
    : {};
  let options = resolve(raw[field.key] ?? field.options ?? []);
  if (field.filter_options_by) {
    const value = values[field.filter_options_by];
    const kinds = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    if (kinds.length) options = options.filter((option) => !option.kind || kinds.includes(option.kind));
  }
  const query = request.query?.trim().toLowerCase();
  if (query) options = options.filter((option) =>
    option.label.toLowerCase().includes(query) || option.value.toLowerCase().includes(query));
  const cursor = request.cursor ?? "0";
  if (!/^(0|[1-9]\d*)$/.test(cursor)) invalid("Invalid option cursor");
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset) || offset > options.length) invalid("Invalid option cursor");
  const next = offset + limit;
  return {
    options: options.slice(offset, next),
    next_cursor: next < options.length ? String(next) : undefined,
  };
}
