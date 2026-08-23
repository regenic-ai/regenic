import type {
  ChannelDriver,
  ConnectorInstallation,
  ConnectorInstallationStatus,
  IngestAttempt,
} from "@regenic/domain";

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
  fields: ConnectorField[];
  prerequisites: ConnectorPrerequisite[];
}

export interface CatalogServiceState {
  ready: boolean;
  hint?: string;
}

export interface CatalogReadiness {
  env?: NodeJS.ProcessEnv;
  services?: Record<string, boolean | CatalogServiceState>;
  field_options?: Record<string, Record<string, { value: string; label: string }[]>>;
}

interface CatalogDefinition {
  connector_type: string;
  title: string;
  description: string;
  credential_hint: string;
  fields: ConnectorField[];
  prerequisites: Omit<ConnectorPrerequisite, "ready">[];
}

const CATALOG: CatalogDefinition[] = [
  {
    connector_type: "slack-channel",
    title: "Slack",
    description:
      "Install by channel. The kernel pulls that channel after install and keeps pulling while enabled.",
    credential_hint: "REGENIC_SLACK_TOKEN",
    fields: [
      {
        key: "channel_id",
        label: "Channel ID",
        required: true,
        placeholder: "C01234567",
      },
      {
        key: "channel_name",
        label: "Channel name",
        required: false,
        placeholder: "Optional, display only",
      },
    ],
    prerequisites: [
      {
        kind: "env",
        key: "REGENIC_SLACK_TOKEN",
        label: "Local Slack token",
        required: true,
        hint: "Set REGENIC_SLACK_TOKEN (bot token from your Slack app) before starting the desktop. The form does not take it.",
      },
    ],
  },
  {
    connector_type: "dsh-session",
    title: "DSH",
    description:
      "One install talks to dsh web (local loopback, or REGENIC_DSH_BASE_URL on a hosted API). The kernel pulls every session after install; set a Session ID to follow only that one.",
    credential_hint: "REGENIC_DSH_TOKEN (web, optional)",
    fields: [
      {
        key: "transport",
        label: "Transport",
        required: true,
        default: "web",
        options: [
          { value: "web", label: "Web" },
          { value: "cli", label: "CLI" },
        ],
      },
      {
        key: "session_id",
        label: "Session ID",
        required: false,
        placeholder: "Leave empty to sync all sessions",
        visible_when: { field: "transport", value: "web" },
      },
      {
        key: "base_url",
        label: "Base URL",
        required: false,
        default: "http://127.0.0.1:3080",
        placeholder: "Loopback only (127.0.0.1 / localhost)",
        visible_when: { field: "transport", value: "web" },
      },
      {
        key: "mailbox",
        label: "Mailbox",
        required: false,
        placeholder: "CLI mode; defaults to the install ID",
        visible_when: { field: "transport", value: "cli" },
      },
    ],
    prerequisites: [
      {
        kind: "local_service",
        key: "dsh-web",
        label: "Local dsh web",
        required: true,
        hint: "dsh must work in your terminal. Then start dsh web --port 3080.",
        visible_when: { field: "transport", value: "web" },
      },
      {
        kind: "local_service",
        key: "dsh-cli",
        label: "Local dsh",
        required: true,
        hint: "dsh must work in your terminal.",
        visible_when: { field: "transport", value: "cli" },
      },
      {
        kind: "env",
        key: "REGENIC_DSH_TOKEN",
        label: "DSH web token",
        required: false,
        hint: "Set REGENIC_DSH_TOKEN before starting the desktop if dsh web requires a Bearer token.",
        visible_when: { field: "transport", value: "web" },
      },
    ],
  },
  {
    connector_type: "feishu-chat",
    title: "Feishu",
    description:
      "Install once. Default is every group and every direct message you can see. Change the set later on the installed row. Replies go back through lark-cli.",
    credential_hint: "lark-cli (user login)",
    fields: [
      {
        key: "selection",
        label: "Sync set",
        required: true,
        default: "all",
        options: [
          { value: "all", label: "All conversations of the kinds below" },
          { value: "pick", label: "Choose conversations" },
        ],
      },
      {
        key: "kinds",
        label: "Kinds",
        required: true,
        multiple: true,
        default: "group,p2p",
        options: [
          { value: "group", label: "All groups" },
          { value: "p2p", label: "All direct messages" },
        ],
        visible_when: { field: "selection", value: "all" },
      },
      {
        key: "chat_ids",
        label: "Conversations",
        required: true,
        multiple: true,
        placeholder: "Sign in with lark-cli to load groups and direct messages",
        visible_when: { field: "selection", value: "pick" },
      },
    ],
    prerequisites: [
      {
        kind: "local_service",
        key: "lark-cli",
        label: "lark-cli",
        required: true,
        hint: "Not installed. Run: npx @larksuite/cli@latest install. Docs: https://github.com/larksuite/cli",
      },
    ],
  },
];

