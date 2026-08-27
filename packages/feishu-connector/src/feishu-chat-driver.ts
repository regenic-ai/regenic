import {
  ChannelDriverError,
  requireConnectorStream,
  type ChannelDriver,
  type ConnectorInstallation,
  type ConnectorStream,
  type ConversationThread,
  type DeliveryReceipt,
  type JsonValue,
  type NewConnectorInstallation,
  type ResolveStreamsOptions,
} from "@regenic/domain";
import type { Host } from "@regenic/plugin-host";
import {
  LarkCliClient,
  feishuChatOptionLabel,
  spawnLarkProcess,
  type FeishuChat,
  type FeishuChatMode,
  type FeishuImClient,
} from "./feishu-cli-client";
import { createLarkUserTokenSource } from "./feishu-user-token";
import { FEISHU_SOURCE } from "./feishu-message";
import { feishuChatPlugin } from "./plugin";
import { feishuStreamKey } from "./feishu-streams";

export {
  FEISHU_STREAM_PACE,
  createFeishuStreams,
  feishuChatIdFromStreamKey,
  feishuChatIdFromThreadId,
  feishuStreamKey,
} from "./feishu-streams";
import {
  cacheFeishuReadStatus,
  cachedFeishuReadStatus,
  feishuAttentionOf,
  markFeishuChatRead,
  resolveFeishuInbound,
} from "./feishu-attention";
import {
  cacheFeishuReceipt,
  cachedFeishuReceipt,
  feishuSentMessageId,
  receiptFromReadUsers,
} from "./feishu-receipts";
import {
  larkCliCatalogHint,
  larkCliReady,
  listFeishuCatalogChats,
  probeLarkCli,
} from "./probe";

