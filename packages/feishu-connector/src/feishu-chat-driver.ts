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
} from "@regenic/domain";
import { FEISHU_SOURCE } from "./feishu-message";
import { feishuChatPlugin } from "./plugin";

export const feishuChatDriver: ChannelDriver = {
  connector_type: "feishu-chat",
  source: FEISHU_SOURCE,

  install(input): NewConnectorInstallation {
    const chatId = configString(input.config, "chat_id");
    if (!chatId) {
      throw new ChannelDriverError("invalid_config", "Feishu install requires chat_id");
    }
    const chatName = configString(input.config, "chat_name");
    const config: Record<string, JsonValue> = { chat_id: chatId };
    if (chatName) {
      config.chat_name = chatName;
    }
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: "feishu-chat",
      status: "enabled",
      config,
      created_at: input.now,
    };
  },

  matchesThread(installation, thread) {
    return (
      thread.source === FEISHU_SOURCE &&
      installation.status === "enabled" &&
      configString(installation.config, "chat_id") === thread.target
    );
  },

  ownsThread(installation, thread) {
    return this.matchesThread(installation, thread);
  },

  capabilities(installation) {
    if (installation.status !== "enabled") {
      return { sync: false, reply: false, create: false };
    }
    return { sync: true, reply: true, create: false };
  },

  canReply(installation) {
    return this.capabilities(installation).reply;
  },

  async createThread() {
    throw new ChannelDriverError(
      "unsupported_channel",
      "Creating a Feishu conversation is not available",
    );
  },

  async resolveStreams(installation, host, env) {
    return [await mountChat(host, installation, env)];
  },

  async resolveThreadStream(installation, _thread, host, env) {
    return mountChat(host, installation, env);
  },

  async bindEgress(installation, _thread, host, env) {
    await mountChat(host, installation, env);
    const egress = host.get("egress").get(installation.id);
    if (!egress) {
      throw new ChannelDriverError("send_failed", "Feishu egress adapter failed to mount");
    }
    return egress;
  },

  outboundId(thread: ConversationThread, receipt: DeliveryReceipt) {
    return `${thread.target}:out:${receipt.rpc_id ?? "local"}`;
  },
};

async function mountChat(
  host: Host,
  installation: ConnectorInstallation,
  env: NodeJS.ProcessEnv,
): Promise<ConnectorStream> {
  const chatId = configString(installation.config, "chat_id");
  if (!chatId) {
    throw new ChannelDriverError("invalid_config", "Feishu installation is missing chat_id");
  }
  if (!host.get("connectors").get(installation.id)) {
    await host.plugin(feishuChatPlugin, {
      installation_id: installation.id,
      org_id: installation.org_id,
      chat_id: chatId,
      chat_name: configString(installation.config, "chat_name"),
      command: env.REGENIC_LARK_CLI,
      env,
    });
  }
  const connector = host.get("connectors").get(installation.id);
  if (!connector) {
    throw new ChannelDriverError("sync_failed", "Connector failed to mount");
  }
  return { stream_key: `chat:${chatId}`, connector };
}

function configString(
  config: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = config[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
