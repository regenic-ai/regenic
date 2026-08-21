import type {
  ConnectorInstallation,
  ConnectorInstallationStatus,
  IngestAttempt,
} from "@regenic/domain";

const SYNCABLE_TYPES = new Set(["slack-channel", "dsh-session"]);

export interface ConnectorField {
  key: string;
  label: string;
  required: boolean;
  placeholder?: string;
  default?: string;
  options?: { value: string; label: string }[];
}

export interface ConnectorCatalogItem {
  connector_type: string;
  title: string;
  description: string;
  credential_hint: string;
  installed: boolean;
  instance_count: number;
  fields: ConnectorField[];
}

const CATALOG: Omit<
  ConnectorCatalogItem,
  "installed" | "instance_count"
>[] = [
  {
    connector_type: "slack-channel",
    title: "Slack",
    description: "同步指定频道。Token 只读本机环境变量，不写入库。",
    credential_hint: "REGENIC_SLACK_TOKEN",
    fields: [
      {
        key: "channel_id",
        label: "频道 ID",
        required: true,
        placeholder: "C01234567",
      },
      {
        key: "channel_name",
        label: "频道名",
        required: false,
        placeholder: "可选，仅展示",
      },
    ],
  },
  {
    connector_type: "dsh-session",
    title: "DSH",
    description: "同步 DSH session。Web 用本机 token，CLI 走本机 dsh 命令。",
    credential_hint: "REGENIC_DSH_TOKEN（web）",
    fields: [
      {
        key: "transport",
        label: "传输",
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
        placeholder: "web 模式必填",
      },
      {
        key: "base_url",
        label: "Base URL",
        required: false,
        default: "http://127.0.0.1:3080",
        placeholder: "仅本机 127.0.0.1 / localhost",
      },
      {
        key: "mailbox",
        label: "Mailbox",
        required: false,
        placeholder: "CLI 模式，默认同安装 ID",
      },
    ],
  },
];

export function connectorCatalog(
  installations: EngineInstallationView[],
): ConnectorCatalogItem[] {
  return CATALOG.map((item) => {
    const instanceCount = installations.filter(
      (installation) => installation.connector_type === item.connector_type,
    ).length;
    return {
      ...item,
      installed: instanceCount > 0,
      instance_count: instanceCount,
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
      SYNCABLE_TYPES.has(installation.connector_type),
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
    const session =
      configString(config, "session_id") ??
      configString(config, "mailbox") ??
      installation.id;
    const transport = configString(config, "transport");
    return {
      label: session,
      detail: transport === "web" || transport === "cli" ? transport : null,
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
