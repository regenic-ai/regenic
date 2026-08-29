import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  channelRecord,
  INGEST_SCHEMA_VERSION,
  type IngestRecord,
} from "@regenic/domain";
import { PersonalConnectorError } from "./personal-errors";
import { PersonalRuntimeService } from "./personal-runtime.service";

const WHATSAPP_LIVE_CONNECTOR_ID = "whatsapp-web-live";
const WHATSAPP_PERSONAL_SOURCE = "whatsapp-personal";
const MAX_MESSAGE_TEXT_CHARS = 12_000;
const MAX_SEND_TEXT_CHARS = 4_000;
const SEND_RATE_LIMIT_MS = 2_000;
const SEND_COMMAND_TTL_MS = 5 * 60 * 1_000;
const MAX_PENDING_SEND_COMMANDS = 100;

export interface WhatsAppLiveMessageInput {
  client_id?: string;
  chat_id?: string;
  chat_title?: string;
  message_id?: string;
  sender_id?: string;
  sender_name?: string;
  text?: string;
  timestamp?: string;
  from_me?: boolean;
  message_kind?: "user" | "system";
}

export interface WhatsAppLiveSendInput {
  conversation_id?: string;
  chat_id?: string;
  text?: string;
  send_now?: boolean;
  delay_ms?: number;
}

export interface PendingSendCommand {
  id: string;
  platform: "whatsapp-web";
  chat_id: string;
  text: string;
  send_now: boolean;
  delay_ms: number;
  created_at: string;
  expires_at: string;
}

@Injectable()
export class PersonalWhatsAppLiveService {
  private readonly commands = new Map<string, PendingSendCommand>();
  private readonly lastSendByChat = new Map<string, number>();

  constructor(private readonly runtime: PersonalRuntimeService) {}

