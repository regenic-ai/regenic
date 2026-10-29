import type { ChannelDriver, TaskExecutor } from "@regenic/domain";
import { cursorAgentDriver } from "@regenic/cursor-connector";
import {
  dshPromptStoreFor,
  dshSessionDriver,
  dshTaskExecutor,
  dropDshPromptStore,
  handleDshPublicRpc,
  questionPromptId,
  type DshRpcHttpResult,
} from "@regenic/dsh-connector";
import { feishuChatDriver } from "@regenic/feishu-connector";
import { createDshHostRpcServices } from "./dsh-host-services";

export { createDshHostRpcServices };

/**
 * Deployment-owned bundle. API and Sync Core depend on this host boundary,
 * never on individual connector implementation packages.
 */
export const BUILTIN_CONNECTOR_SPECS = [
  "@regenic/dsh-connector",
  "@regenic/feishu-connector",
  "@regenic/cursor-connector",
] as const;

export function builtinChannelDrivers(): ChannelDriver[] {
  return [
    dshSessionDriver,
    feishuChatDriver,
    cursorAgentDriver,
  ];
}

export function builtinTaskExecutors(): TaskExecutor[] {
  return [dshTaskExecutor];
}

/**
 * Compatibility bridge for the DSH public transport. The protocol handler
 * stays in the connector. Creating services lists installations and polls,
 * so that half lives here.
 */
export const dshPublicTransport = {
  createServices: createDshHostRpcServices,
  handle: handleDshPublicRpc,
};

export type { DshRpcHttpResult };
export {
  cursorAgentDriver,
  dshPromptStoreFor,
  dshSessionDriver,
  dropDshPromptStore,
  feishuChatDriver,
  questionPromptId,
};
