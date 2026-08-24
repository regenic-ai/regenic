import "@regenic/domain";
import { definePlugin } from "@regenic/plugin-host";
import {
  LarkCliClient,
  spawnLarkProcess,
  type FeishuChat,
  type FeishuImClient,
  type FeishuSpawn,
} from "./feishu-cli-client";
import {
  createLarkUserTokenSource,
  type FeishuUserTokenSource,
} from "./feishu-user-token";
import { FeishuChatEgress } from "./feishu-chat-egress";
import { createFeishuStreams, feishuStreamKey } from "./feishu-streams";

export interface FeishuChatPluginConfig {
  installation_id: string;
  org_id: string;
  chat_id?: string;
  chat_name?: string;
  chats?: FeishuChat[];
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: FeishuSpawn;
  timeout_ms?: number;
  page_size?: number;
  now?: () => string;
  client?: FeishuImClient;
  userToken?: FeishuUserTokenSource;
}

export const feishuChatPlugin = definePlugin<FeishuChatPluginConfig>({
  name: "feishu-chat",
  inject: ["connectors", "egress"],
  apply(ctx, config) {
    const chats = pluginChats(config);
    const client =
      config.client ??
      new LarkCliClient({
        command: config.command,
        env: config.env,
        spawn: config.spawn,
        timeout_ms: config.timeout_ms,
        userToken:
          config.userToken ??
          (config.spawn
            ? undefined
            : createLarkUserTokenSource({
                command: config.command,
                env: config.env,
                spawn: spawnLarkProcess,
              })),
      });
    const streams = createFeishuStreams(
      {
        id: config.installation_id,
        org_id: config.org_id,
      },
      chats,
      client,
      config.page_size,
      config.now,
    );
    ctx.effect(() => {
      const disposers = streams.flatMap((stream) => {
        const chatId = stream.thread_id?.slice("feishu:".length) ?? "";
        const connector = ctx.get("connectors").register(
          config.installation_id,
          stream.connector,
          {
            stream_key: stream.stream_key,
            thread_id: stream.thread_id,
            label: stream.label,
            pace: stream.pace,
          },
        );
        const egress = ctx.get("egress").register(
          config.installation_id,
          new FeishuChatEgress(client, {
            installation_id: config.installation_id,
            chat_id: chatId,
          }),
          feishuStreamKey(chatId),
        );
        return [connector, egress];
      });
      return () => {
        for (const dispose of disposers.reverse()) {
          dispose();
        }
      };
    });
  },
});

function pluginChats(config: FeishuChatPluginConfig): FeishuChat[] {
  if (config.chats && config.chats.length > 0) {
    return config.chats;
  }
  if (config.chat_id) {
    return [{ chat_id: config.chat_id, name: config.chat_name }];
  }
  throw new Error("Feishu plugin requires chat_id or chats");
}
