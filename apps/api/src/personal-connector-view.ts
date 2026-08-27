import {
  channelLabel,
  type ChannelDriver,
  type ConnectorInstallation,
  type ConnectorInstallationStatus,
  type DriverInstallCatalog,
  type IngestAttempt,
} from "@regenic/domain";
import {
  CONNECTOR_INSTALL_DOCS,
  type CatalogDocRef,
} from "./install-docs";

export type { CatalogDocRef };

export interface ConnectorFieldWhen {
  field: string;
  value: string;
}

export interface ConnectorField {
  key: string;
  label: string;
  required: boolean;
  placeholder?: string;
  default?: string;
  multiple?: boolean;
  options?: { value: string; label: string }[];
  visible_when?: ConnectorFieldWhen;
}

export interface ConnectorPrerequisite {
  kind: "env" | "local_service";
  key: string;
  label: string;
  required: boolean;
  hint?: string;
  ready: boolean;
  visible_when?: ConnectorFieldWhen;
}

export interface ConnectorCatalogItem {
  connector_type: string;
  title: string;
  description: string;
  credential_hint: string;
  installed: boolean;
  instance_count: number;
  setup_ready: boolean;
  singleton: boolean;
  fields: ConnectorField[];
  prerequisites: ConnectorPrerequisite[];
  docs: CatalogDocRef[];
}

export interface CatalogServiceState {
  ready: boolean;
  hint?: string;
}

export interface CatalogReadiness {
  env?: NodeJS.ProcessEnv;
  services?: Record<string, boolean | CatalogServiceState>;
  field_options?: Record<string, Record<string, { value: string; label: string }[]>>;
  extras?: CatalogDefinition[];
}

interface CatalogDefinition {
  connector_type: string;
  title: string;
  description: string;
  credential_hint: string;
  singleton?: boolean;
  fields: ConnectorField[];
  prerequisites: Omit<ConnectorPrerequisite, "ready">[];
  docs: CatalogDocRef[];
}

export function catalogFromDrivers(
  drivers: { list(): ChannelDriver[] },
  env: NodeJS.ProcessEnv = process.env,
): CatalogDefinition[] {
  return drivers.list().flatMap((driver) => {
    const catalog = driver.installCatalog?.({ env });
    return catalog ? [catalogDefinitionFromDriver(driver.connector_type, catalog)] : [];
  });
}

function catalogDefinitionFromDriver(
  connectorType: string,
  catalog: DriverInstallCatalog,
): CatalogDefinition {
  return {
    connector_type: connectorType,
    title: catalog.title,
    description: catalog.description,
    credential_hint: catalog.credential_hint,
    singleton: catalog.singleton,
    fields: (catalog.fields ?? []).map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required === true,
      placeholder: field.placeholder,
      default: field.default,
      multiple: field.multiple,
      options: field.options,
      visible_when: field.visible_when,
    })),
    prerequisites: (catalog.prerequisites ?? []).map((prerequisite) => ({
      kind: prerequisite.kind,
      key: prerequisite.key,
      label: prerequisite.label,
      required: prerequisite.required === true,
      hint: prerequisite.hint,
      visible_when: prerequisite.visible_when,
    })),
    docs: CONNECTOR_INSTALL_DOCS,
  };
}

export function connectorAllowsMultiple(
  connectorType: string,
  extras: CatalogDefinition[] = [],
): boolean {
  const item = extras.find((entry) => entry.connector_type === connectorType);
  return item?.singleton !== true;
}