export const feishuChatDriver: ChannelDriver = {
  connector_type: "feishu-chat",
  source: FEISHU_SOURCE,

  install(input): NewConnectorInstallation {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: "feishu-chat",
      status: "enabled",
      config: feishuInstallConfig(input.config),
      created_at: input.now,
    };
  },

  matchesThread(installation, thread) {
    if (thread.source !== FEISHU_SOURCE || installation.status !== "enabled") {
      return false;
    }
    if (feishuSelection(installation.config) === "all") {
      return true;
    }
    return feishuPickedChatIds(installation.config).includes(thread.target);
  },

  ownsThread(installation, thread) {
    if (!this.matchesThread(installation, thread)) {
      return false;
    }
    return feishuSelection(installation.config) === "pick";
  },

  capabilities(installation) {
    if (installation.status !== "enabled") {
      return { sync: false, reply: false, create: false };
    }
    return {
      sync: true,
      reply: true,
      create: false,
      list_title: "conversation",
      hydrate_on_open: true,
      attention: true,
      receipts: true,
    };
  },

  canReply(installation) {
    return this.capabilities(installation).reply;
  },

  async createThread() {
    throw new ChannelDriverError(
      "unsupported_channel",
      "Creating a Feishu conversation is not available",
    );
  },

  async resolveStreams(installation, host, env, options?: ResolveStreamsOptions) {
    const client = larkClient(env);
    const chats = await resolveFeishuChatTargets(installation.config, client, {
      known: feishuChatsFromThreads(options?.threads ?? [], installation),
      discover: feishuSelection(installation.config) === "pick" ? "known" : "recent",
    });
    return mountFeishuChats(host, installation, chats, env, client, true);
  },

  async resolveThreadStream(installation, thread, host, env) {
    const client = larkClient(env);
    const streams = await mountFeishuChats(
      host,
      installation,
      [
        {
          chat_id: thread.target,
          name: feishuChatName(installation.config, thread.target),
        },
      ],
      env,
      client,
    );
    return (
      streams[0] ??
      requireConnectorStream(
        host.get("connectors"),
        installation.id,
        feishuStreamKey(thread.target),
      )
    );
  },

  async bindEgress(installation, thread, host, env) {
    await this.resolveThreadStream(installation, thread, host, env);
    const egress = host.get("egress").get(
      installation.id,
      feishuStreamKey(thread.target),
    );
    if (!egress) {
      throw new ChannelDriverError("send_failed", "Feishu egress adapter failed to mount");
    }
    return egress;
  },

  outboundId(thread: ConversationThread, receipt: DeliveryReceipt) {
    return `${thread.target}:out:${receipt.rpc_id ?? "local"}`;
  },

  async resolveConversationLabels(installation, threads, _env) {
    const wanted = threads.filter((thread) => thread.source === FEISHU_SOURCE);
    const labels = new Map<string, string>();
    if (wanted.length === 0) {
      return labels;
    }
    const picked = feishuPickedChatIds(installation.config);
    const names = configStringList(installation.config, "chat_names");
    if (picked.length > 0 && names.length === picked.length) {
      for (let index = 0; index < picked.length; index += 1) {
        const name = names[index]?.replace(/\s+/g, " ").trim();
        if (name) {
          labels.set(`${FEISHU_SOURCE}:${picked[index]}`, name);
        }
      }
    }
    return labels;
  },

  async readAttention(installation, threads, _host, env) {
    const attention = new Map();
    if (!this.capabilities(installation).attention) {
      return attention;
    }
    const chats = threads.filter((thread) => thread.source === FEISHU_SOURCE);
    const missing: string[] = [];
    const statuses = new Map<string, boolean>();
    for (const thread of chats) {
      const messageId = resolveFeishuInbound(
        thread.target,
        thread.latest_inbound?.external_id,
      );
      if (!messageId) {
        continue;
      }
      const cached = cachedFeishuReadStatus(messageId);
      if (cached !== undefined) {
        statuses.set(messageId, cached);
      } else {
        missing.push(messageId);
      }
    }
    if (missing.length > 0) {
      try {
        const live = await larkClient(env).readMessageStatus(missing);
        for (const [id, isRead] of live) {
          cacheFeishuReadStatus(id, isRead);
          statuses.set(id, isRead);
        }
      } catch {
        // Overlay stays empty for those chats. Core uses the local cursor.
      }
    }
    for (const thread of chats) {
      const messageId = resolveFeishuInbound(
        thread.target,
        thread.latest_inbound?.external_id,
      );
      const overlay = feishuAttentionOf(
        thread.target,
        messageId ? statuses.get(messageId) : undefined,
      );
      if (overlay) {
        attention.set(`${thread.source}:${thread.target}`, overlay);
      }
    }
    return attention;
  },

  async ackAttention(_installation, thread) {
    if (thread.source === FEISHU_SOURCE) {
      markFeishuChatRead(thread.target);
    }
  },

  async readReceipts(installation, threads, _host, env) {
    const receipts = new Map();
    if (!this.capabilities(installation).receipts) {
      return receipts;
    }
    const client = larkClient(env);
    if (!client.readMessageUsers) {
      return receipts;
    }
    const wanted: Array<{ external_id: string; messageId: string }> = [];
    for (const thread of threads) {
      if (thread.source !== FEISHU_SOURCE) {
        continue;
      }
      for (const outbound of thread.outbound) {
        const messageId = feishuSentMessageId(outbound.external_id);
        if (messageId) {
          wanted.push({ external_id: outbound.external_id, messageId });
        }
      }
    }
    const unique = [
      ...new Map(wanted.map((item) => [item.messageId, item])).values(),
    ].slice(0, 20);
    const live = await Promise.all(
      unique.map(async (item) => {
        const cached = cachedFeishuReceipt(item.messageId);
        const receipt =
          cached ?? receiptFromReadUsers(await client.readMessageUsers(item.messageId));
        if (!cached) {
          cacheFeishuReceipt(item.messageId, receipt);
        }
        return { messageId: item.messageId, receipt };
      }),
    );
    for (const item of live) {
      for (const row of wanted) {
        if (row.messageId === item.messageId) {
          receipts.set(row.external_id, item.receipt);
        }
      }
    }
    return receipts;
  },

  async probeCatalog({ env }) {
    const lark = await probeLarkCli({ env });
    const chats = await listFeishuCatalogChats({ env });
    return {
      services: {
        "lark-cli": {
          ready: larkCliReady(lark),
          hint: larkCliCatalogHint(lark),
        },
      },
      field_options: {
        chat_ids: chats.map((chat) => ({
          value: chat.chat_id,
          label: feishuChatOptionLabel(chat),
        })),
      },
    };
  },
};

