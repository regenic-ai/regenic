import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";
import {
  createWhatsAppPersonalImport,
  type WhatsAppPersonalExportMessage,
  type WhatsAppPersonalImportError,
  type WhatsAppPersonalImportInput,
  type WhatsAppPersonalImportResult,
} from "./whatsapp-personal-export";

export const PURR_WA_VERSION = "1.0.1" as const;
const PURR_HEADERS = ["datetime", "sender", "fromMe", "type", "text"];

export interface PurrWhatsAppImportInput extends WhatsAppPersonalImportInput {
  file_name: string;
}

interface PurrCsvRow {
  datetime?: string;
  sender?: string;
  fromMe?: string;
  type?: string;
  text?: string;
}

const SYSTEM_MESSAGE_TYPES = new Set([
  "call_log",
  "gp2",
  "poll_creation",
  "revoked",
]);

export function createPurrWhatsAppImport(
  input: PurrWhatsAppImportInput,
): WhatsAppPersonalImportResult {
  const bytes = typeof input.data === "string"
    ? new TextEncoder().encode(input.data)
    : input.data;
  const fileHash = createHash("sha256").update(bytes).digest("hex");
  const chat = purrChatIdentity(input.file_name);
  if (!chat) {
    return invalidResult(
      fileHash,
      "Purr WA CSV filename must end with _<chat-id>_c_us.csv or _<chat-id>_g_us.csv",
    );
  }

  let rows: PurrCsvRow[];
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    rows = parse(content, {
      bom: true,
      columns: (headers: string[]) => {
        if (
          headers.length !== PURR_HEADERS.length ||
          headers.some((header, index) => header !== PURR_HEADERS[index])
        ) {
          throw new Error(`expected header ${PURR_HEADERS.join(",")}`);
        }
        return headers;
      },
      skip_empty_lines: true,
    }) as PurrCsvRow[];
  } catch (error) {
    return invalidResult(
      fileHash,
      error instanceof Error ? `Invalid Purr WA CSV: ${error.message}` : "Invalid Purr WA CSV",
    );
  }
  if (rows.length === 0) {
    return invalidResult(fileHash, "Purr WA CSV contains no message rows");
  }

  const errors: WhatsAppPersonalImportError[] = [];
  const occurrences = new Map<string, number>();
  const messages: WhatsAppPersonalExportMessage[] = [];
  for (const [index, row] of rows.entries()) {
    const line = index + 2;
    const sentAt = purrTimestamp(row.datetime);
    const sender = row.sender?.trim();
    const fromMe = row.fromMe?.trim();
    const type = row.type?.trim();
    const text = row.text?.trim();
    if (
      !sentAt ||
      !sender ||
      !text ||
      (fromMe !== "0" && fromMe !== "1") ||
      !type
    ) {
      errors.push({
        line,
        code: "invalid_message",
        message: "Purr WA row requires datetime, sender, fromMe, type, and text",
      });
      continue;
    }
    const identity = JSON.stringify([
      row.datetime?.trim(),
      sender,
      fromMe,
      type,
      text,
    ]);
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const direction = fromMe === "1" ? "outgoing" : "incoming";
    messages.push({
      schema_version: "1.0",
      kind: "whatsapp_personal_message",
      message_id: `${digest(identity).slice(0, 32)}-${occurrence}`,
      chat_id: chat.id,
      chat_name: chat.name,
      sender_id: direction === "outgoing"
        ? input.local_principal_id
        : `purr:${digest(sender).slice(0, 24)}`,
      sender_name: sender,
      direction,
      sent_at: sentAt,
      text,
      message_kind: SYSTEM_MESSAGE_TYPES.has(type) ? "system" : "user",
    });
  }

  const converted = createWhatsAppPersonalImport({
    ...input,
    data: messages.map((message) => JSON.stringify(message)).join("\n"),
  });
  return {
    file_hash: fileHash,
    batches: converted.batches.map((batch) => ({
      ...batch,
      connector_id: "whatsapp-personal-purr-wa-csv-v1",
      delivery_id: `whatsapp-personal-purr-wa-csv:${fileHash}`,
    })),
    errors: [...errors, ...converted.errors],
  };
}

function purrChatIdentity(fileName: string): { id: string; name: string } | null {
  const leaf = fileName.split(/[\\/]/).at(-1)?.replace(/ \(\d+\)(?=\.csv$)/i, "") ?? "";
  const match = /^(.*)_([0-9][0-9-]*)_(c|g)_us\.csv$/i.exec(leaf);
  if (!match) {
    return null;
  }
  return {
    id: `${match[2]}@${match[3].toLowerCase()}.us`,
    name: match[1].replace(/_/g, " ").trim() || match[2],
  };
}

function purrTimestamp(value: string | undefined): string | null {
  const source = value?.trim();
  if (!source) {
    return null;
  }
  const local = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(source);
  if (local) {
    const [, day, month, year, hour, minute, second = "0"] = local;
    const date = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    );
    if (
      date.getFullYear() !== Number(year) ||
      date.getMonth() !== Number(month) - 1 ||
      date.getDate() !== Number(day) ||
      date.getHours() !== Number(hour) ||
      date.getMinutes() !== Number(minute) ||
      date.getSeconds() !== Number(second)
    ) {
      return null;
    }
    return date.toISOString();
  }
  const date = new Date(source.includes("T") ? source : source.replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalidResult(fileHash: string, message: string): WhatsAppPersonalImportResult {
  return {
    file_hash: fileHash,
    batches: [],
    errors: [{ line: 1, code: "invalid_message", message }],
  };
}