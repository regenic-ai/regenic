import { randomUUID } from "node:crypto";
import {
  CONNECTOR_PROTOCOL,
  ChannelDriverError,
  INGEST_SCHEMA_VERSION,
  channelRecord,
  envCredentialsRef,
  type ChannelDriver,
  type ConnectorImportParseResult,
  type ConnectorInstallation,
  type ConversationThread,
  type DeliveryReceipt,
  type IngestBatch,
  type IngestRecord,
  type VerifiedWebhook,
  type WebhookRequest,
} from "@regenic/domain";
import { createPurrWhatsAppImport } from "./purr-wa-csv";
import {
  createWhatsAppPersonalImport,
  WHATSAPP_PERSONAL_SOURCE,
} from "./whatsapp-personal-export";
import {
  isWhatsAppChatId,
  parseWhatsAppChatId,
  whatsappConversationKind,
} from "./whatsapp-ids";
import {
  acknowledgeWhatsAppLiveCommand,
  enqueueWhatsAppLiveCommand,
  listWhatsAppLiveCommands,
  matchWhatsAppLiveOutbound,
} from "./whatsapp-web-live-queue";

export const WHATSAPP_WEB_LIVE_CONNECTOR_TYPE = "whatsapp-web-live";
export const WHATSAPP_WEB_LIVE_KEY_ENV = "REGENIC_PERSONAL_LIVE_KEY";
export const WHATSAPP_IMPORT_MAX_BYTES = 20 * 1024 * 1024;
const PURR_REVISE_ID = "purr-wa-surface-v1";
const MAX_MESSAGE_TEXT_CHARS = 12_000;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export const whatsappWebLiveDriver: ChannelDriver = {
  connector_type: WHATSAPP_WEB_LIVE_CONNECTOR_TYPE,
  source: WHATSAPP_PERSONAL_SOURCE,
  source_mode: "webhook",
  connector_protocol: CONNECTOR_PROTOCOL,

  install(input) {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: WHATSAPP_WEB_LIVE_CONNECTOR_TYPE,
      status: "enabled",
      config: {},
      credentials_ref: envCredentialsRef(WHATSAPP_WEB_LIVE_KEY_ENV),
      created_at: input.now,
    };
  },

  matchesThread(installation, thread) {
    return matchesWhatsAppLiveThread(installation, thread);
  },

  ownsThread(installation, thread) {
    return matchesWhatsAppLiveThread(installation, thread);
  },

  capabilities(installation) {
    const enabled = installation.status === "enabled";
    return {
      sync: enabled,
      reply: enabled,
      create: false,
      list_title: "conversation",
    };
  },

  async resolveStreams() {
    return [];
  },

  async resolveThreadStream() {
    throw new ChannelDriverError(
      "unsupported_channel",
      "WhatsApp Web live does not poll",
    );
  },

  async bindWebhook(installation, _host, env) {
    return {
      source: WHATSAPP_PERSONAL_SOURCE,
      source_mode: "webhook" as const,
      async verifyWebhook(request: WebhookRequest) {
        verifyLiveAccess(request.headers, env);
        return { body: request.body, verified_at: request.received_at };
      },
      async handleWebhook(webhook: VerifiedWebhook) {
        return toBatch(installation, webhook);
      },
    };
  },

  async bindEgress(installation, thread) {
    if (!matchesWhatsAppLiveThread(installation, thread)) {
      throw new ChannelDriverError(
        "unsupported_channel",
        "WhatsApp Web live can only send to a WhatsApp JID thread",
      );
    }
    return {
      source: WHATSAPP_PERSONAL_SOURCE,
      capabilities: () => ({ reply: true, edit: false, tombstone: false }),
      async send(intent) {
        const text = intent.content
          .flatMap((part) => ("text" in part && part.text ? [part.text] : []))
          .join("\n")
          .trim();
        const command = enqueueWhatsAppLiveCommand({
          installationId: installation.id,
          chatId: thread.target,
          text,
          sendNow: true,
          delayMs: 0,
        });
        return { accepted: true, rpc_id: command.id };
      },
    };
  },

  outboundId(thread: ConversationThread, receipt: DeliveryReceipt) {
    return `${thread.target}:out:${receipt.rpc_id ?? randomUUID()}`;
  },

  listEgressQueue(installation) {
    return listWhatsAppLiveCommands(installation.id);
  },

  ackEgressQueue(installation, id) {
    return acknowledgeWhatsAppLiveCommand(installation.id, id);
  },

  installCatalog() {
    return {
      title: "WhatsApp Web",
      channel_label: "WhatsApp",
      description:
        "Observe the signed-in WhatsApp Web tab through the local extension, and reply from Inbox. Chat identity is the WhatsApp JID, same as a personal export import.",
      credential_hint: WHATSAPP_WEB_LIVE_KEY_ENV,
      singleton: true,
      prerequisites: [
        {
          kind: "env" as const,
          key: WHATSAPP_WEB_LIVE_KEY_ENV,
          label: "Live connector API key",
          required: true,
          hint: `Set ${WHATSAPP_WEB_LIVE_KEY_ENV} before starting the API. The form does not take it.`,
        },
      ],
      setup_steps: [
        {
          title: "Set REGENIC_PERSONAL_LIVE_KEY and bind the API to 127.0.0.1",
        },
        {
          title: "Build and load the WhatsApp Web extension",
          body: "pnpm --filter @regenic/web-extension-whatsapp build, then load packages/web-extension-whatsapp/dist.",
        },
        {
          title: "Install this connector, then reconnect the open WhatsApp Web chat",
        },
      ],
      import_files: {
        accept: ".csv,.jsonl,.ndjson,text/csv,application/x-ndjson,application/json",
        max_bytes: WHATSAPP_IMPORT_MAX_BYTES,
        title: "WhatsApp personal export",
        description:
          "Import Purr WA CSV or WhatsApp Personal Export v1 JSONL that you picked yourself. Read-only: no cookies, no sending.",
      },
    };
  },

  parseImport(input) {
    const common = {
      data: input.content,
      org_id: input.org_id,
      local_principal_id: input.local_principal_id,
      received_at: input.received_at,
    };
    const isPurr = input.file_name?.toLowerCase().endsWith(".csv") === true;
    const imported = isPurr
      ? createPurrWhatsAppImport({ ...common, file_name: input.file_name ?? "" })
      : createWhatsAppPersonalImport(common);
    return isPurr
      ? applyPurrRevisions(imported, input.existing_external_ids)
      : imported;
  },

  presentInstall() {
    return {
      label: "WhatsApp Web",
      detail: "Local browser extension",
    };
  },

  async probeCatalog(input) {
    const ready = Boolean(input.env[WHATSAPP_WEB_LIVE_KEY_ENV]?.trim());
    return {
      services: {
        [WHATSAPP_WEB_LIVE_KEY_ENV]: {
          ready,
          hint: ready
            ? undefined
            : `Set ${WHATSAPP_WEB_LIVE_KEY_ENV} before starting the API.`,
        },
      },
    };
  },
};