export function feishuSelection(config: Record<string, unknown>): "all" | "pick" {
  const selection = configString(config, "selection");
  if (selection === "all" || selection === "pick") {
    return selection;
  }
  return configString(config, "chat_id") ? "pick" : "all";
}

export function feishuPickedChatIds(config: Record<string, unknown>): string[] {
  const fromList = configStringList(config, "chat_ids");
  if (fromList.length > 0) {
    return fromList;
  }
  const single = configString(config, "chat_id");
  return single ? [single] : [];
}

export function feishuKinds(config: Record<string, unknown>): FeishuChatMode[] {
  const raw = configStringList(config, "kinds");
  if (raw.length === 0) {
    return ["group", "p2p"];
  }
  return (["group", "p2p"] as const).filter((kind) => raw.includes(kind));
}

export function feishuInstallConfig(
  input: Record<string, unknown>,
): Record<string, JsonValue> {
  const selection = feishuSelection(input);
  if (selection === "all") {
    const kinds = feishuKinds(input);
    if (kinds.length === 0) {
      throw new ChannelDriverError(
        "invalid_config",
        "Feishu install requires groups, direct messages, or both",
      );
    }
    return { selection: "all", kinds };
  }
  const chatIds = feishuPickedChatIds(input);
  if (chatIds.length === 0) {
    throw new ChannelDriverError(
      "invalid_config",
      "Feishu install requires at least one conversation when choosing conversations",
    );
  }
  const names = configStringList(input, "chat_names");
  const config: Record<string, JsonValue> = {
    selection: "pick",
    chat_ids: chatIds,
  };
  if (names.length === chatIds.length) {
    config.chat_names = names;
  }
  return config;
}

export type FeishuChatDiscover = "known" | "recent" | "full";

export interface FeishuChatDirectory {
  listRecentChats?(
    types?: FeishuChatMode[],
    options?: { names?: boolean },
  ): Promise<FeishuChat[]>;
  listAllChats?(
    maxPages?: number,
    types?: FeishuChatMode[],
  ): Promise<FeishuChat[]>;
}

export async function resolveFeishuChatTargets(
  config: Record<string, unknown>,
  client: FeishuChatDirectory,
  options: {
    known?: FeishuChat[];
    discover?: FeishuChatDiscover;
  } = {},
): Promise<FeishuChat[]> {
  if (feishuSelection(config) === "pick") {
    const ids = feishuPickedChatIds(config);
    const names = configStringList(config, "chat_names");
    return ids.map((chat_id, index) => ({
      chat_id,
      name: names[index],
    }));
  }
  const kinds = feishuKinds(config);
  const known = (options.known ?? []).filter((chat) =>
    chatMatchesKinds(chat, kinds),
  );
  const discover = options.discover ?? "recent";
  if (discover === "known") {
    return known;
  }
  if (discover === "full") {
    const listed = client.listAllChats
      ? await client.listAllChats(10, kinds)
      : [];
    return mergeFeishuChats(known, listed);
  }
  const listed = await listRecentFeishuChats(client, kinds);
  return mergeFeishuChats(known, listed);
}

function chatMatchesKinds(chat: FeishuChat, kinds: FeishuChatMode[]): boolean {
  return !chat.chat_mode || kinds.includes(chat.chat_mode);
}

