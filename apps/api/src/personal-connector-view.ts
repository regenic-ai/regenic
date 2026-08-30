import {
  DEFAULT_COPY_LOCALE,
  resolveCopy,
  resolveInstallCatalog,
  resolveInstallPresentation,
  resolveSubjectKinds,
  sourceLabelFromCatalog,
  type ChannelDriver,
  type ConnectorInstallation,
  type ConnectorInstallationStatus,
  type CopyLocale,
  type CopyRef,
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
  secret?: boolean;
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

export interface ConnectorSetupStep {
  title: string;
  body?: string;
  command?: string;
  href?: string;
  visible_when?: ConnectorFieldWhen;
}

export interface ConnectorImportFiles {
  accept: string;
  max_bytes?: number;
  title?: string;
  description?: string;
}

export interface ConnectorCatalogItem {
  connector_type: string;
  source: string;
  title: string;
  description: string;
  credential_hint: string;
  installed: boolean;
  instance_count: number;
  setup_ready: boolean;
  singleton: boolean;
  fields: ConnectorField[];
  prerequisites: ConnectorPrerequisite[];
  setup_steps: ConnectorSetupStep[];
  import_files?: ConnectorImportFiles;
  unit_kinds: Array<{ id: string; label: string }>;
  docs: CatalogDocRef[];
}

export interface CatalogServiceState {
  ready: boolean;
  hint?: CopyRef;
}

export interface CatalogReadiness {
  env?: NodeJS.ProcessEnv;
  locale?: CopyLocale;
  drivers?: { list(): ChannelDriver[]; get?(type: string): ChannelDriver | undefined };
  services?: Record<string, boolean | CatalogServiceState>;
  field_options?: Record<string, Record<string, { value: string; label: CopyRef }[]>>;
  extras?: CatalogDefinition[];
}

interface CatalogDefinition {
  connector_type: string;
  source: string;
  title: string;
  description: string;
  credential_hint: string;
  singleton?: boolean;
  fields: ConnectorField[];
  prerequisites: Omit<ConnectorPrerequisite, "ready">[];
  setup_steps: ConnectorSetupStep[];
  import_files?: ConnectorImportFiles;
  unit_kinds: Array<{ id: string; label: string }>;
  docs: CatalogDocRef[];
}

export function catalogFromDrivers(
  drivers: { list(): ChannelDriver[] },
  env: NodeJS.ProcessEnv = process.env,
  locale: CopyLocale = DEFAULT_COPY_LOCALE,
): CatalogDefinition[] {
  return drivers.list().flatMap((driver) => {
    const catalog = driver.installCatalog?.({ env });
    return catalog ? [catalogDefinitionFromDriver(driver, catalog, locale)] : [];
  });
}

function catalogDefinitionFromDriver(
  driver: Pick<
    ChannelDriver,
    "connector_type" | "source" | "subjectCatalog" | "parseImport" | "locales"
  >,
  catalog: DriverInstallCatalog,
  locale: CopyLocale,
): CatalogDefinition {
  const tables = driver.locales?.() ?? [];
  const resolved = resolveInstallCatalog(catalog, tables, locale);
  const importFiles =
    typeof driver.parseImport === "function" ? resolved.import_files : undefined;
  return {
    connector_type: driver.connector_type,
    source: driver.source,
    title: resolved.title,
    description: resolved.description,
    credential_hint: resolved.credential_hint,
    singleton: resolved.singleton,
    unit_kinds: resolveSubjectKinds(driver.subjectCatalog?.(), tables, locale),
    fields: (resolved.fields ?? []).map((field) => ({
      key: field.key,
      label: field.label,
      required: field.required === true,
      placeholder: field.placeholder,
      default: field.default,
      multiple: field.multiple,
      secret: field.secret === true,
      options: field.options,
      visible_when: field.visible_when,
    })),
    prerequisites: (resolved.prerequisites ?? []).map((prerequisite) => ({
      kind: prerequisite.kind,
      key: prerequisite.key,
      label: prerequisite.label,
      required: prerequisite.required === true,
      hint: prerequisite.hint,
      visible_when: prerequisite.visible_when,
    })),
    setup_steps: catalogSetupSteps(resolved.setup_steps),
    ...(importFiles ? { import_files: importFiles } : {}),
    docs: CONNECTOR_INSTALL_DOCS,
  };
}

function catalogSetupSteps(
  steps: Array<{
    title: string;
    body?: string;
    command?: string;
    href?: string;
    visible_when?: ConnectorFieldWhen;
  }> | undefined,
): ConnectorSetupStep[] {
  return (steps ?? []).flatMap((step) => {
    const title = String(step.title ?? "").replace(/\s+/g, " ").trim();
    if (!title) {
      return [];
    }
    const body = step.body?.replace(/\s+/g, " ").trim();
    const command = step.command?.trim();
    const href = safeHttpHref(step.href);
    return [
      {
        title,
        ...(body ? { body } : {}),
        ...(command ? { command } : {}),
        ...(href ? { href } : {}),
        ...(step.visible_when ? { visible_when: step.visible_when } : {}),
      },
    ];
  });
}

function safeHttpHref(value: string | undefined): string | undefined {
  const href = value?.trim();
  if (!href) {
    return undefined;
  }
  try {
    const url = new URL(href);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return href;
    }
  } catch {
    return undefined;
  }
  return undefined;
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
  const locale = readiness.locale ?? DEFAULT_COPY_LOCALE;
  return (readiness.extras ?? []).map((item) => {
    const definition = item;
    const tables =
      readiness.drivers
        ?.list()
        .find((driver) => driver.connector_type === item.connector_type)
        ?.locales?.() ?? [];
    const instanceCount = installations.filter(
      (installation) => installation.connector_type === item.connector_type,
    ).length;
    const defaults = defaultFieldValues(definition.fields);
    const prerequisites = definition.prerequisites.map((prerequisite) => {
      const service = serviceState(readiness.services, prerequisite.key);
      const hint = resolveCopy(tables, locale, service?.hint) ?? service?.hint ?? prerequisite.hint;
      return {
        ...prerequisite,
        ready: prerequisiteReady(prerequisite, env, service),
        hint: typeof hint === "string" ? hint : prerequisite.hint,
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
        options: (
          readiness.field_options?.[item.connector_type]?.[field.key] ??
          field.options
        )?.map((option) => ({
          value: option.value,
          label: resolveCopy(tables, locale, option.label) ?? String(option.label),
        })),
      })),
      installed: instanceCount > 0,
      instance_count: instanceCount,
      setup_ready: requiredVisible.every((prerequisite) => prerequisite.ready),
      singleton: Boolean(definition.singleton),
      prerequisites,
      setup_steps: definition.setup_steps ?? [],
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
  create_with_task: boolean;
  channel: string;
  channel_label: string;
  last_attempt: IngestAttempt | null;
  pairing_code?: string;
}

export function toInstallationView(
  installation: ConnectorInstallation,
  lastAttempt: IngestAttempt | null,
  drivers: { get(connectorType: string): ChannelDriver | undefined },
  locale: CopyLocale = DEFAULT_COPY_LOCALE,
): EngineInstallationView {
  const driver = drivers.get(installation.connector_type);
  const { label, detail } = connectorPresentation(
    installation,
    driver,
    process.env,
    locale,
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
    create_with_task: enabled && capabilities.create === true && capabilities.create_with_task === true,
    channel,
    channel_label: sourceLabelFromCatalog(
      channel,
      driver?.installCatalog?.(),
      driver?.locales?.() ?? [],
      locale,
    ),
    last_attempt: lastAttempt,
  };
}

function connectorPresentation(
  installation: ConnectorInstallation,
  driver?: ChannelDriver,
  env: NodeJS.ProcessEnv = process.env,
  locale: CopyLocale = DEFAULT_COPY_LOCALE,
): {
  label: string;
  detail: string | null;
} {
  const tables = driver?.locales?.() ?? [];
  const presented = driver?.presentInstall?.(installation, { env });
  if (presented) {
    return resolveInstallPresentation(presented, tables, locale);
  }
  const extra = driver?.installCatalog?.({ env });
  if (extra?.instance_label) {
    return {
      label: resolveInstallPresentation(
        {
          label: extra.instance_label,
          detail: extra.instance_detail_key
            ? { literal: configString(installation.config, extra.instance_detail_key) ?? "" }
            : null,
        },
        tables,
        locale,
      ).label,
      detail: extra.instance_detail_key
        ? (configString(installation.config, extra.instance_detail_key) ?? null)
        : null,
    };
  }
  return { label: installation.id, detail: null };
}

export function nextPickedChatNames(
  config: Record<string, unknown>,
  streams: Array<{ thread_id?: string | null; label?: string | null }>,
): string[] | null {
  if (config.selection === "all") {
    return null;
  }
  const ids = configStringList(config, "chat_ids");
  if (ids.length === 0) {
    return null;
  }
  const existing = configStringList(config, "chat_names");
  if (existing.length === ids.length) {
    return null;
  }
  const byTarget = new Map<string, string>();
  for (const stream of streams) {
    const threadId = stream.thread_id?.trim();
    const label = stream.label?.replace(/\s+/g, " ").trim();
    if (!threadId || !label) {
      continue;
    }
    const target = threadId.includes(":")
      ? threadId.slice(threadId.indexOf(":") + 1)
      : threadId;
    if (!target || label === target) {
      continue;
    }
    byTarget.set(target, label);
  }
  const names = ids.map((id) => byTarget.get(id) ?? "");
  return names.every((name) => name.length > 0) ? names : null;
}

export function configStringList(
  config: Record<string, unknown>,
  name: string,
): string[] {
  const value = config[name];
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : [],
    );
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

const SECRET_SETTING_KEYS = new Set([
  "api_key",
  "token",
  "access_token",
  "secret",
  "password",
]);

export function installationSettings(
  config: Record<string, unknown>,
): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_SETTING_KEYS.has(key) || key.endsWith("_token") || key.endsWith("_secret")) {
      continue;
    }
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
