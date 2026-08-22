import "@regenic/domain";
import { definePlugin } from "@regenic/plugin-host";
import { LarkCliClient, type FeishuImClient, type FeishuSpawn } from "./feishu-cli-client";
import { FeishuChatEgress } from "./feishu-chat-egress";
import { FeishuChatPollConnector } from "./feishu-chat-poll-connector";

export interface FeishuChatPluginConfig {
  installation_id: string;
  org_id: string;
  chat_id: string;
  chat_name?: string;
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: FeishuSpawn;
  timeout_ms?: number;
  page_size?: number;
  now?: () => string;
  client?: FeishuImClient;
}

export const feishuChatPlugin = definePlugin<FeishuChatPluginConfig>({
  name: "feishu-chat",
  inject: ["connectors", "egress"],
  apply(ctx, config) {
    const client =
      config.client ??
      new LarkCliClient({
        command: config.command,
        env: config.env,
        spawn: config.spawn,
        timeout_ms: config.timeout_ms,
      });
    const connector = new FeishuChatPollConnector(client, {
      connector_id: config.installation_id,
      org_id: config.org_id,
      chat_id: config.chat_id,
      chat_name: config.chat_name,
      page_size: config.page_size,
      now: config.now,
    });
    const egress = new FeishuChatEgress(client, {
      installation_id: config.installation_id,
      chat_id: config.chat_id,
    });
    ctx.effect(() => {
      const disposeConnector = ctx.get("connectors").register(
        config.installation_id,
        connector,
      );
      const disposeEgress = ctx.get("egress").register(config.installation_id, egress);
      return () => {
        disposeConnector();
        disposeEgress();
      };
    });
  },
});