function mergeFeishuChats(known: FeishuChat[], extra: FeishuChat[]): FeishuChat[] {
  const byId = new Map<string, FeishuChat>();
  for (const chat of [...known, ...extra]) {
    const prev = byId.get(chat.chat_id);
    byId.set(chat.chat_id, {
      chat_id: chat.chat_id,
      name: chat.name ?? prev?.name,
      chat_mode: chat.chat_mode ?? prev?.chat_mode,
      ...(chat.p2p_target_id || prev?.p2p_target_id
        ? { p2p_target_id: chat.p2p_target_id ?? prev?.p2p_target_id }
        : {}),
    });
  }
  return [...byId.values()];
}

async function listRecentFeishuChats(
  client: FeishuChatDirectory,
  kinds: FeishuChatMode[],
): Promise<FeishuChat[]> {
  try {
    if (client.listRecentChats) {
      return await client.listRecentChats(kinds, { names: false });
    }
    if (client.listAllChats) {
      return await client.listAllChats(1, kinds);
    }
  } catch {
    // Keep the local eligible set. A directory miss must not drop current work.
  }
  return [];
}

function feishuChatsFromThreads(
  threads: ConversationThread[],
  installation: ConnectorInstallation,
): FeishuChat[] {
  return threads.flatMap((thread) => {
    if (thread.source !== FEISHU_SOURCE) {
      return [];
    }
    if (!feishuChatDriver.matchesThread(installation, thread)) {
      return [];
    }
    return [
      {
        chat_id: thread.target,
        name: feishuChatName(installation.config, thread.target),
      },
    ];
  });
}

async function mountFeishuChats(
  host: Host,
  installation: ConnectorInstallation,
  chats: FeishuChat[],
  env: NodeJS.ProcessEnv,
  client: FeishuImClient,
  prune = false,
): Promise<ConnectorStream[]> {
  const registry = host.get("connectors");
  const egress = host.get("egress");
  const existing = new Set(
    registry.listStreams(installation.id).map((stream) => stream.stream_key),
  );
  const wanted = new Set(chats.map((chat) => feishuStreamKey(chat.chat_id)));
  const missing = chats.filter(
    (chat) => !existing.has(feishuStreamKey(chat.chat_id)),
  );
  if (missing.length > 0) {
    await host.plugin(feishuChatPlugin, {
      installation_id: installation.id,
      org_id: installation.org_id,
      chats: missing,
      command: env.REGENIC_LARK_CLI,
      env,
      client,
    });
  }
  if (prune) {
    for (const stream of registry.listStreams(installation.id)) {
      if (wanted.has(stream.stream_key)) {
        continue;
      }
      registry.unregister(installation.id, stream.stream_key);
      egress.unregister(installation.id, stream.stream_key);
    }
  }
  return registry
    .listStreams(installation.id)
    .filter((stream) => wanted.has(stream.stream_key));
}

function feishuChatName(
  config: Record<string, unknown>,
  chatId: string,
): string | undefined {
  const ids = feishuPickedChatIds(config);
  const names = configStringList(config, "chat_names");
  const index = ids.indexOf(chatId);
  if (index < 0) {
    return undefined;
  }
  return names[index];
}

function larkClient(env: NodeJS.ProcessEnv): LarkCliClient {
  return new LarkCliClient({
    command: env.REGENIC_LARK_CLI,
    env,
    userToken: createLarkUserTokenSource({
      command: env.REGENIC_LARK_CLI,
      env,
      spawn: spawnLarkProcess,
    }),
  });
}

function configString(
  config: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = config[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function configStringList(
  config: Record<string, unknown>,
  name: string,
): string[] {
  const value = config[name];
  if (Array.isArray(value)) {
    return value.flatMap((entry) =>
      typeof entry === "string" && entry.trim().length > 0 ? [entry.trim()] : [],
    );
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}
