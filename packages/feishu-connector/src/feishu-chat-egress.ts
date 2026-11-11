import { createHash, randomUUID } from "node:crypto";
import type {
  ContentPart,
  DeliveryReceipt,
  EgressAdapter,
  EgressCapabilities,
  SendIntent,
} from "@regenic/connector-contract";
import {
  FeishuApiError,
  type FeishuImClient,
  type FeishuUploadFile,
  uploadFilename,
} from "./feishu-cli-client";
import {
  FEISHU_SOURCE,
  applyFeishuPlainMentions,
  feishuMentionNameIndex,
  feishuMentionText,
  feishuOutgoingBody,
  feishuPlainMentionNames,
} from "./feishu-message";

const IMAGE_MEDIA = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface FeishuChatEgressOptions {
  installation_id: string;
  chat_id: string;
}

export interface FeishuOutgoingParts {
  text: string;
  images: FeishuUploadFile[];
  files: FeishuUploadFile[];
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
    const parts = outgoingPartsFromContent(intent.content);
    if (!parts.text && parts.images.length === 0 && parts.files.length === 0) {
      throw new FeishuApiError("Feishu send needs a text body or attachment");
    }
    requireAttachmentClient(this.client, parts);
    const chatId = this.options.chat_id;
    const messageUuid = (part: string): string => intent.idempotency_key
      ? createHash("sha256").update(JSON.stringify([
          intent.installation_id, chatId, intent.idempotency_key, part,
        ])).digest("hex").slice(0, 32)
      : randomUUID();
    const channelMessageIds: string[] = [];
    if (parts.text) {
      const text = await this.textWithMentions(parts.text);
      const body = feishuOutgoingBody(text);
      const message = body.msg_type === "post" && this.client.sendMessage
        ? await this.client.sendMessage({
            chat_id: chatId,
            msg_type: "post",
            content: body.content,
            uuid: messageUuid("text"),
          })
        : await this.client.sendText({
            chat_id: chatId,
            text: body.msg_type === "text" ? body.content.text : feishuMentionText(text),
            uuid: messageUuid("text"),
          });
      channelMessageIds.push(message.message_id);
    }
    for (const [index, image] of parts.images.entries()) {
      const uploaded = await this.client.uploadImage!(image);
      const message = await this.client.sendMessage!({
        chat_id: chatId,
        msg_type: "image",
        content: { image_key: uploaded.image_key },
        uuid: messageUuid(`image:${index}`),
      });
      channelMessageIds.push(message.message_id);
    }
    for (const [index, file] of parts.files.entries()) {
      const uploaded = await this.client.uploadFile!(file);
      const message = await this.client.sendMessage!({
        chat_id: chatId,
        msg_type: "file",
        content: { file_key: uploaded.file_key },
        uuid: messageUuid(`file:${index}`),
      });
      channelMessageIds.push(message.message_id);
    }
    const rpcId = channelMessageIds[0];
    if (!rpcId) {
      throw new FeishuApiError("Feishu send did not return message_id");
    }
    return {
      accepted: true,
      rpc_id: rpcId,
      channel_message_ids: channelMessageIds,
    };
  }

  /**
   * `@名字` copied from a chat is not a Feishu mention until it maps to one
   * member of this chat. Lookup failure leaves the text unchanged.
   */
  private async textWithMentions(text: string): Promise<string> {
    const pending = feishuPlainMentionNames(text);
    if (pending.length === 0 || typeof this.client.listChatMembers !== "function") {
      return applyFeishuPlainMentions(text, new Map());
    }
    try {
      const listed = await this.client.listChatMembers(this.options.chat_id);
      const names = listed.complete ? feishuMentionNameIndex(listed.items) : new Map();
      return applyFeishuPlainMentions(text, names);
    } catch {
      return applyFeishuPlainMentions(text, new Map());
    }
  }
}

export function textFromContentParts(content: ContentPart[]): string {
  return outgoingPartsFromContent(content).text;
}

export function outgoingPartsFromContent(content: ContentPart[]): FeishuOutgoingParts {
  const texts: string[] = [];
  const images: FeishuUploadFile[] = [];
  const files: FeishuUploadFile[] = [];
  for (const part of content) {
    if (part.role === "body" && typeof part.text === "string" && part.text.trim()) {
      texts.push(part.text);
      continue;
    }
    if (part.role !== "attachment") {
      continue;
    }
    if (!part.bytes || part.bytes.byteLength === 0) {
      throw new FeishuApiError("Feishu send dropped an attachment without bytes");
    }
    const attachment: FeishuUploadFile = {
      filename: uploadFilename(part.source_filename ?? "", fallbackFilename(part.media_type)),
      media_type: normalizeMediaType(part.media_type),
      bytes: part.bytes,
    };
    if (IMAGE_MEDIA.has(attachment.media_type)) {
      images.push(attachment);
    } else {
      files.push(attachment);
    }
  }
  return {
    text: texts.join("\n").trim(),
    images,
    files,
  };
}

function requireAttachmentClient(
  client: FeishuImClient,
  parts: FeishuOutgoingParts,
): void {
  if (parts.images.length === 0 && parts.files.length === 0) {
    return;
  }
  if (
    typeof client.uploadImage !== "function" ||
    typeof client.uploadFile !== "function" ||
    typeof client.sendMessage !== "function"
  ) {
    throw new FeishuApiError("Feishu send cannot deliver attachments");
  }
}

function normalizeMediaType(mediaType: string): string {
  const value = mediaType.trim().toLowerCase();
  return value === "image/jpg" ? "image/jpeg" : value;
}

function fallbackFilename(mediaType: string): string {
  const type = normalizeMediaType(mediaType);
  if (type === "image/png") {
    return "image.png";
  }
  if (type === "image/jpeg") {
    return "image.jpg";
  }
  if (type === "image/gif") {
    return "image.gif";
  }
  if (type === "image/webp") {
    return "image.webp";
  }
  if (type === "application/pdf") {
    return "attachment.pdf";
  }
  return "attachment";
}