function applyPurrRevisions(
  imported: ConnectorImportParseResult,
  existingIds: readonly string[] | undefined,
): ConnectorImportParseResult {
  const existing = new Set(existingIds ?? []);
  return {
    ...imported,
    batches: imported.batches.map((batch) => ({
      ...batch,
      records: batch.records.map((record) => {
        if (record.operation !== "create" || !existing.has(record.external_id)) {
          existing.add(record.external_id);
          return record;
        }
        return {
          ...record,
          operation: "revise" as const,
          revision_id: PURR_REVISE_ID,
        };
      }),
    })),
  };
}

function matchesWhatsAppLiveThread(
  installation: ConnectorInstallation,
  thread: ConversationThread,
): boolean {
  return (
    installation.status === "enabled"
    && thread.source === WHATSAPP_PERSONAL_SOURCE
    && isWhatsAppChatId(thread.target)
  );
}

function verifyLiveAccess(
  headers: WebhookRequest["headers"],
  env: NodeJS.ProcessEnv,
): void {
  const listenHost = (env.LISTEN_HOST ?? "127.0.0.1").trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(listenHost)) {
    throw new ChannelDriverError(
      "unsupported_channel",
      "WhatsApp live connector is loopback-only",
    );
  }
  const origin = headerValue(headers, "origin");
  const apiKey = headerValue(headers, "x-regenic-live-key");
  const expected = env[WHATSAPP_WEB_LIVE_KEY_ENV]?.trim();
  if (origin && !expected) {
    throw new ChannelDriverError(
      "missing_credentials",
      "Live connector API key is required for browser access",
    );
  }
  if (expected && apiKey !== expected) {
    throw new ChannelDriverError("missing_credentials", "Invalid live connector API key");
  }
}

