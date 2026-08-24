import type { Host } from "@regenic/plugin-host";
import {
  ChannelDriverError,
  type ChannelDriver,
  type ConnectorInstallation,
  type ConnectorStream,
  type ConversationThread,
  type JsonValue,
  type NewConnectorInstallation,
} from "@regenic/domain";
import { slackChannelPlugin } from "./plugin";

export const slackChannelDriver: ChannelDriver = {
  connector_type: "slack-channel",
  source: "slack",

  install(input): NewConnectorInstallation {
    const channelId = configString(input.config, "channel_id");
    if (!channelId) {
      throw new ChannelDriverError("invalid_config", "Slack install requires channel_id");
    }
    const channelName = configString(input.config, "channel_name");
    const config: Record<string, JsonValue> = { channel_id: channelId };
    if (channelName) {
      config.channel_name = channelName;
    }
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: "slack-channel",
      status: "enabled",
      config,
      credentials_ref: "env:REGENIC_SLACK_TOKEN",
      created_at: input.now,
    };
  },

  matchesThread(installation, thread) {
    return (
      thread.source === "slack" &&
      installation.status === "enabled" &&
      configString(installation.config, "channel_id") === thread.target
    );
  },

  ownsThread(installation, thread) {
    return this.matchesThread(installation, thread);
  },

  capabilities(installation) {
    return {
      sync: installation.status === "enabled",
      reply: false,
      create: false,
      list_title: "conversation",
    };
  },

  canReply() {
    return false;
  },

  async createThread() {
    throw new ChannelDriverError(
      "unsupported_channel",
      "Creating a Slack conversation is not available",
    );
  },

  async resolveStreams(installation, host, env) {
    return [await mountChannel(host, installation, env)];
  },

  async resolveThreadStream(installation, _thread, host, env) {
    return mountChannel(host, installation, env);
  },

  async bindEgress() {
    throw new ChannelDriverError(
      "unsupported_channel",
      "Sending back to Slack is not available yet",
    );
  },

  outboundId(thread: ConversationThread) {
    return `${thread.target}:out:local`;
  },

  async resolveConversationLabels(installation, threads) {
    const channelId = configString(installation.config, "channel_id");
    const channelName = configString(installation.config, "channel_name");
    const labels = new Map<string, string>();
    if (!channelId || !channelName) {
      return labels;
    }
    for (const thread of threads) {
      if (thread.source === "slack" && thread.target === channelId) {
        labels.set(`slack:${channelId}`, channelName);
      }
    }
    return labels;
  },
};

async function mountChannel(
  host: Host,
  installation: ConnectorInstallation,
  env: NodeJS.ProcessEnv,
): Promise<ConnectorStream> {
  const channelId = configString(installation.config, "channel_id");
  if (!channelId) {
    throw new ChannelDriverError("invalid_config", "Slack installation is missing channel_id");
  }
  if (!host.get("connectors").get(installation.id)) {
    const tokenEnv = slackTokenEnv(installation.credentials_ref);
    const token = env[tokenEnv];
    if (!token) {
      throw new ChannelDriverError(
        "missing_credentials",
        `Slack access token is missing from ${tokenEnv}`,
      );
    }
    await host.plugin(slackChannelPlugin, {
      installation_id: installation.id,
      org_id: installation.org_id,
      channel_id: channelId,
      channel_name: configString(installation.config, "channel_name"),
      access_token: token,
      endpoint: env.REGENIC_SLACK_API_ENDPOINT,
    });
  }
  const connector = host.get("connectors").get(installation.id);
  if (!connector) {
    throw new ChannelDriverError("sync_failed", "Connector failed to mount");
  }
  return {
    stream_key: `channel:${channelId}`,
    thread_id: `slack:${channelId}`,
    label: configString(installation.config, "channel_name") ?? channelId,
    connector,
  };
}

function slackTokenEnv(credentialsRef: string | undefined): string {
  if (!credentialsRef || credentialsRef === "env:REGENIC_SLACK_TOKEN") {
    return "REGENIC_SLACK_TOKEN";
  }
  throw new ChannelDriverError(
    "invalid_config",
    "Slack credentials_ref must be env:REGENIC_SLACK_TOKEN",
  );
}

function configString(
  config: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = config[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
