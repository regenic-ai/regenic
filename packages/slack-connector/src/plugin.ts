import "@regenic/domain";
import { definePlugin } from "@regenic/plugin-host";
import {
  SlackChannelPollConnector,
  SlackWebApiHistoryClient,
  type SlackFetch,
} from "./slack-channel-poll-connector";

export interface SlackChannelPluginConfig {
  installation_id: string;
  org_id: string;
  channel_id: string;
  channel_name?: string;
  access_token: string;
  endpoint?: string;
  fetch?: SlackFetch;
  now?: () => string;
}

export const slackChannelPlugin = definePlugin<SlackChannelPluginConfig>({
  name: "slack-channel",
  inject: ["connectors"],
  apply(ctx, config) {
    const connector = new SlackChannelPollConnector(
      new SlackWebApiHistoryClient({
        access_token: config.access_token,
        endpoint: config.endpoint,
        fetch: config.fetch,
      }),
      {
        connector_id: config.installation_id,
        org_id: config.org_id,
        channel_id: config.channel_id,
        channel_name: config.channel_name,
        now: config.now,
      },
    );
    ctx.effect(() => ctx.get("connectors").register(config.installation_id, connector));
  },
});