export function connectorCatalog(
  installations: EngineInstallationView[],
  readiness: CatalogReadiness = {},
): ConnectorCatalogItem[] {
  const env = readiness.env ?? process.env;
  return (readiness.extras ?? []).map((item) => {
    const definition = item;
    const instanceCount = installations.filter(
      (installation) => installation.connector_type === item.connector_type,
    ).length;
    const defaults = defaultFieldValues(definition.fields);
    const prerequisites = definition.prerequisites.map((prerequisite) => {
      const service = serviceState(readiness.services, prerequisite.key);
      return {
        ...prerequisite,
        ready: prerequisiteReady(prerequisite, env, service),
        hint: service?.hint ?? prerequisite.hint,
      };
    });
    const requiredVisible = prerequisites.filter(
      (prerequisite) =>
        prerequisite.required &&
        matchesWhen(prerequisite.visible_when, defaults),
    );
    return {
      ...definition,
      fields: definition.fields.map((field) => ({
        ...field,
        options:
          readiness.field_options?.[item.connector_type]?.[field.key] ??
          field.options,
      })),
      installed: instanceCount > 0,
      instance_count: instanceCount,
      setup_ready: requiredVisible.every((prerequisite) => prerequisite.ready),
      singleton: Boolean(definition.singleton),
      prerequisites,
    };
  });
}

export interface EngineInstallationView {
  id: string;
  connector_type: string;
  status: ConnectorInstallationStatus;
  label: string;
  detail: string | null;
  settings: Record<string, string>;
  syncable: boolean;
  can_reply: boolean;
  can_create: boolean;
  channel: string;
  channel_label: string;
  last_attempt: IngestAttempt | null;
}

export function toInstallationView(
  installation: ConnectorInstallation,
  lastAttempt: IngestAttempt | null,
  drivers: { get(connectorType: string): ChannelDriver | undefined },
): EngineInstallationView {
  const driver = drivers.get(installation.connector_type);
  const { label, detail } = connectorPresentation(
    installation,
    driver,
    process.env,
  );
  const capabilities = driver?.capabilities(installation) ?? {
    sync: false,
    reply: false,
    create: false,
  };
  const enabled = installation.status === "enabled";
  const channel = driver?.source ?? installation.connector_type;
  return {
    id: installation.id,
    connector_type: installation.connector_type,
    status: installation.status,
    label,
    detail,
    settings: installationSettings(installation.config),
    syncable: enabled && capabilities.sync,
    can_reply: enabled && capabilities.reply,
    can_create: enabled && capabilities.create,
    channel,
    channel_label: channelLabel(channel),
    last_attempt: lastAttempt,
  };
}

function connectorPresentation(
  installation: ConnectorInstallation,
  driver?: ChannelDriver,
  env: NodeJS.ProcessEnv = process.env,
): {
  label: string;
  detail: string | null;
} {
  const presented = driver?.presentInstall?.(installation, { env });
  if (presented) {
    return presented;
  }
  const extra = driver?.installCatalog?.({ env });
  if (extra?.instance_label) {
    return {
      label: extra.instance_label,
      detail: extra.instance_detail_key
        ? (configString(installation.config, extra.instance_detail_key) ?? null)
        : null,
    };
  }
  return { label: installation.id, detail: null };
}

export function installationSettings(
  config: Record<string, unknown>,
): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value === "string") {
      settings[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((entry) => typeof entry === "string")
    ) {
      settings[key] = value.join(",");
    }
  }
  return settings;
}

export function configString(
  config: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = config[name];
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

export function matchesWhen(
  when: ConnectorFieldWhen | undefined,
  values: Record<string, string>,
): boolean {
  if (!when) {
    return true;
  }
  return (values[when.field] ?? "") === when.value;
}

function defaultFieldValues(fields: ConnectorField[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    if (field.default) {
      values[field.key] = field.default;
    }
  }
  return values;
}

function serviceState(
  services: CatalogReadiness["services"],
  key: string,
): CatalogServiceState | undefined {
  const value = services?.[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return { ready: value };
  }
  return value;
}

function prerequisiteReady(
  prerequisite: Omit<ConnectorPrerequisite, "ready">,
  env: NodeJS.ProcessEnv,
  service: CatalogServiceState | undefined,
): boolean {
  if (prerequisite.kind === "env") {
    const value = env[prerequisite.key];
    return typeof value === "string" && value.trim().length > 0;
  }
  return service?.ready === true;
}
