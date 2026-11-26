import type { AttachmentRetry } from "@regenic/connector-contract";
import type { FeishuMediaJob } from "./feishu-chat-poll-connector";
import { feishuChatIdFromThreadId } from "./feishu-streams";
import {
  pullingFeishuLocators,
  queuedFeishuLocators,
  requeueFeishuMediaJob,
} from "./feishu-media-job-store";

const FEISHU_LOCATOR = /^feishu:(image|file):(.+)$/;

/** Thread ids this install still has attachment work for. Other sources are omitted. */
export function feishuQueuedAttachmentLocators(
  connectorId: string,
  threadIds: readonly string[],
): Map<string, ReadonlySet<string>> {
  const chats: { threadId: string; chatId: string }[] = [];
  for (const threadId of threadIds) {
    const chatId = feishuChatId(threadId);
    if (chatId) chats.push({ threadId, chatId });
  }
  const located = queuedFeishuLocators(
    connectorId,
    chats.map((chat) => chat.chatId),
  );
  const out = new Map<string, ReadonlySet<string>>();
  for (const chat of chats) {
    out.set(chat.threadId, located.get(chat.chatId) ?? new Set());
  }
  return out;
}

/** Locators this install is downloading now. Other sources are omitted. */
export function feishuPullingAttachmentLocators(
  connectorId: string,
  threadIds: readonly string[],
): Map<string, ReadonlySet<string>> {
  const chats: { threadId: string; chatId: string }[] = [];
  for (const threadId of threadIds) {
    const chatId = feishuChatId(threadId);
    if (chatId) chats.push({ threadId, chatId });
  }
  const pulling = pullingFeishuLocators(
    connectorId,
    chats.map((chat) => chat.chatId),
  );
  const out = new Map<string, ReadonlySet<string>>();
  for (const chat of chats) {
    const locators = pulling.get(chat.chatId);
    if (locators && locators.size > 0) out.set(chat.threadId, locators);
  }
  return out;
}

/** Returns false when the pointer is not a Feishu file or image locator. */
export function retryFeishuAttachment(
  connectorId: string,
  input: AttachmentRetry,
): boolean {
  const chatId = feishuChatId(input.thread_id);
  const match = FEISHU_LOCATOR.exec(input.external_locator);
  const key = match?.[2];
  if (!chatId || !match?.[1] || !key || !input.external_id.startsWith(`${chatId}:`)) {
    return false;
  }
  const messageId = input.external_id.slice(chatId.length + 1);
  if (!messageId) return false;
  const kind = match[1] === "image" ? "image" : "file";
  const filename = input.filename || undefined;
  const job: FeishuMediaJob = {
    message_id: messageId,
    key,
    kind,
    filename,
    media_type: input.media_type,
    attempts: 0,
    occurred_at: input.occurred_at,
    actor_id: input.actor_id || "user",
    sender_kind: "user",
    direction: input.direction === "outbound" ? "outbound" : "inbound",
    text: input.text || undefined,
    type: "message",
    thread_id: input.thread_id,
    refs: [{ kind, key, filename, media_type: input.media_type }],
  };
  requeueFeishuMediaJob(connectorId, chatId, job);
  return true;
}

function feishuChatId(threadId: string): string | undefined {
  const chatId = feishuChatIdFromThreadId(threadId);
  return chatId?.startsWith("oc_") ? chatId : undefined;
}
