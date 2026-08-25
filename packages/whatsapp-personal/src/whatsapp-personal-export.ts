import { createHash } from "node:crypto";
import {
  channelRecord,
  INGEST_SCHEMA_VERSION,
  type IngestBatch,
  type IngestOperation,
  type IngestRecord,
} from "@regenic/domain";

export const WHATSAPP_PERSONAL_EXPORT_SCHEMA_VERSION = "1.0" as const;
export const WHATSAPP_PERSONAL_CONNECTOR_ID = "whatsapp-personal-export-v1";
export const WHATSAPP_PERSONAL_SOURCE = "whatsapp-personal";

export interface WhatsAppPersonalExportMessage {
  schema_version: typeof WHATSAPP_PERSONAL_EXPORT_SCHEMA_VERSION;
  kind: "whatsapp_personal_message";
  message_id: string;
  chat_id: string;
  chat_name?: string;
  sender_id: string;
  sender_name?: string;
  direction: "incoming" | "outgoing";
  sent_at: string;
  text?: string;
  reply_to_message_id?: string;
  operation?: IngestOperation;
  revision_id?: string;
  message_kind?: "user" | "system";
}

export interface WhatsAppPersonalImportInput {
  data: string | Uint8Array;
  org_id: string;
  local_principal_id: string;
  received_at: string;
}

export interface WhatsAppPersonalImportError {
  line: number;
  code: "invalid_json" | "invalid_message";
  message: string;
}

export interface WhatsAppPersonalImportResult {
  file_hash: string;
  batches: IngestBatch[];
  errors: WhatsAppPersonalImportError[];
}

export function createWhatsAppPersonalImport(
  input: WhatsAppPersonalImportInput,
): WhatsAppPersonalImportResult {
  const bytes = toBytes(input.data);
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  const errors: WhatsAppPersonalImportError[] = [];
  const records: IngestRecord[] = [];
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      records.push(toRecord(parseMessage(JSON.parse(line)), input.local_principal_id));
    } catch (error) {
      errors.push({
        line: index + 1,
        code: error instanceof SyntaxError ? "invalid_json" : "invalid_message",
        message: error instanceof Error ? error.message : "Invalid WhatsApp export message",
      });
    }
  }
  return {
    file_hash: fileHash,
    batches: records.length === 0 ? [] : [{
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: WHATSAPP_PERSONAL_CONNECTOR_ID,
      org_id: input.org_id,
      delivery_id: `whatsapp-personal-export:${fileHash}`,
      received_at: input.received_at,
      records,
    }],
    errors,
  };
}

function parseMessage(value: unknown): WhatsAppPersonalExportMessage {
  if (!isObject(value)) {
    throw new Error("Export line must be an object");
  }
  const operation = value.operation ?? "create";
  if (
    value.schema_version !== WHATSAPP_PERSONAL_EXPORT_SCHEMA_VERSION ||
    value.kind !== "whatsapp_personal_message" ||
    !isNonEmptyString(value.message_id) ||
    !isNonEmptyString(value.chat_id) ||
    !isNonEmptyString(value.sender_id) ||
    !isIsoTimestamp(value.sent_at) ||
    (value.direction !== "incoming" && value.direction !== "outgoing") ||
    (value.message_kind !== undefined &&
      value.message_kind !== "user" &&
      value.message_kind !== "system") ||
    (operation !== "create" && operation !== "revise" && operation !== "tombstone")
  ) {
    throw new Error("Export line does not match WhatsApp Personal Export v1");
  }
  if (operation !== "tombstone" && !isNonEmptyString(value.text)) {
    throw new Error("Create and revise messages require non-empty text");
  }
  return {
    schema_version: value.schema_version,
    kind: value.kind,
    message_id: value.message_id,
    chat_id: value.chat_id,
    chat_name: optionalString(value.chat_name),
    sender_id: value.sender_id,
    sender_name: optionalString(value.sender_name),
    direction: value.direction,
    sent_at: value.sent_at,
    text: optionalString(value.text),
    reply_to_message_id: optionalString(value.reply_to_message_id),
    operation,
    revision_id: optionalString(value.revision_id),
    message_kind:
      value.message_kind === "system" || value.message_kind === "user"
        ? value.message_kind
        : undefined,
  };
}

function toRecord(message: WhatsAppPersonalExportMessage, localPrincipalId: string): IngestRecord {
  const operation = message.operation ?? "create";
  const isReply = Boolean(message.reply_to_message_id);
  const kind = message.message_kind ?? "user";
  const record = channelRecord({
    channel: WHATSAPP_PERSONAL_SOURCE,
    kind,
    direction: message.direction === "outgoing" ? "outbound" : "inbound",
    external_id: `${message.chat_id}:${message.message_id}`,
    occurred_at: message.sent_at,
    actor_id:
      message.direction === "outgoing" ? localPrincipalId : message.sender_id,
    actor_label:
      kind === "system"
        ? "WhatsApp"
        : message.direction === "incoming"
          ? message.sender_name
          : undefined,
    scope_id: message.chat_id,
    scope_name: message.chat_name,
    conversation_kind: whatsappConversationKind(message.chat_id),
    type: isReply ? "thread_reply" : "message",
    thread_id: isReply ? message.chat_id : undefined,
    parent_external_id: isReply
      ? `${message.chat_id}:${message.reply_to_message_id}`
      : undefined,
    text: operation === "tombstone" ? undefined : message.text,
  });
  record.operation = operation;
  record.revision_id = message.revision_id;
  record.attrs = {
    export_schema_version: WHATSAPP_PERSONAL_EXPORT_SCHEMA_VERSION,
    platform: "whatsapp-web",
  };
  if (operation === "tombstone") {
    record.content = undefined;
  }
  return record;
}

function whatsappConversationKind(chatId: string): string | undefined {
  if (chatId.endsWith("@g.us")) {
    return "group";
  }
  if (chatId.endsWith("@c.us") || chatId.endsWith("@lid")) {
    return "direct";
  }
  return undefined;
}

function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? new TextEncoder().encode(data) : data;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" &&
    /(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
    !Number.isNaN(Date.parse(value));
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}