  async receiveMessage(input: WhatsAppLiveMessageInput | undefined) {
    const message = this.parseMessage(input);
    const host = this.runtime.requireHost();
    const record = this.toRecord(message);
    const now = new Date().toISOString();
    const result = await host.get("ingest").ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: WHATSAPP_LIVE_CONNECTOR_ID,
      org_id: this.runtime.orgId(),
      delivery_id: `${WHATSAPP_LIVE_CONNECTOR_ID}:${message.client_id}:${message.message_id}`,
      received_at: now,
      records: [record],
    });
    if (!result.valid) {
      throw new PersonalConnectorError(
        "invalid_config",
        `WhatsApp live message was rejected: ${result.error_code ?? "invalid batch"}`,
        400,
      );
    }
    return {
      accepted_count: result.records.filter((item) => item.status === "accepted").length,
      duplicate_count: result.records.filter((item) => item.status === "duplicate").length,
      record: result.records[0],
    };
  }

  enqueueSend(input: WhatsAppLiveSendInput | undefined) {
    const chatId = this.chatIdFrom(input);
    const text = this.nonEmpty(input?.text, "text");
    if (text.length > MAX_SEND_TEXT_CHARS) {
      throw new PersonalConnectorError(
        "invalid_config",
        `text must be ${MAX_SEND_TEXT_CHARS} characters or shorter`,
        400,
      );
    }
    const nowMs = Date.now();
    this.pruneExpiredCommands(nowMs);
    if (this.commands.size >= MAX_PENDING_SEND_COMMANDS) {
      throw new PersonalConnectorError(
        "invalid_config",
        "WhatsApp send command queue is full",
        429,
      );
    }
    const last = this.lastSendByChat.get(chatId) ?? 0;
    if (nowMs - last < SEND_RATE_LIMIT_MS) {
      throw new PersonalConnectorError(
        "invalid_config",
        "Send commands for a WhatsApp chat are rate limited",
        429,
      );
    }
    this.lastSendByChat.set(chatId, nowMs);
    const command: PendingSendCommand = {
      id: randomUUID(),
      platform: "whatsapp-web",
      chat_id: chatId,
      text,
      send_now: input?.send_now === true,
      delay_ms: this.delayMs(input?.delay_ms),
      created_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + SEND_COMMAND_TTL_MS).toISOString(),
    };
    this.commands.set(command.id, command);
    return { command };
  }

  listCommands(clientId: string | undefined) {
    this.pruneExpiredCommands(Date.now());
    return {
      client_id: clientId?.trim() || "unknown",
      commands: [...this.commands.values()].sort((left, right) =>
        left.created_at.localeCompare(right.created_at),
      ),
    };
  }

  acknowledgeCommand(id: string | undefined) {
    const commandId = this.nonEmpty(id, "id");
    const deleted = this.commands.delete(commandId);
    return { acknowledged: deleted };
  }

  status() {
    this.pruneExpiredCommands(Date.now());
    return {
      platform: "whatsapp-web",
      source: WHATSAPP_PERSONAL_SOURCE,
      pending_command_count: this.commands.size,
      send_default: "draft_only",
    };
  }

  private parseMessage(input: WhatsAppLiveMessageInput | undefined): Required<WhatsAppLiveMessageInput> {
    const chatId = this.nonEmpty(input?.chat_id, "chat_id");
    const messageId = this.nonEmpty(input?.message_id, "message_id");
    const text = this.nonEmpty(input?.text, "text");
    if (text.length > MAX_MESSAGE_TEXT_CHARS) {
      throw new PersonalConnectorError(
        "invalid_config",
        `text must be ${MAX_MESSAGE_TEXT_CHARS} characters or shorter`,
        400,
      );
    }
    const timestamp = this.timestamp(input?.timestamp);
    return {
      client_id: input?.client_id?.trim() || "whatsapp-web-extension",
      chat_id: chatId,
      chat_title: input?.chat_title?.trim() || chatId,
      message_id: messageId,
      sender_id: input?.sender_id?.trim() || (input?.from_me ? this.runtime.orgId() : "unknown"),
      sender_name: input?.sender_name?.trim() || (input?.from_me ? "You" : "WhatsApp contact"),
      text,
      timestamp,
      from_me: input?.from_me === true,
      message_kind: input?.message_kind === "system" ? "system" : "user",
    };
  }

  private toRecord(message: Required<WhatsAppLiveMessageInput>): IngestRecord {
    return channelRecord({
      channel: WHATSAPP_PERSONAL_SOURCE,
      kind: message.message_kind,
      direction: message.from_me ? "outbound" : "inbound",
      external_id: `${message.chat_id}:${message.message_id}`,
      occurred_at: message.timestamp,
      actor_id: message.from_me ? this.runtime.orgId() : message.sender_id,
      actor_label: message.from_me ? undefined : message.sender_name,
      scope_id: message.chat_id,
      scope_name: message.chat_title,
      conversation_kind: this.conversationKind(message.chat_id),
      type: "message",
      text: message.text,
    });
  }

  private chatIdFrom(input: WhatsAppLiveSendInput | undefined): string {
    const explicit = input?.chat_id?.trim();
    if (explicit) {
      return explicit;
    }
    const conversationId = input?.conversation_id?.trim() ?? "";
    const prefix = `${WHATSAPP_PERSONAL_SOURCE}:`;
    if (conversationId.startsWith(prefix) && conversationId.length > prefix.length) {
      return conversationId.slice(prefix.length);
    }
    throw new PersonalConnectorError(
      "invalid_config",
      "chat_id or whatsapp-personal conversation_id is required",
      400,
    );
  }

  private timestamp(value: string | undefined): string {
    if (!value) {
      return new Date().toISOString();
    }
    if (Number.isNaN(Date.parse(value)) || !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
      throw new PersonalConnectorError(
        "invalid_config",
        "timestamp must be an ISO timestamp with timezone",
        400,
      );
    }
    return value;
  }

  private delayMs(value: number | undefined): number {
    if (value === undefined) {
      return 0;
    }
    if (!Number.isInteger(value) || value < 0 || value > 30_000) {
      throw new PersonalConnectorError(
        "invalid_config",
        "delay_ms must be an integer between 0 and 30000",
        400,
      );
    }
    return value;
  }

  private conversationKind(chatId: string): string | undefined {
    if (chatId.endsWith("@g.us")) {
      return "group";
    }
    if (chatId.endsWith("@c.us") || chatId.endsWith("@lid")) {
      return "direct";
    }
    return undefined;
  }

  private pruneExpiredCommands(nowMs: number): void {
    for (const [id, command] of this.commands) {
      if (Date.parse(command.expires_at) <= nowMs) {
        this.commands.delete(id);
      }
    }
    for (const [chatId, lastSendAt] of this.lastSendByChat) {
      if (nowMs - lastSendAt >= SEND_COMMAND_TTL_MS) {
        this.lastSendByChat.delete(chatId);
      }
    }
  }

  private nonEmpty(value: string | undefined, field: string): string {
    const trimmed = value?.trim() ?? "";
    if (!trimmed) {
      throw new PersonalConnectorError(
        "invalid_config",
        `${field} is required`,
        400,
      );
    }
    return trimmed;
  }
}