import {
  CONNECTOR_PROTOCOL,
  ChannelDriverError,
  type ConnectorHost,
  envCredentialsRef,
  readEnvCredential,
  requireConnectorStream,
  requireEnvCredentialName,
  type ChannelDriver,
  type ConnectorInstallation,
  type ConnectorStream,
  type JsonValue,
  type NewConnectorInstallation,
} from "@regenic/domain";
import { slackChannelPlugin } from "./plugin";

export const slackChannelDriver: ChannelDriver = {
  connector_type: "slack-channel",
  source: "slack",
  connector_protocol: CONNECTOR_PROTOCOL,

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
      credentials_ref: envCredentialsRef("REGENIC_SLACK_TOKEN"),
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

  async resolveStreams(installation, host, env) {
    return [await mountChannel(host, installation, env)];
  },

  async resolveThreadStream(installation, _thread, host, env) {
    return mountChannel(host, installation, env);
  },

  installCatalog() {
    return {
      title: "Slack",
      channel_label: "Slack",
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
          kind: "env" as const,
          key: "REGENIC_SLACK_TOKEN",
          label: "Local Slack token",
          required: true,
          hint: "Set REGENIC_SLACK_TOKEN (bot token from your Slack app) before starting the desktop. The form does not take it.",
        },
      ],
      setup_steps: [
        {
          title: "Create a Slack app and copy a bot token",
          href: "https://api.slack.com/apps",
        },
        {
          title: "Set REGENIC_SLACK_TOKEN, then fully quit and reopen the desktop",
          body: "The form does not take the token.",
        },
        {
          title: "Enter the channel ID",
          body: "Use a C… id. The channel name is optional display text.",
        },
      ],
    };
  },

  presentInstall(installation) {
    const channelName = configString(installation.config, "channel_name");
    const channelId = configString(installation.config, "channel_id");
    return {
      label: channelName ?? channelId ?? installation.id,
      detail: channelName && channelId ? channelId : null,
    };
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
  host: ConnectorHost,
  installation: ConnectorInstallation,
  env: NodeJS.ProcessEnv,
): Promise<ConnectorStream> {
  const channelId = configString(installation.config, "channel_id");
  if (!channelId) {
    throw new ChannelDriverError("invalid_config", "Slack installation is missing channel_id");
  }
  const streamKey = `channel:${channelId}`;
  if (!host.get("connectors").getStream(installation.id, streamKey)) {
    const tokenEnv = slackTokenEnv(installation.credentials_ref);
    const token = readEnvCredential(installation.credentials_ref, env, tokenEnv);
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
  return requireConnectorStream(host.get("connectors"), installation.id, streamKey);
}

function slackTokenEnv(credentialsRef: string | undefined): string {
  try {
    return requireEnvCredentialName(credentialsRef, "REGENIC_SLACK_TOKEN");
  } catch {
    throw new ChannelDriverError(
      "invalid_config",
      "Slack credentials_ref must be env:REGENIC_SLACK_TOKEN",
    );
  }
}

function configString(
  config: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = config[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
