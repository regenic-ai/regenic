import { randomUUID } from "node:crypto";
import {
  CONNECTOR_PROTOCOL,
  ChannelDriverError,
  envCredentialsRef,
  readEnvCredential,
  requireConnectorStream,
  type ChannelDriver,
  type ConnectorHost,
  type ConnectorInstallation,
  type ConnectorStream,
  type ConversationThread,
  type DeliveryReceipt,
  type JsonValue,
  type NewConnectorInstallation,
  type PromptAnswer,
  type SyncSource,
} from "@regenic/domain";
import { DshWebRpcClient, type DshFetch } from "./dsh-rpc-client";
import {
  dshPromptStoreFor,
  dshRespondValue,
  parseDshPromptId,
} from "./dsh-prompt-store";
import {
  dshSessionKey,
  dshSessionPlugin,
  dshSessionPluginConfigFromInstallation,
  dshStreamKey,
  resolveEffectiveDshTransport,
} from "./plugin";
import { loopbackHttpUrl, resolveOperatorDshBaseUrl } from "./dsh-url";
import { dshLocaleTables } from "./locales";
import { probeDshCatalog } from "./probe";
import {
  createDshSessionSyncSource,
  createDshWebSyncSource,
} from "./dsh-sync-source";

export const dshSessionDriver: ChannelDriver = {
  connector_type: "dsh-session",
  source: "dsh",
  connector_protocol: CONNECTOR_PROTOCOL,

  install(input): NewConnectorInstallation {
    const config = dshInstallConfig(input.config, input.id);
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: "dsh-session",
      status: "enabled",
      config,
      ...(config.transport === "web"
        ? { credentials_ref: envCredentialsRef("REGENIC_DSH_TOKEN") }
        : {}),
      created_at: input.now,
    };
  },

  matchesThread(installation, thread) {
    if (thread.source !== "dsh" || installation.status !== "enabled") {
      return false;
    }
    const pinned = configString(installation.config, "session_id");
    const mailbox = configString(installation.config, "mailbox");
    const transport = resolveEffectiveDshTransport(installation.config);
    if (pinned) {
      return pinned === thread.target;
    }
    if (transport === "cli") {
      return mailbox === thread.target;
    }
    return true;
  },

  ownsThread(installation, thread) {
    if (!this.matchesThread(installation, thread)) {
      return false;
    }
    const pinned = configString(installation.config, "session_id");
    if (pinned) {
      return pinned === thread.target;
    }
    const transport = resolveEffectiveDshTransport(installation.config);
    return (
      transport === "cli" &&
      configString(installation.config, "mailbox") === thread.target
    );
  },

  capabilities(installation) {
    if (installation.status !== "enabled") {
      return { sync: false, reply: false, create: false };
    }
    const transport = resolveEffectiveDshTransport(installation.config);
    const pinned = configString(installation.config, "session_id");
    if (transport === "cli") {
      return {
        sync: true,
        reply: true,
        create: false,
        await_reply: true,
        list_title: "prompt",
      };
    }
    return {
      sync: true,
      reply: true,
      create: !pinned,
      await_reply: true,
      list_title: "prompt",
      prompts: true,
    };
  },

  async createThread(installation, _host, env, options) {
    return createDshConversation(installation, env, { cwd: options?.cwd });
  },

  async resolveStreams(installation, host, env, options) {
    const transport = resolveEffectiveDshTransport(installation.config, env);
    if (transport === "cli") {
      return [await mountInstalled(host, installation, env)];
    }
    const pinned = configString(installation.config, "session_id");
    if (pinned) {
      return mountDshSessions(host, installation, env, [pinned]);
    }
    const sessionIds = [
      ...new Set(
        (options?.threads ?? [])
          .filter(
            (thread) =>
              thread.source === "dsh" && this.matchesThread(installation, thread),
          )
          .map((thread) => thread.target),
      ),
    ];
    if (sessionIds.length > 0) {
      return mountDshSessions(host, installation, env, sessionIds);
    }
    if (!options?.discover) {
      return [];
    }
    const listed = await dshWebRpcClient(installation, env).listAllSessionIds();
    return mountDshSessions(host, installation, env, listed);
  },

  async bindSyncSource(installation, _host, env): Promise<SyncSource> {
    const transport = resolveEffectiveDshTransport(installation.config, env);
    if (transport === "cli") {
      return createDshSessionSyncSource(
        dshSessionKey(installation.config, installation.id),
      );
    }
    const pinned = configString(installation.config, "session_id");
    if (pinned) {
      return createDshSessionSyncSource(pinned);
    }
    return createDshWebSyncSource(dshWebRpcClient(installation, env));
  },

  async resolveThreadStream(installation, thread, host, env) {
    const transport = resolveEffectiveDshTransport(installation.config, env);
    if (transport === "cli") {
      return mountInstalled(host, installation, env);
    }
    const streams = await mountDshSessions(host, installation, env, [thread.target]);
    return streams[0] ?? requireConnectorStream(
      host.get("connectors"),
      installation.id,
      dshStreamKey(thread.target),
    );
  },

  async bindEgress(installation, thread, host, env) {
    await this.resolveThreadStream(installation, thread, host, env);
    const egress = host.get("egress").get(
      installation.id,
      dshStreamKey(thread.target),
    );
    if (!egress) {
      throw new ChannelDriverError("send_failed", "DSH egress adapter failed to mount");
    }
    return egress;
  },

  outboundId(thread: ConversationThread, receipt: DeliveryReceipt) {
    return `${thread.target}:out:${receipt.rpc_id ?? randomUUID()}`;
  },

  locales() {
    return dshLocaleTables;
  },

  installCatalog(input = {}) {
    const env = input.env ?? process.env;
    if (env.REGENIC_DSH_BASE_URL?.trim()) {
      return {
        title: "catalog.title",
        channel_label: "catalog.channelLabel",
        description: "catalog.descriptionHosted",
        credential_hint: "catalog.credentialHint",
        fields: [
          {
            key: "session_id",
            label: "field.sessionId",
            required: false,
            placeholder: "field.sessionId.placeholder",
          },
        ],
        prerequisites: [
          {
            kind: "local_service" as const,
            key: "dsh-web",
            label: "prereq.cluster",
            required: false,
            hint: "prereq.cluster.hint",
          },
          {
            kind: "env" as const,
            key: "REGENIC_DSH_TOKEN",
            label: "prereq.token",
            required: false,
            hint: "prereq.token.hint",
          },
        ],
        setup_steps: [
          {
            title: "setup.clusterUrl.title",
            body: "setup.clusterUrl.body",
          },
          {
            title: "setup.token.title",
            body: "setup.token.body",
          },
          {
            title: "setup.allSessions.title",
          },
        ],
      };
    }
    return {
      title: "catalog.title",
      channel_label: "catalog.channelLabel",
      description: "catalog.description",
      credential_hint: "catalog.credentialHint",
      fields: [
        {
          key: "transport",
          label: "field.transport",
          required: true,
          default: "web",
          options: [
            { value: "web", label: "option.transport.web" },
            { value: "cli", label: "option.transport.cli" },
          ],
        },
        {
          key: "session_id",
          label: "field.sessionId",
          required: false,
          placeholder: "field.sessionId.placeholder",
          visible_when: { field: "transport", value: "web" },
        },
        {
          key: "base_url",
          label: "field.baseUrl",
          required: false,
          default: "http://127.0.0.1:3080",
          placeholder: "field.baseUrl.placeholder",
          visible_when: { field: "transport", value: "web" },
        },
        {
          key: "mailbox",
          label: "field.mailbox",
          required: false,
          placeholder: "field.mailbox.placeholder",
          visible_when: { field: "transport", value: "cli" },
        },
      ],
      prerequisites: [
        {
          kind: "local_service" as const,
          key: "dsh-web",
          label: "prereq.dshWeb",
          required: false,
          hint: "prereq.dshWeb.hint",
          visible_when: { field: "transport", value: "web" },
        },
        {
          kind: "local_service" as const,
          key: "dsh-cli",
          label: "prereq.dshCli",
          required: true,
          hint: "prereq.dshCli.hint",
          visible_when: { field: "transport", value: "cli" },
        },
        {
          kind: "env" as const,
          key: "REGENIC_DSH_TOKEN",
          label: "prereq.token",
          required: false,
          hint: "prereq.token.hint",
          visible_when: { field: "transport", value: "web" },
        },
      ],
      setup_steps: [
        {
          title: "setup.install.title",
          body: "setup.install.body",
        },
        {
          title: "setup.web.title",
          command: "dsh web --port 3080",
          visible_when: { field: "transport", value: "web" },
        },
        {
          title: "setup.token.title",
          body: "setup.token.body",
          visible_when: { field: "transport", value: "web" },
        },
        {
          title: "setup.allSessions.title",
          visible_when: { field: "transport", value: "web" },
        },
        {
          title: "setup.mailbox.title",
          body: "setup.mailbox.body",
          visible_when: { field: "transport", value: "cli" },
        },
      ],
    };
  },

  presentInstall(installation, input = {}) {
    const env = input.env ?? process.env;
    const hosted = Boolean(env.REGENIC_DSH_BASE_URL?.trim());
    const transport = hosted
      ? "web"
      : resolveEffectiveDshTransport(installation.config, env);
    if (transport === "cli") {
      const mailbox = configString(installation.config, "mailbox");
      return {
        label: { literal: mailbox ?? installation.id },
        detail: { literal: "cli" },
      };
    }
    const sessionId = configString(installation.config, "session_id");
    return {
      label: sessionId ? { literal: sessionId } : "present.allSessions",
      detail: transport === "web" || hosted ? { literal: "web" } : null,
    };
  },

  async probeCatalog({ env }) {
    return probeDshCatalog({ env });
  },

  async listPrompts(installation, thread) {
    if (!this.capabilities(installation).prompts) {
      return [];
    }
    return dshPromptStoreFor(installation.id).list(thread.target);
  },

  async answerPrompt(installation, thread, answer, _host, env) {
    return answerDshPrompt(installation, thread, answer, env);
  },

  surfaceGeneration(installation) {
    if (!this.capabilities(installation).prompts) {
      return "";
    }
    return `dsh:${installation.id}:${dshPromptStoreFor(installation.id).generation()}`;
  },
};

