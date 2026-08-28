import { randomUUID } from "node:crypto";
import type { Host } from "@regenic/plugin-host";
import {
  CONNECTOR_PROTOCOL,
  ChannelDriverError,
  envCredentialsRef,
  readEnvCredential,
  requireConnectorStream,
  type ChannelDriver,
  type ConnectorStream,
  type ConversationThread,
  type DeliveryReceipt,
  type JsonValue,
  type NewConnectorInstallation,
} from "@regenic/domain";
import {
  CURSOR_API_KEY_ENV,
  CursorApiError,
} from "./cursor-api-client";
import {
  cursorKeychainAccount,
  cursorKeychainRef,
  readCursorApiKey,
  writeCursorApiKey,
} from "./cursor-credentials";
import { isLocalCursorAgentId } from "./cursor-ids";
import {
  CURSOR_MODEL_OPTIONS,
  cursorLocalClient,
  DEFAULT_CURSOR_MODEL,
  type CursorLocalClient,
} from "./cursor-local-client";
import { CURSOR_SOURCE } from "./cursor-agent-poll-connector";
import {
  listCursorLocalAgents,
  rememberCursorAgentCwd,
} from "./cursor-local-cwd";
import { cursorAgentPlugin, cursorStreamKey } from "./plugin";
import { probeCursorCatalog } from "./probe";

export const cursorAgentDriver: ChannelDriver = {
  connector_type: "cursor-agent",
  source: CURSOR_SOURCE,
  connector_protocol: CONNECTOR_PROTOCOL,

  install(input): NewConnectorInstallation {
    const config = cursorInstallConfig(input.config);
    const pasted = configString(input.config, "api_key");
    if (pasted) {
      try {
        writeCursorApiKey(input.id, pasted);
      } catch (error) {
        throw new ChannelDriverError(
          "missing_credentials",
          error instanceof Error ? error.message : "Could not store the Cursor API key",
        );
      }
    }
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: "cursor-agent",
      status: "enabled",
      config,
      credentials_ref: pasted
        ? cursorKeychainRef(input.id)
        : envCredentialsRef(CURSOR_API_KEY_ENV),
      created_at: input.now,
    };
  },

  matchesThread(installation, thread) {
    return thread.source === CURSOR_SOURCE && installation.status === "enabled";
  },

  ownsThread() {
    return false;
  },

  capabilities(installation) {
    if (installation.status !== "enabled") {
      return { sync: false, reply: false, create: false };
    }
    return {
      sync: true,
      reply: true,
      create: true,
      await_reply: true,
      list_title: "prompt",
      create_with_task: true,
      hold_while_working: true,
    };
  },

  async createThread(installation, _host, env, options) {
    const text = options?.text?.trim();
    if (!text) {
      throw new ChannelDriverError(
        "invalid_config",
        "Opening a Cursor conversation needs the first task",
      );
    }
    try {
      const created = await cursorLocalClient().create({
        apiKey: await resolveCursorApiKey(installation, env),
        cwd:
          options?.cwd?.trim()
          || configString(installation.config, "cwd")
          || process.cwd(),
        model: cursorModel(installation.config),
        text,
      });
      return { source: CURSOR_SOURCE, target: created.agentId };
    } catch (error) {
      throw wrapCursorError(error, "send_failed");
    }
  },

  async resolveStreams(installation, host, env, options) {
    const fromInbox = [
      ...new Set(
        (options?.threads ?? [])
          .filter(
            (thread) =>
              thread.source === CURSOR_SOURCE &&
              this.matchesThread(installation, thread) &&
              isLocalCursorAgentId(thread.target),
          )
          .map((thread) => thread.target),
      ),
    ];
    const discovered = options?.discover === true
      ? discoverLocalAgents(installation.config)
      : [];
    const agentIds = [...new Set([...fromInbox, ...discovered])];
    return mountCursorAgents(host, installation, env, agentIds);
  },

  async resolveThreadStream(installation, thread, host, env) {
    const streams = await mountCursorAgents(host, installation, env, [thread.target]);
    return (
      streams[0] ??
      requireConnectorStream(
        host.get("connectors"),
        installation.id,
        cursorStreamKey(thread.target),
      )
    );
  },

  async bindEgress(installation, thread, host, env) {
    await this.resolveThreadStream(installation, thread, host, env);
    const egress = host.get("egress").get(
      installation.id,
      cursorStreamKey(thread.target),
    );
    if (!egress) {
      throw new ChannelDriverError("send_failed", "Cursor egress adapter failed to mount");
    }
    return egress;
  },

  outboundId(thread: ConversationThread, receipt: DeliveryReceipt) {
    return `${thread.target}:out:${receipt.rpc_id ?? randomUUID()}`;
  },

  installCatalog() {
    return {
      title: "Cursor",
      channel_label: "Cursor",
      description:
        "Open a local Cursor agent from the inbox. The first message creates the session. Paste an API key here; it is stored on this machine, not in connector settings.",
      credential_hint: "Paste CURSOR_API_KEY or set the env var",
      fields: [
        {
          key: "api_key",
          label: "Cursor API key",
          required: false,
          secret: true,
          placeholder: "Leave empty to use CURSOR_API_KEY or a saved key",
        },
        {
          key: "model",
          label: "Default model",
          required: true,
          default: DEFAULT_CURSOR_MODEL,
          options: [...CURSOR_MODEL_OPTIONS],
        },
        {
          key: "cwd",
          label: "Working directory",
          required: false,
          placeholder: "Defaults to the current workspace",
        },
      ],
      prerequisites: [
        {
          kind: "env" as const,
          key: CURSOR_API_KEY_ENV,
          label: "Cursor API key",
          required: false,
          hint: "Optional if you paste the key in the form.",
        },
      ],
    };
  },

  presentInstall(installation) {
    return {
      label: configString(installation.config, "cwd") ?? "Local agent",
      detail: cursorModel(installation.config),
    };
  },

  async probeCatalog({ env }) {
    return probeCursorCatalog({ env });
  },
};

