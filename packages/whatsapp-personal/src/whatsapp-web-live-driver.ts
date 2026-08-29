import { randomBytes, randomUUID } from "node:crypto";
import {
  CONNECTOR_PROTOCOL,
  ChannelDriverError,
  INGEST_SCHEMA_VERSION,
  channelRecord,
  envCredentialsRef,
  readInstallSecret,
  writeKeychainSecret,
  installSecretRef,
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
  whatsAppLiveActorId,
  whatsappConversationKind,
  whatsappLiveExternalId,
} from "./whatsapp-ids";
import {
  acknowledgeWhatsAppLiveCommand,
  enqueueWhatsAppLiveCommand,
  listWhatsAppLiveCommands,
  matchWhatsAppLiveOutbound,
} from "./whatsapp-web-live-queue";

export const WHATSAPP_WEB_LIVE_CONNECTOR_TYPE = "whatsapp-web-live";
export const WHATSAPP_WEB_LIVE_KEY_ENV = "REGENIC_PERSONAL_LIVE_KEY";
export const WHATSAPP_WEB_LIVE_PAIRING_FIELD = "pairing_code";
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
    try {
      writeWhatsAppLivePairingCode(input.id, generateWhatsAppLivePairingCode());
    } catch (error) {
      throw new ChannelDriverError(
        "missing_credentials",
        error instanceof Error
          ? error.message
          : "Could not store the WhatsApp pairing code",
      );
    }
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
        await verifyLiveAccess(request.headers, env, installation);
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
        "Read WhatsApp Web chats you already signed in to, and reply from Inbox. Install first — Regenic creates a pairing code for the browser extension.",
      credential_hint: "Pairing code · created on install",
      singleton: true,
      setup_steps: [
        {
          title: "Install this connector",
          title_zh: "安装这个连接器",
          body: "Regenic creates a pairing code. Copy it after install — you will paste it into the extension.",
          body_zh: "安装后会生成配对码。复制它，下一步贴进浏览器扩展。这不是 WhatsApp 密码。",
        },
        {
          title: "Load the WhatsApp Web extension",
          title_zh: "在浏览器里加载扩展",
          body: "Chrome or Edge: Extensions → Developer mode → Load unpacked → packages/web-extension-whatsapp/dist. Build the package first if dist is missing.",
          body_zh:
            "Chrome / Edge：打开扩展页 → 开发者模式 → 加载已解压的扩展程序 → 选 packages/web-extension-whatsapp/dist。若没有 dist 目录，先在仓库根目录运行构建命令。",
          command: "pnpm --filter @regenic/web-extension-whatsapp build",
          href: "https://github.com/regenic-ai/regenic/blob/main/docs/en/WHATSAPP_WEB_LIVE_CONNECTOR.md",
          href_zh:
            "https://github.com/regenic-ai/regenic/blob/main/docs/zh/WHATSAPP_WEB_LIVE_CONNECTOR.md",
        },
        {
          title: "Paste the pairing code into the extension",
          title_zh: "把配对码贴进扩展设置",
          body: "Open extension Settings. Local API origin stays on 127.0.0.1. Paste the pairing code from Engine. Leave Installation id blank.",
          body_zh:
            "打开扩展设置。本机 API 地址保持 127.0.0.1。把 Engine 里的配对码贴进去。Installation id 留空即可。",
        },
        {
          title: "Open WhatsApp Web and sync visible chats",
          title_zh: "打开 WhatsApp Web 并同步可见会话",
          body: "Sign in yourself, keep the chat list visible, then click Sync visible chats in the extension popup. Inbox replies open the matching chat before drafting or sending.",
          body_zh: "自己登录 WhatsApp Web，保持左侧会话列表可见，再在扩展弹窗里点「同步可见会话」。Inbox 回复会先打开对应聊天，再填草稿或发送。",
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

export function generateWhatsAppLivePairingCode(): string {
  return randomBytes(16).toString("hex");
}

export function writeWhatsAppLivePairingCode(
  installationId: string,
  secret: string,
): void {
  writeKeychainSecret(
    installSecretRef(
      WHATSAPP_WEB_LIVE_CONNECTOR_TYPE,
      installationId,
      WHATSAPP_WEB_LIVE_PAIRING_FIELD,
    ),
    secret,
  );
}

export function readWhatsAppLivePairingCode(
  installationId: string,
): Promise<string | undefined> {
  return readInstallSecret(
    WHATSAPP_WEB_LIVE_CONNECTOR_TYPE,
    installationId,
    WHATSAPP_WEB_LIVE_PAIRING_FIELD,
  );
}

export async function resolveWhatsAppLiveKeys(
  installation: Pick<ConnectorInstallation, "id">,
  env: NodeJS.ProcessEnv,
): Promise<{ pairingCode?: string; envKey?: string }> {
  const pairingCode = await readWhatsAppLivePairingCode(installation.id);
  const envKey = env[WHATSAPP_WEB_LIVE_KEY_ENV]?.trim() || undefined;
  return { pairingCode, envKey };
}

export function whatsAppLiveKeyMatches(
  presented: string | undefined,
  allowed: { pairingCode?: string; envKey?: string },
): boolean {
  const key = presented?.trim() ?? "";
  if (!key) {
    return false;
  }
  return key === allowed.pairingCode || key === allowed.envKey;
}

async function verifyLiveAccess(
  headers: WebhookRequest["headers"],
  env: NodeJS.ProcessEnv,
  installation: ConnectorInstallation,
): Promise<void> {
  const listenHost = (env.LISTEN_HOST ?? "127.0.0.1").trim().toLowerCase();
  if (!LOOPBACK_HOSTS.has(listenHost)) {
    throw new ChannelDriverError(
      "unsupported_channel",
      "WhatsApp live connector is loopback-only",
    );
  }
  const origin = headerValue(headers, "origin");
  const apiKey = headerValue(headers, "x-regenic-live-key");
  const allowed = await resolveWhatsAppLiveKeys(installation, env);
  if (origin) {
    if (!whatsAppLiveKeyMatches(apiKey, allowed)) {
      throw new ChannelDriverError(
        "missing_credentials",
        allowed.pairingCode || allowed.envKey
          ? "Invalid live connector API key"
          : "Live connector API key is required for browser access",
      );
    }
    return;
  }
  if (allowed.envKey && apiKey !== allowed.envKey) {
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
  const actorId = whatsAppLiveActorId({ chatId, fromMe, senderId });
  if (!actorId) {
    return undefined;
  }
  return channelRecord({
    channel: WHATSAPP_PERSONAL_SOURCE,
    kind: "user",
    direction: fromMe ? "outbound" : "inbound",
    external_id: echo ? `${chatId}:out:${echo.id}` : whatsappLiveExternalId(chatId, messageId),
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