export async function answerDshPrompt(
  installation: { id: string; config: Record<string, unknown> },
  thread: ConversationThread,
  answer: PromptAnswer,
  env: NodeJS.ProcessEnv,
  extras: { fetch?: DshFetch; access_token?: string } = {},
): Promise<{ accepted: boolean }> {
  const parsed = parseDshPromptId(answer.prompt_id);
  if (!parsed) {
    throw new ChannelDriverError("invalid_config", "DSH prompt_id is invalid");
  }
  const store = dshPromptStoreFor(installation.id);
  const receipt = await dshWebRpcClient(installation, env, extras).respond({
    rpc_id: parsed.rpcId,
    value: dshRespondValue(thread.target, parsed, answer),
  });
  if (receipt.accepted || receipt.reason === "not-pending") {
    store.remove(thread.target, answer.prompt_id);
    return { accepted: true };
  }
  throw new ChannelDriverError(
    "send_failed",
    receipt.reason ?? "DSH rejected the prompt answer",
  );
}

function dshAccessToken(
  installation: { credentials_ref?: string },
  env: NodeJS.ProcessEnv,
  extras: { access_token?: string } = {},
): string | undefined {
  return (
    extras.access_token ??
    readEnvCredential(installation.credentials_ref, env, "REGENIC_DSH_TOKEN")
  );
}