export async function mountCursorAgents(
  host: Host,
  installation: {
    id: string;
    org_id: string;
    config: Record<string, unknown>;
    credentials_ref?: string;
  },
  env: NodeJS.ProcessEnv,
  agentIds: string[],
  extras: {
    api_key?: string;
    local?: CursorLocalClient;
  } = {},
): Promise<ConnectorStream[]> {
  if (agentIds.length === 0) {
    return [];
  }
  const registry = host.get("connectors");
  const existing = new Set(
    registry.listStreams(installation.id).map((stream) => stream.stream_key),
  );
  const missing = agentIds.filter((agentId) => !existing.has(cursorStreamKey(agentId)));
  if (missing.length > 0) {
    const apiKey = await resolveCursorApiKey(installation, env, extras);
    await host.plugin(cursorAgentPlugin, {
      installation_id: installation.id,
      org_id: installation.org_id,
      api_key: apiKey,
      model: cursorModel(installation.config),
      cwd: configString(installation.config, "cwd") ?? process.cwd(),
      agents: missing.map((id) => ({ id })),
      local: extras.local,
    });
  }
  const wanted = new Set(agentIds.map((agentId) => cursorStreamKey(agentId)));
  return registry
    .listStreams(installation.id)
    .filter((stream) => wanted.has(stream.stream_key));
}

export async function resolveCursorApiKey(
  installation: { id?: string; credentials_ref?: string },
  env: NodeJS.ProcessEnv,
  extras: { api_key?: string } = {},
): Promise<string> {
  if (extras.api_key?.trim()) {
    return extras.api_key.trim();
  }
  const fromEnv = readEnvCredential(
    installation.credentials_ref,
    env,
    CURSOR_API_KEY_ENV,
  );
  if (fromEnv) {
    return fromEnv;
  }
  const account =
    cursorKeychainAccount(installation.credentials_ref) ?? installation.id;
  const stored = account ? await readCursorApiKey(account) : undefined;
  if (stored) {
    return stored;
  }
  throw new ChannelDriverError(
    "missing_credentials",
    "Cursor API key is missing. Paste it when installing, or set CURSOR_API_KEY.",
  );
}

function discoverLocalAgents(config: Record<string, unknown>): string[] {
  const cwd = configString(config, "cwd");
  const local = listCursorLocalAgents(cwd ? { cwd } : undefined);
  for (const agent of local) {
    rememberCursorAgentCwd(agent.agentId, agent.cwd);
  }
  return local.map((agent) => agent.agentId);
}

function cursorModel(config: Record<string, unknown>): string {
  return configString(config, "model") ?? DEFAULT_CURSOR_MODEL;
}

function cursorInstallConfig(input: Record<string, unknown>): Record<string, JsonValue> {
  const config: Record<string, JsonValue> = {
    model: configString(input, "model") ?? DEFAULT_CURSOR_MODEL,
  };
  const cwd = configString(input, "cwd");
  if (cwd) {
    config.cwd = cwd;
  }
  return config;
}

function wrapCursorError(
  error: unknown,
  fallback: "sync_failed" | "send_failed",
): ChannelDriverError {
  if (error instanceof ChannelDriverError) {
    return error;
  }
  if (error instanceof CursorApiError) {
    const code =
      error.code === "missing_credentials" ? "missing_credentials" : fallback;
    return new ChannelDriverError(code, error.message);
  }
  return new ChannelDriverError(
    fallback,
    error instanceof Error ? error.message : "Cursor request failed",
  );
}

function configString(
  config: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = config[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