function toBatch(
  installation: ConnectorInstallation,
  webhook: VerifiedWebhook,
): IngestBatch {
  const payload = parsePayload(webhook.body);
  const records = payload ? [payload] : [];
  return {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: installation.id,
    org_id: installation.org_id,
    delivery_id: records[0]
      ? `${WHATSAPP_WEB_LIVE_CONNECTOR_TYPE}:${records[0].external_id}`
      : `${WHATSAPP_WEB_LIVE_CONNECTOR_TYPE}:poll:${randomUUID()}`,
    received_at: webhook.verified_at,
    records,
  };
}

function parsePayload(body: Uint8Array): IngestRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new ChannelDriverError("invalid_config", "Webhook body must be JSON");
  }
  if (!isObject(value) || value.type === "poll") {
    return undefined;
  }
  if (value.message_kind === "system") {
    return undefined;
  }
  const chatId = parseWhatsAppChatId(
    typeof value.chat_id === "string" ? value.chat_id : undefined,
  );
  const messageId = typeof value.message_id === "string" ? value.message_id.trim() : "";
  const text = typeof value.text === "string" ? value.text.trim() : "";
  if (!chatId || !messageId || !text) {
    return undefined;
  }
  if (text.length > MAX_MESSAGE_TEXT_CHARS) {
    throw new ChannelDriverError(
      "invalid_config",
      `text must be ${MAX_MESSAGE_TEXT_CHARS} characters or shorter`,
    );
  }
  const fromMe = value.from_me === true;
  const echo = fromMe ? matchWhatsAppLiveOutbound(chatId, text) : undefined;
  const senderId = typeof value.sender_id === "string" ? value.sender_id.trim() : "";
  const senderName = typeof value.sender_name === "string" ? value.sender_name.trim() : "";
  const kind = whatsappConversationKind(chatId);
  const inboundActor = parseWhatsAppChatId(senderId) ?? (kind === "group" ? undefined : chatId);
  const actorId = fromMe ? "local-owner" : inboundActor;
  if (!actorId) {
    return undefined;
  }
  return channelRecord({
    channel: WHATSAPP_PERSONAL_SOURCE,
    kind: "user",
    direction: fromMe ? "outbound" : "inbound",
    external_id: echo ? `${chatId}:out:${echo.id}` : `${chatId}:${messageId}`,
    occurred_at: timestamp(typeof value.timestamp === "string" ? value.timestamp : undefined),
    actor_id: actorId,
    actor_label: fromMe ? undefined : senderName || undefined,
    scope_id: chatId,
    scope_name:
      typeof value.chat_title === "string" && value.chat_title.trim()
        ? value.chat_title.trim()
        : chatId,
    conversation_kind: kind,
    type: "message",
    text,
  });
}

function timestamp(value: string | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }
  if (Number.isNaN(Date.parse(value)) || !/(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new ChannelDriverError(
      "invalid_config",
      "timestamp must be an ISO timestamp with timezone",
    );
  }
  return value;
}

function headerValue(
  headers: WebhookRequest["headers"],
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
