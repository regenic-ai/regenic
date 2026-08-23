import { randomUUID } from "node:crypto";
import type {
  ContentPart,
  DeliveryReceipt,
  EgressAdapter,
  EgressCapabilities,
  SendIntent,
} from "@regenic/domain";
import { FeishuApiError, type FeishuImClient } from "./feishu-cli-client";
import { FEISHU_SOURCE } from "./feishu-message";

export interface FeishuChatEgressOptions {
  installation_id: string;
  chat_id: string;
}

export class FeishuChatEgress implements EgressAdapter {
  readonly source = FEISHU_SOURCE;

  constructor(
    private readonly client: FeishuImClient,
    private readonly options: FeishuChatEgressOptions,
  ) {}

  capabilities(): EgressCapabilities {
    return { reply: true, edit: false, tombstone: false };
  }

  async send(intent: SendIntent): Promise<DeliveryReceipt> {
    if (intent.installation_id !== this.options.installation_id) {
      throw new FeishuApiError("Send intent installation does not match the Feishu adapter");
    }
    const text = textFromContentParts(intent.content);
    const result = await this.client.sendText({
      chat_id: this.options.chat_id,
      text,
      uuid: randomUUID(),
    });
    return { accepted: true, rpc_id: result.message_id };
  }
}

export function textFromContentParts(content: ContentPart[]): string {
  const texts: string[] = [];
  for (const part of content) {
    if (part.role !== "body" || typeof part.text !== "string") {
      continue;
    }
    if (part.text.trim()) {
      texts.push(part.text);
    }
  }
  const text = texts.join("\n").trim();
  if (!text) {
    throw new FeishuApiError("Feishu send accepts a text body only");
  }
  return text;
}
