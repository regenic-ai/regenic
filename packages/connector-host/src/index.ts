import type { ChannelDriver, TaskExecutor } from "@regenic/domain";
import { cursorAgentDriver } from "@regenic/cursor-connector";
import {
  createDshHostRpcServices,
  dshPromptStoreFor,
  dshSessionDriver,
  dshTaskExecutor,
  dropDshPromptStore,
  handleDshPublicRpc,
  questionPromptId,
  type DshRpcHttpResult,
} from "@regenic/dsh-connector";
import { feishuChatDriver } from "@regenic/feishu-connector";
import { slackChannelDriver } from "@regenic/slack-connector";
import {
  createPurrWhatsAppImport,
  whatsappWebLiveDriver,
} from "@regenic/whatsapp-personal";

/**
 * Deployment-owned bundle. API and Sync Core depend on this host boundary,
 * never on individual connector implementation packages.
 */
export const BUILTIN_CONNECTOR_SPECS = [
  "@regenic/slack-connector",
  "@regenic/dsh-connector",
  "@regenic/feishu-connector",
  "@regenic/cursor-connector",
  "@regenic/whatsapp-personal",
] as const;

export function builtinChannelDrivers(): ChannelDriver[] {
  return [
    slackChannelDriver,
    dshSessionDriver,
    feishuChatDriver,
    cursorAgentDriver,
    whatsappWebLiveDriver,
  ];
}

export function builtinTaskExecutors(): TaskExecutor[] {
  return [dshTaskExecutor];
}

/**
 * Compatibility bridge for the DSH public transport. It remains outside
 * Core; callers should migrate to the generic connector-host capability
 * transport before this bridge is removed.
 */
export const dshPublicTransport = {
  createServices: createDshHostRpcServices,
  handle: handleDshPublicRpc,
};

export type { DshRpcHttpResult };
export {
  createPurrWhatsAppImport,
  cursorAgentDriver,
  dshPromptStoreFor,
  dshSessionDriver,
  dropDshPromptStore,
  feishuChatDriver,
  questionPromptId,
  slackChannelDriver,
  whatsappWebLiveDriver,
};
