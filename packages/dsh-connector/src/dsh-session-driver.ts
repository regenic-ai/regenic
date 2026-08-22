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
import { DshWebRpcClient } from "./dsh-rpc-client";
import { DshSessionEgress } from "./dsh-session-egress";
import { DshSessionPollConnector } from "./dsh-session-poll-connector";
import {
  dshSessionKey,
  dshSessionPlugin,
  dshSessionPluginConfigFromInstallation,
} from "./plugin";

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
    const transport = configString(installation.config, "transport") ?? "web";
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
    const transport = configString(installation.config, "transport") ?? "web";
    return (
      transport === "cli" &&
      configString(installation.config, "mailbox") === thread.target
    );
  },

  canReply(installation) {
    return installation.status === "enabled";
  },

  async resolveStreams(installation, host, env) {
    const transport = configString(installation.config, "transport") ?? "web";
    if (transport === "cli") {
      return [await mountInstalled(host, installation, env)];
    }
    const client = webClient(installation, env);
    const pinned = configString(installation.config, "session_id");
    const sessionIds = pinned ? [pinned] : await client.listAllSessionIds();
    if (sessionIds.length === 0) {
      throw new ChannelDriverError("sync_failed", "DSH web has no sessions to sync");
    }
    return sessionIds.map((sessionId) =>
      sessionStream(installation, client, sessionId),
    );
  },

  async resolveThreadStream(installation, thread, host, env) {
    const transport = configString(installation.config, "transport") ?? "web";
    if (transport === "cli") {
      return mountInstalled(host, installation, env);
    }
    return sessionStream(installation, webClient(installation, env), thread.target);
  },

  async bindEgress(installation, thread, host, env) {
    const transport = configString(installation.config, "transport") ?? "web";
    if (transport === "cli") {
      await mountInstalled(host, installation, env);
      const egress = host.get("egress").get(installation.id);
      if (!egress) {
        throw new ChannelDriverError("send_failed", "DSH egress adapter failed to mount");
      }
      return egress;
    }
    return new DshSessionEgress(webClient(installation, env), {
      installation_id: installation.id,
      session_id: thread.target,
    });
  },

  outboundId(thread: ConversationThread, receipt: DeliveryReceipt) {
    return `${thread.target}:out:${receipt.rpc_id ?? randomUUID()}`;
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
      base_url: loopbackHttpUrl(
        configString(installation.config, "base_url") ?? "http://127.0.0.1:3080",
      ),
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

function webClient(
  installation: ConnectorInstallation,
  env: NodeJS.ProcessEnv,
): DshWebRpcClient {
  return new DshWebRpcClient({
    base_url: loopbackHttpUrl(
      configString(installation.config, "base_url") ?? "http://127.0.0.1:3080",
    ),
    access_token: env.REGENIC_DSH_TOKEN,
  });
}

function dshInstallConfig(
  input: Record<string, unknown>,
  id: string,
): Record<string, JsonValue> {
  const transport = configString(input, "transport") ?? "web";
  if (transport !== "web" && transport !== "cli") {
    throw new ChannelDriverError("invalid_config", "DSH transport must be web or cli");
  }
  if (transport === "web") {
    const config: Record<string, JsonValue> = {
      transport,
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
    transport,
    mailbox: configString(input, "mailbox") ?? id,
  };
}

function loopbackHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ChannelDriverError(
      "invalid_config",
      "DSH base_url must be a loopback http(s) URL",
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    (host !== "127.0.0.1" && host !== "localhost" && host !== "::1")
  ) {
    throw new ChannelDriverError(
      "invalid_config",
      "DSH base_url must be a loopback http(s) URL",
    );
  }
  return parsed.toString();
}

function configString(
  config: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = config[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