export function connectorCatalog(
  installations: EngineInstallationView[],
  readiness: CatalogReadiness = {},
): ConnectorCatalogItem[] {
  const env = readiness.env ?? process.env;
  return CATALOG.map((item) => {
    const definition = catalogDefinitionForEnv(item, env);
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
  last_attempt: IngestAttempt | null;
}

export function toInstallationView(
  installation: ConnectorInstallation,
  lastAttempt: IngestAttempt | null,
  drivers: { get(connectorType: string): ChannelDriver | undefined },
): EngineInstallationView {
  const { label, detail } = connectorPresentation(installation);
  const driver = drivers.get(installation.connector_type);
  const capabilities = driver?.capabilities(installation) ?? {
    sync: false,
    reply: false,
    create: false,
  };
  const enabled = installation.status === "enabled";
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
    last_attempt: lastAttempt,
  };
}

function connectorPresentation(installation: ConnectorInstallation): {
  label: string;
  detail: string | null;
} {
  const config = installation.config;
  if (installation.connector_type === "slack-channel") {
    const channelName = configString(config, "channel_name");
    const channelId = configString(config, "channel_id");
    return {
      label: channelName ?? channelId ?? installation.id,
      detail: channelName && channelId ? channelId : null,
    };
  }
  if (installation.connector_type === "dsh-session") {
    const hosted = Boolean(process.env.REGENIC_DSH_BASE_URL?.trim());
    const transport = hosted ? "web" : configString(config, "transport");
    if (transport === "cli") {
      return {
        label: configString(config, "mailbox") ?? installation.id,
        detail: "cli",
      };
    }
    const sessionId = configString(config, "session_id");
    return {
      label: sessionId ?? "All sessions",
      detail: transport === "web" || hosted ? "web" : null,
    };
  }
  if (installation.connector_type === "feishu-chat") {
    const selection = configString(config, "selection");
    const chatIds = configStringList(config, "chat_ids");
    const chatName = configString(config, "chat_name");
    const chatId = configString(config, "chat_id");
    if (selection === "all" || (!selection && chatIds.length === 0 && !chatId)) {
      return { label: feishuAllLabel(config), detail: "cli" };
    }
    if (chatIds.length > 1) {
      return { label: `${chatIds.length} conversations`, detail: "cli" };
    }
    return {
      label: chatName ?? chatIds[0] ?? chatId ?? installation.id,
      detail: "cli",
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

function feishuAllLabel(config: Record<string, unknown>): string {
  const kinds = configStringList(config, "kinds");
  const groups = kinds.length === 0 || kinds.includes("group");
  const p2p = kinds.length === 0 || kinds.includes("p2p");
  if (groups && p2p) {
    return "All conversations";
  }
  if (p2p) {
    return "All direct messages";
  }
  return "All groups";
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

function configStringList(
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

export function matchesWhen(
  when: ConnectorFieldWhen | undefined,
  values: Record<string, string>,
): boolean {
  if (!when) {
    return true;
  }
  return (values[when.field] ?? "") === when.value;
}

function catalogDefinitionForEnv(
  item: CatalogDefinition,
  env: NodeJS.ProcessEnv,
): CatalogDefinition {
  if (item.connector_type !== "dsh-session" || !env.REGENIC_DSH_BASE_URL?.trim()) {
    return item;
  }
  return {
    ...item,
    description:
      "Hosted kernel talks to DSH over the cluster Service (REGENIC_DSH_BASE_URL). Leave Session ID empty to follow every session. Do not paste a public DSH URL.",
    fields: [
      {
        key: "session_id",
        label: "Session ID",
        required: false,
        placeholder: "Leave empty to sync all sessions",
      },
    ],
    prerequisites: [
      {
        kind: "local_service",
        key: "dsh-web",
        label: "Cluster DSH",
        required: true,
        hint: "Uses REGENIC_DSH_BASE_URL (cluster DNS, not a public URL)",
      },
      {
        kind: "env",
        key: "REGENIC_DSH_TOKEN",
        label: "DSH web token",
        required: false,
        hint: "Set REGENIC_DSH_TOKEN before starting the desktop if dsh web requires a Bearer token.",
      },
    ],
  };
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
