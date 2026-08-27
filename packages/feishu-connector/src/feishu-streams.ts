import type { ConnectorInstallation, ConnectorStream } from "@regenic/domain";
import type { FeishuChat, FeishuImClient } from "./feishu-cli-client";
import { FeishuChatPollConnector } from "./feishu-chat-poll-connector";
import { FEISHU_SOURCE } from "./feishu-message";

export const FEISHU_STREAM_PACE = {
  idle_ms: 15_000,
  catch_up_pages: 5,
} as const;

export function feishuStreamKey(chatId: string): string {
  return `chat:${chatId}`;
}

export function feishuChatIdFromStreamKey(streamKey: string): string | undefined {
  if (!streamKey.startsWith("chat:") || streamKey.length <= 5) {
    return undefined;
  }
  return streamKey.slice(5);
}

export function feishuChatIdFromThreadId(threadId: string): string | undefined {
  const prefix = `${FEISHU_SOURCE}:`;
  if (!threadId.startsWith(prefix) || threadId.length <= prefix.length) {
    return undefined;
  }
  return threadId.slice(prefix.length);
}

export function createFeishuStreams(
  installation: Pick<ConnectorInstallation, "id" | "org_id">,
  chats: FeishuChat[],
  client: FeishuImClient,
  pageSize?: number,
  now?: () => string,
): ConnectorStream[] {
  return chats.map((chat) => ({
    stream_key: feishuStreamKey(chat.chat_id),
    thread_id: `${FEISHU_SOURCE}:${chat.chat_id}`,
    label: chat.name ?? chat.chat_id,
    pace: { ...FEISHU_STREAM_PACE },
    connector: new FeishuChatPollConnector(client, {
      connector_id: installation.id,
      org_id: installation.org_id,
      chat_id: chat.chat_id,
      chat_name: chat.name,
      chat_mode: chat.chat_mode,
      page_size: pageSize,
      now,
    }),
  }));
}