export async function mountDshSessions(
  host: ConnectorHost,
  installation: {
    id: string;
    org_id: string;
    config: Record<string, unknown>;
    credentials_ref?: string;
  },
  env: NodeJS.ProcessEnv,
  sessionIds: string[],
  extras: { fetch?: DshFetch; access_token?: string } = {},
): Promise<ConnectorStream[]> {
  if (sessionIds.length === 0) {
    return [];
  }
  const registry = host.get("connectors");
  const existing = new Set(
    registry.listStreams(installation.id).map((stream) => stream.stream_key),
  );
  const missing = sessionIds.filter(
    (sessionId) => !existing.has(dshStreamKey(sessionId)),
  );
  if (missing.length > 0) {
    const pluginConfig = dshSessionPluginConfigFromInstallation(installation, {
      env,
      access_token: dshAccessToken(installation, env, extras),
      fetch: extras.fetch,
    });
    if (pluginConfig.transport === "web" && !pluginConfig.base_url) {
      pluginConfig.base_url = resolveDshWebBaseUrl(installation, env);
    }
    await host.plugin(dshSessionPlugin, {
      ...pluginConfig,
      session_ids: missing,
    });
  }
  const wanted = new Set(sessionIds.map((sessionId) => dshStreamKey(sessionId)));
  return registry
    .listStreams(installation.id)
    .filter((stream) => wanted.has(stream.stream_key));
}

