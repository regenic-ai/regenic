import { randomUUID } from "node:crypto";
import type { Host } from "@regenic/plugin-host";
import {
  ChannelDriverError,
  type ChannelDriver,
  type ConnectorInstallation,
  type ConnectorStream,
  type ConversationThread,
  type DeliveryReceipt,
  type JsonValue,
  type NewConnectorInstallation,
  type RegisteredEgress,
} from "@regenic/domain";
import { DshWebRpcClient, type DshFetch } from "./dsh-rpc-client";
import { DshSessionEgress } from "./dsh-session-egress";
import { DshSessionPollConnector } from "./dsh-session-poll-connector";
import {
  dshSessionKey,
  dshSessionPlugin,
  dshSessionPluginConfigFromInstallation,
  resolveEffectiveDshTransport,
} from "./plugin";
import { loopbackHttpUrl, resolveOperatorDshBaseUrl } from "./dsh-url";
import { probeDshCatalog } from "./probe";

export const dshSessionDriver: ChannelDriver = {
  connector_type: "dsh-session",
  source: "dsh",

  install(input): NewConnectorInstallation {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: "dsh-session",
      status: "enabled",
      config: dshInstallConfig(input.config, input.id),
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
      return { sync: true, reply: true, create: false, await_reply: true };
    }
    return { sync: true, reply: true, create: !pinned, await_reply: true };
  },

  canReply(installation) {
    return this.capabilities(installation).reply;
  },

  async createThread(installation, _host, env) {
    return createDshConversation(installation, env);
  },

  async resolveStreams(installation, host, env) {
    const transport = resolveEffectiveDshTransport(installation.config, env);
    if (transport === "cli") {
      return [await mountInstalled(host, installation, env)];
    }
    const client = dshWebRpcClient(installation, env);
    const pinned = configString(installation.config, "session_id");
    const sessionIds = pinned ? [pinned] : await client.listAllSessionIds();
    return sessionIds.map((sessionId) =>
      sessionStream(installation, client, sessionId),
    );
  },

  async resolveThreadStream(installation, thread, host, env) {
    const transport = resolveEffectiveDshTransport(installation.config, env);
    if (transport === "cli") {
      return mountInstalled(host, installation, env);
    }
    return sessionStream(installation, dshWebRpcClient(installation, env), thread.target);
  },

  async bindEgress(installation, thread, host, env) {
    const transport = resolveEffectiveDshTransport(installation.config, env);
    if (transport === "cli") {
      await mountInstalled(host, installation, env);
      const egress = host.get("egress").get(installation.id);
      if (!egress) {
        throw new ChannelDriverError("send_failed", "DSH egress adapter failed to mount");
      }
      return egress;
    }
    return new DshSessionEgress(dshWebRpcClient(installation, env), {
      installation_id: installation.id,
      session_id: thread.target,
    });
  },

  outboundId(thread: ConversationThread, receipt: DeliveryReceipt) {
    return `${thread.target}:out:${receipt.rpc_id ?? randomUUID()}`;
  },

  async probeCatalog({ env }) {
    return probeDshCatalog({ env });
  },
};

function sessionStream(
  installation: ConnectorInstallation,
  client: DshWebRpcClient,
  sessionId: string,
): ConnectorStream {
  return {
    stream_key: `session:${sessionId}`,
    connector: new DshSessionPollConnector(client, {
      connector_id: installation.id,
      org_id: installation.org_id,
      session_id: sessionId,
    }),
  };
}

async function mountInstalled(
  host: Host,
  installation: ConnectorInstallation,
  env: NodeJS.ProcessEnv,
): Promise<ConnectorStream> {
  if (!host.get("connectors").get(installation.id)) {
    await host.plugin(dshSessionPlugin, {
      ...dshSessionPluginConfigFromInstallation(installation, {
        env,
        access_token: env.REGENIC_DSH_TOKEN,
      }),
      command: "dsh",
      workdir: undefined,
      base_url: resolveDshWebBaseUrl(installation, env),
    });
  }
  const connector = host.get("connectors").get(installation.id);
  if (!connector) {
    throw new ChannelDriverError("sync_failed", "Connector failed to mount");
  }
  return {
    stream_key: `session:${dshSessionKey(installation.config, installation.id)}`,
    connector,
  };
}

export async function createDshConversation(
  installation: ConnectorInstallation,
  env: NodeJS.ProcessEnv,
  extras: { fetch?: DshFetch; access_token?: string } = {},
): Promise<ConversationThread> {
  if (!dshSessionDriver.capabilities(installation).create) {
    throw new ChannelDriverError(
      "unsupported_channel",
      "This DSH installation cannot create a conversation",
    );
  }
  const created = await dshWebRpcClient(installation, env, extras).sessionCreate();
  return { source: "dsh", target: created.sessionId };
}

export function dshWebRpcClient(
  installation: { config: Record<string, unknown> },
  env: NodeJS.ProcessEnv,
  extras: { fetch?: DshFetch; access_token?: string } = {},
): DshWebRpcClient {
  return new DshWebRpcClient({
    base_url: resolveDshWebBaseUrl(installation, env),
    access_token: extras.access_token ?? env.REGENIC_DSH_TOKEN,
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
