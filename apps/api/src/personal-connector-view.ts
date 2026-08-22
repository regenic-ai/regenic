import type {
  ConnectorInstallation,
  ConnectorInstallationStatus,
  IngestAttempt,
} from "@regenic/domain";

const SYNCABLE_TYPES = new Set(["slack-channel", "dsh-session"]);

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

export interface CatalogReadiness {
  env?: NodeJS.ProcessEnv;
  services?: Record<string, boolean>;
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
        hint: "Set REGENIC_SLACK_TOKEN in the environment. It is not stored or shown in the form.",
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
        hint: "Start dsh web --port 3080 first",
        visible_when: { field: "transport", value: "web" },
      },
      {
        kind: "env",
        key: "REGENIC_DSH_TOKEN",
        label: "DSH web token",
        required: false,
        hint: "Only if dsh web requires a Bearer token",
        visible_when: { field: "transport", value: "web" },
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
    const prerequisites = definition.prerequisites.map((prerequisite) => ({
      ...prerequisite,
      ready: prerequisiteReady(prerequisite, env, readiness.services),
    }));
    const requiredVisible = prerequisites.filter(
      (prerequisite) =>
        prerequisite.required &&
        matchesWhen(prerequisite.visible_when, defaults),
    );
    return {
      ...definition,
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
  syncable: boolean;
  last_attempt: IngestAttempt | null;
}

export function toInstallationView(
  installation: ConnectorInstallation,
  lastAttempt: IngestAttempt | null,
  registered: { has(connectorType: string): boolean } = SYNCABLE_TYPES,
): EngineInstallationView {
  const { label, detail } = connectorPresentation(installation);
  return {
    id: installation.id,
    connector_type: installation.connector_type,
    status: installation.status,
    label,
    detail,
    syncable:
      installation.status === "enabled" &&
      registered.has(installation.connector_type),
    last_attempt: lastAttempt,
  };
}

export function isSyncableType(connectorType: string): boolean {
  return SYNCABLE_TYPES.has(connectorType);
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
  return { label: installation.id, detail: null };
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
        hint: "Only if dsh web requires a Bearer token",
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

function prerequisiteReady(
  prerequisite: Omit<ConnectorPrerequisite, "ready">,
  env: NodeJS.ProcessEnv,
  services: Record<string, boolean> | undefined,
): boolean {
  if (prerequisite.kind === "env") {
    const value = env[prerequisite.key];
    return typeof value === "string" && value.trim().length > 0;
  }
  return services?.[prerequisite.key] === true;
}