async function mountInstalled(
  host: ConnectorHost,
  installation: ConnectorInstallation,
  env: NodeJS.ProcessEnv,
): Promise<ConnectorStream> {
  const sessionId = dshSessionKey(installation.config, installation.id);
  const streams = await mountDshSessions(host, installation, env, [sessionId]);
  return (
    streams[0] ??
    requireConnectorStream(
      host.get("connectors"),
      installation.id,
      dshStreamKey(sessionId),
    )
  );
}

export async function createDshConversation(
  installation: ConnectorInstallation,
  env: NodeJS.ProcessEnv,
  extras: { fetch?: DshFetch; access_token?: string; cwd?: string } = {},
): Promise<ConversationThread> {
  if (!dshSessionDriver.capabilities(installation).create) {
    throw new ChannelDriverError(
      "unsupported_channel",
      "This DSH installation cannot create a conversation",
    );
  }
  const created = await dshWebRpcClient(installation, env, extras).sessionCreate(
    extras.cwd ? { cwd: extras.cwd } : {},
  );
  return { source: "dsh", target: created.sessionId };
}

export function dshWebRpcClient(
  installation: { config: Record<string, unknown>; credentials_ref?: string },
  env: NodeJS.ProcessEnv,
  extras: { fetch?: DshFetch; access_token?: string } = {},
): DshWebRpcClient {
  return new DshWebRpcClient({
    base_url: resolveDshWebBaseUrl(installation, env),
    access_token: dshAccessToken(installation, env, extras),
    fetch: extras.fetch,
  });
}

function resolveDshWebBaseUrl(
  installation: { config: Record<string, unknown> },
  env: NodeJS.ProcessEnv,
): string {
  return (
    resolveOperatorDshBaseUrl(env)
    ?? loopbackHttpUrl(
      configString(installation.config, "base_url") ?? "http://127.0.0.1:3080",
    )
  );
}

function dshInstallConfig(
  input: Record<string, unknown>,
  id: string,
): Record<string, JsonValue> {
  const requested = configString(input, "transport") ?? "web";
  if (requested !== "web" && requested !== "cli") {
    throw new ChannelDriverError("invalid_config", "DSH transport must be web or cli");
  }
  const operatorUrl = resolveOperatorDshBaseUrl();
  if (operatorUrl) {
    const config: Record<string, JsonValue> = { transport: "web" };
    const sessionId = configString(input, "session_id");
    if (sessionId) {
      config.session_id = sessionId;
    }
    return config;
  }
  if (requested === "web") {
    const config: Record<string, JsonValue> = {
      transport: requested,
      base_url: loopbackHttpUrl(
        configString(input, "base_url") ?? "http://127.0.0.1:3080",
      ),
    };
    const sessionId = configString(input, "session_id");
    if (sessionId) {
      config.session_id = sessionId;
    }
    return config;
  }
  return {
    transport: requested,
    mailbox: configString(input, "mailbox") ?? id,
  };
}

function configString(
  config: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = config[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
