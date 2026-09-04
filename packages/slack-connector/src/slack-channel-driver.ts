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
  type SyncSource,
} from "@regenic/domain";
import { slackLocaleTables } from "./locales";
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
      hydrate_on_open: true,
    };
  },

  async resolveStreams(installation, host, env) {
    return [await mountChannel(host, installation, env)];
  },

  async bindSyncSource(installation): Promise<SyncSource> {
    const channelId = configString(installation.config, "channel_id");
    if (!channelId) {
      throw new ChannelDriverError(
        "invalid_config",
        "Slack installation is missing channel_id",
      );
    }
    const channelName = configString(installation.config, "channel_name");
    return {
      async listDirectory() {
        return {
          members: [
            {
              stream_key: `channel:${channelId}`,
              thread_id: `slack:${channelId}`,
              label: channelName,
              kind: "channel",
            },
          ],
          complete: true,
        };
      },
    };
  },

  async resolveThreadStream(installation, _thread, host, env) {
    return mountChannel(host, installation, env);
  },

  locales() {
    return slackLocaleTables;
  },

  installCatalog() {
    return {
      title: "catalog.title",
      channel_label: "catalog.channelLabel",
      description: "catalog.description",
      credential_hint: "catalog.credentialHint",
      fields: [
        {
          key: "channel_id",
          label: "field.channelId",
          required: true,
          placeholder: "field.channelId.placeholder",
        },
        {
          key: "channel_name",
          label: "field.channelName",
          required: false,
          placeholder: "field.channelName.placeholder",
        },
      ],
      prerequisites: [
        {
          kind: "env" as const,
          key: "REGENIC_SLACK_TOKEN",
          label: "prereq.token",
          required: true,
          hint: "prereq.token.hint",
        },
      ],
      setup_steps: [
        {
          title: "setup.createApp.title",
          href: "https://api.slack.com/apps",
        },
        {
          title: "setup.setToken.title",
          body: "setup.setToken.body",
        },
        {
          title: "setup.channelId.title",
          body: "setup.channelId.body",
        },
      ],
    };
  },

  presentInstall(installation) {
    const channelName = configString(installation.config, "channel_name");
    const channelId = configString(installation.config, "channel_id");
    return {
      label: { literal: channelName ?? channelId ?? installation.id },
      detail: channelName && channelId ? { literal: channelId } : null,
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
