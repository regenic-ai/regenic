import {
  CONNECTOR_PROTOCOL,
  ChannelDriverError,
  keychainCredentialsRef,
  requireConnectorStream,
  runInSyncLane,
  type ChannelDriver,
  type ConnectorHost,
  type ConnectorInstallation,
  type ConnectorStream,
  type ConversationThread,
  type DeliveryReceipt,
  type JsonValue,
  type NewConnectorInstallation,
  type ResolveStreamsOptions,
  type SyncCatalogMember,
} from "@regenic/domain";
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
import { FeishuChatPollConnector } from "./feishu-chat-poll-connector";
import { feishuLocaleTables } from "./locales";
import { feishuChatPlugin } from "./plugin";
import { feishuChatIdFromStreamKey, feishuStreamKey } from "./feishu-streams";

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
  CATALOG_CHAT_PAGES,
  larkCliCatalogHint,
  larkCliReady,
  listFeishuCatalogChats,
  probeLarkCli,
} from "./probe";
import { createFeishuRecentSyncSource, createFeishuSyncSource } from "./feishu-sync-source";

export const feishuChatDriver: ChannelDriver = {
  connector_type: "feishu-chat",
  source: FEISHU_SOURCE,
  connector_protocol: CONNECTOR_PROTOCOL,

  install(input): NewConnectorInstallation {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: "feishu-chat",
      status: "enabled",
      config: feishuInstallConfig(input.config),
      credentials_ref: keychainCredentialsRef("lark-cli"),
      created_at: input.now,
    };
  },

  matchesThread(installation, thread) {
    if (thread.source !== FEISHU_SOURCE || installation.status !== "enabled") {
      return false;
    }
    if (feishuSelection(installation.config) !== "pick") {
      return true;
    }
    return feishuPickedChatIds(installation.config).includes(thread.target);
  },

  locales() {
    return feishuLocaleTables;
  },

  installCatalog() {
    return {
      title: "catalog.title",
      channel_label: "catalog.channelLabel",
      description: "catalog.description",
      credential_hint: "catalog.credentialHint",
      fields: [
        {
          key: "selection",
          label: "field.selection",
          required: true,
          default: "recent",
          options: [
            { value: "recent", label: "option.selection.recent" },
            { value: "pick", label: "option.selection.pick" },
            { value: "all", label: "option.selection.all" },
          ],
        },
        {
          key: "kinds",
          label: "field.kinds",
          required: true,
          multiple: true,
          default: "group,p2p",
          options: [
            { value: "group", label: "option.kinds.group" },
            { value: "p2p", label: "option.kinds.p2p" },
          ],
          visible_when: { field: "selection", values: ["all", "recent"] },
        },
        {
          key: "chat_ids",
          label: "field.chatIds",
          required: true,
          multiple: true,
          placeholder: "field.chatIds.placeholder",
          visible_when: { field: "selection", value: "pick" },
        },
      ],
      prerequisites: [
        {
          kind: "local_service" as const,
          key: "lark-cli",
          label: "prereq.larkCli",
          required: true,
          hint: "prereq.larkCli.hint",
        },
      ],
      setup_steps: [
        {
          title: "setup.installCli.title",
          command: "npx @larksuite/cli@latest install",
          href: "https://github.com/larksuite/cli",
        },
        {
          title: "setup.signIn.title",
          body: "setup.signIn.body",
          command: "lark-cli config init && lark-cli auth login --recommend",
        },
        {
          title: "setup.choose.title",
          body: "setup.choose.body",
        },
      ],
      install_confirm: {
        when: { field: "selection", value: "all" },
        warning: "confirm.all.warning",
        ack: "confirm.all.ack",
      },
    };
  },

  presentInstall(installation) {
    const config = installation.config;
    const selection = feishuSelection(config);
    const chatIds = feishuPickedChatIds(config);
    const chatName = configString(config, "chat_name");
    const chatId = configString(config, "chat_id");
    if (selection === "recent") {
      return { label: feishuRecentLabel(config), detail: { literal: "cli" } };
    }
    if (selection === "all" || (!selection && chatIds.length === 0 && !chatId)) {
      return { label: feishuAllLabel(config), detail: { literal: "cli" } };
    }
    const names = configStringList(config, "chat_names");
    if (chatIds.length > 1) {
      return {
        label: { key: "present.pickedCount", params: { count: chatIds.length } },
        detail: { literal: "cli" },
      };
    }
    return {
      label: {
        literal: names[0] ?? chatName ?? chatIds[0] ?? chatId ?? installation.id,
      },
      detail: { literal: "cli" },
    };
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

  writeBackLabels(label) {
    return feishuWriteBackLabels(label);
  },

  async resolveStreams(installation, host, env, options?: ResolveStreamsOptions) {
    const client = larkClient(env);
    const mounted = feishuChatsFromStreams(
      host.get("connectors").listStreams(installation.id),
    );
    const selection = feishuSelection(installation.config);
    const chats = await resolveFeishuChatTargets(installation.config, client, {
      known: mergeFeishuChats(
        feishuChatsFromThreads(
          options?.threads ?? [],
          installation,
          mounted,
        ),
        feishuChatsFromCatalog(options?.catalog ?? []),
      ),
      discover: feishuStreamDiscover(selection, options?.discover === true),
    });
    return mountFeishuChats(host, installation, chats, env, client, false);
  },

  async bindSyncSource(installation, _host, env) {
    const client = larkClient(env);
    const kinds = feishuKinds(installation.config);
    if (feishuSelection(installation.config) === "recent") {
      return createFeishuRecentSyncSource(client, kinds);
    }
    return createFeishuSyncSource(client, kinds);
  },

  async resolveThreadStream(installation, thread, host, env) {
    const client = larkClient(env);
    const mounted = feishuChatFromStreams(
      host.get("connectors").listStreams(installation.id),
      thread.target,
    );
    const streams = await mountFeishuChats(
      host,
      installation,
      [
        {
          chat_id: thread.target,
          name:
            feishuChatName(installation.config, thread.target) ?? mounted?.name,
          chat_mode: mounted?.chat_mode,
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
    const sent = receipt.rpc_id?.trim();
    if (sent) {
      return `${thread.target}:out:${sent}`;
    }
    return `${thread.target}:out:local`;
  },

  async resolveConversationLabels(installation, threads, env) {
    const wanted = threads.filter((thread) => thread.source === FEISHU_SOURCE);
    const labels = new Map<string, string>();
    if (wanted.length === 0) {
      return labels;
    }
    const picked = feishuPickedChatIds(installation.config);
    const names = pickedChatNames(installation.config, picked);
    if (picked.length > 0 && names.length === picked.length) {
      for (let index = 0; index < picked.length; index += 1) {
        const name = names[index]?.replace(/\s+/g, " ").trim();
        if (name) {
          labels.set(`${FEISHU_SOURCE}:${picked[index]}`, name);
        }
      }
    }
    const missing = wanted.filter(
      (thread) => !labels.has(`${FEISHU_SOURCE}:${thread.target}`),
    );
    if (missing.length === 0) {
      return labels;
    }
    const client = larkClient(env);
    if (typeof client.getChat !== "function") {
      return labels;
    }
    const pending = missing.slice(0, 24);
    for (let index = 0; index < pending.length; index += 8) {
      const batch = pending.slice(index, index + 8);
      await Promise.all(
        batch.map(async (thread) => {
          try {
            const chat = await client.getChat!(thread.target);
            const name = chat?.name?.replace(/\s+/g, " ").trim();
            if (name) {
              labels.set(`${FEISHU_SOURCE}:${thread.target}`, name);
            }
          } catch {
            // Leave unlabeled. Inbox must stay readable.
          }
        }),
      );
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
    ].slice(0, 8);
    const live = await Promise.all(
      unique.map(async (item) => {
        const cached = cachedFeishuReceipt(item.messageId);
        if (cached) {
          return { messageId: item.messageId, receipt: cached };
        }
        try {
          const receipt = receiptFromReadUsers(
            await client.readMessageUsers(item.messageId),
          );
          cacheFeishuReceipt(item.messageId, receipt);
          return { messageId: item.messageId, receipt };
        } catch {
          return { messageId: item.messageId, receipt: undefined };
        }
      }),
    );
    for (const item of live) {
      if (!item.receipt) {
        continue;
      }
      for (const row of wanted) {
        if (row.messageId === item.messageId) {
          receipts.set(row.external_id, item.receipt);
        }
      }
    }
    return receipts;
  },

  async probeCatalog({ env }) {
    return runInSyncLane("interactive", async () => {
      const lark = await probeLarkCli({ env });
      return {
        services: {
          "lark-cli": {
            ready: larkCliReady(lark),
            hint: larkCliCatalogHint(lark),
          },
        },
      };
    });
  },

  async listCatalogFieldOptions({ env }) {
    return runInSyncLane("interactive", async () => {
      const chats = await listFeishuCatalogChats({ env });
      return {
        chat_ids: chats.map((chat) => ({
          value: chat.chat_id,
          label: feishuChatOptionLabel(chat),
        })),
      };
    });
  },
};

const FEISHU_WRITE_BACK_GROUPS = [
  ["同意", "通过", "批准", "Approve", "approve", "Yes", "yes"],
  ["拒绝", "驳回", "不通过", "Reject", "reject", "No", "no"],
] as const;

export function feishuWriteBackLabels(label: string): string[] {
  const trimmed = label.trim();
  if (!trimmed) {
    return [];
  }
  const folded = trimmed.toLowerCase();
  const group = FEISHU_WRITE_BACK_GROUPS.find((aliases) =>
    aliases.some((alias) => alias.toLowerCase() === folded),
  );
  const aliases = group ? [...group] : [];
  return [...new Set([trimmed, ...aliases])];
}

export function feishuSelection(
  config: Record<string, unknown>,
): "all" | "pick" | "recent" {
  const selection = configString(config, "selection");
  if (selection === "all" || selection === "pick" || selection === "recent") {
    return selection;
  }
  return configString(config, "chat_id") ? "pick" : "all";
}

export function feishuStreamDiscover(
  selection: ReturnType<typeof feishuSelection>,
  discoverRequested: boolean,
): FeishuChatDiscover {
  if (selection === "pick") {
    return "known";
  }
  if (selection === "recent") {
    return discoverRequested ? "recent" : "known";
  }
  return discoverRequested ? "full" : "known";
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

function feishuRecentLabel(config: Record<string, unknown>): string {
  const kinds = feishuKinds(config);
  const groups = kinds.includes("group");
  const p2p = kinds.includes("p2p");
  if (groups && p2p) {
    return "present.recentConversations";
  }
  if (p2p) {
    return "present.recentDirect";
  }
  return "present.recentGroups";
}

function feishuAllLabel(config: Record<string, unknown>): string {
  const kinds = feishuKinds(config);
  const groups = kinds.includes("group");
  const p2p = kinds.includes("p2p");
  if (groups && p2p) {
    return "present.allConversations";
  }
  if (p2p) {
    return "present.allDirect";
  }
  return "present.allGroups";
}

export function feishuInstallConfig(
  input: Record<string, unknown>,
): Record<string, JsonValue> {
  const selection = feishuSelection(input);
  if (selection === "recent") {
    const kinds = feishuKinds(input);
    if (kinds.length === 0) {
      throw new ChannelDriverError(
        "invalid_config",
        "Feishu install requires groups, direct messages, or both",
      );
    }
    return { selection: "recent", kinds };
  }
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
  const names = pickedChatNames(input, chatIds);
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
    options?: { deadline?: number },
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
    return fillPickedFeishuChats(config, client);
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
      ? await client.listAllChats(CATALOG_CHAT_PAGES, kinds)
      : [];
    return mergeFeishuChats(known, listed);
  }
  const listed = await listRecentFeishuChats(client, kinds);
  return mergeFeishuChats(known, listed);
}

async function fillPickedFeishuChats(
  config: Record<string, unknown>,
  client: FeishuChatDirectory,
): Promise<FeishuChat[]> {
  const ids = feishuPickedChatIds(config);
  const stored = pickedChatNames(config, ids);
  const named = ids.map((chat_id, index) => ({
    chat_id,
    name: stored[index],
  }));
  if (named.every((chat) => Boolean(chat.name))) {
    return named;
  }
  const listed = await listPickedFeishuDirectory(
    client,
    named.filter((chat) => !chat.name).map((chat) => chat.chat_id),
  );
  const byId = new Map(listed.map((chat) => [chat.chat_id, chat]));
  return named.map((chat) => {
    const found = byId.get(chat.chat_id);
    return {
      chat_id: chat.chat_id,
      name: chat.name || found?.name,
      ...(found?.chat_mode ? { chat_mode: found.chat_mode } : {}),
    };
  });
}

async function listPickedFeishuDirectory(
  client: FeishuChatDirectory,
  wanted: string[],
): Promise<FeishuChat[]> {
  const byId = new Map<string, FeishuChat>();
  const missing = () => wanted.filter((id) => !byId.get(id)?.name);
  try {
    if (client.listRecentChats && missing().length > 0) {
      for (const chat of await client.listRecentChats(undefined, { names: true })) {
        byId.set(chat.chat_id, chat);
      }
    }
  } catch {
    // Fall through to the catalog-sized list.
  }
  try {
    if (client.listAllChats && missing().length > 0) {
      for (const chat of await client.listAllChats(CATALOG_CHAT_PAGES)) {
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
    }
  } catch {
    // Keep the picked ids. A directory miss must not drop the install set.
  }
  return [...byId.values()];
}

function pickedChatNames(
  config: Record<string, unknown>,
  chatIds: string[],
): string[] {
  const names = configStringList(config, "chat_names");
  if (names.length === chatIds.length) {
    return names;
  }
  const single = configString(config, "chat_name");
  return single && chatIds.length === 1 ? [single] : [];
}

function chatMatchesKinds(chat: FeishuChat, kinds: FeishuChatMode[]): boolean {
  return !chat.chat_mode || kinds.includes(chat.chat_mode);
}

function mergeFeishuChats(known: FeishuChat[], extra: FeishuChat[]): FeishuChat[] {
  const byId = new Map<string, FeishuChat>();
  for (const chat of [...known, ...extra]) {
    const prev = byId.get(chat.chat_id);
    const name = chat.name?.replace(/\s+/g, " ").trim() || prev?.name;
    byId.set(chat.chat_id, {
      chat_id: chat.chat_id,
      ...(name ? { name } : {}),
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

function feishuChatsFromCatalog(
  members: readonly SyncCatalogMember[],
): FeishuChat[] {
  return members.flatMap((member) => {
    const chatId =
      feishuChatIdFromStreamKey(member.stream_key) ??
      (member.thread_id?.startsWith(`${FEISHU_SOURCE}:`)
        ? member.thread_id.slice(FEISHU_SOURCE.length + 1)
        : undefined);
    if (!chatId) {
      return [];
    }
    const name = member.label?.replace(/\s+/g, " ").trim();
    const kind =
      member.kind === "group" || member.kind === "p2p" ? member.kind : undefined;
    return [
      {
        chat_id: chatId,
        ...(name ? { name } : {}),
        ...(kind ? { chat_mode: kind } : {}),
      },
    ];
  });
}

function feishuChatsFromThreads(
  threads: ConversationThread[],
  installation: ConnectorInstallation,
  mounted: FeishuChat[] = [],
): FeishuChat[] {
  const known = new Map(mounted.map((chat) => [chat.chat_id, chat]));
  return threads.flatMap((thread) => {
    if (thread.source !== FEISHU_SOURCE) {
      return [];
    }
    if (!feishuChatDriver.matchesThread(installation, thread)) {
      return [];
    }
    const prev = known.get(thread.target);
    return [
      {
        chat_id: thread.target,
        name: feishuChatName(installation.config, thread.target) ?? prev?.name,
        chat_mode: prev?.chat_mode,
      },
    ];
  });
}

function feishuChatsFromStreams(streams: ConnectorStream[]): FeishuChat[] {
  return streams.flatMap((stream) => {
    const chat = feishuChatFromStream(stream);
    return chat ? [chat] : [];
  });
}

function feishuChatFromStreams(
  streams: ConnectorStream[],
  chatId: string,
): FeishuChat | undefined {
  return feishuChatsFromStreams(streams).find((chat) => chat.chat_id === chatId);
}

function feishuChatFromStream(stream: ConnectorStream): FeishuChat | undefined {
  const chatId =
    feishuChatIdFromStreamKey(stream.stream_key) ??
    stream.thread_id?.slice(`${FEISHU_SOURCE}:`.length);
  if (!chatId) {
    return undefined;
  }
  if (stream.connector instanceof FeishuChatPollConnector) {
    return stream.connector.describeChat();
  }
  return {
    chat_id: chatId,
    ...(stream.label && stream.label !== chatId ? { name: stream.label } : {}),
  };
}

async function mountFeishuChats(
  host: ConnectorHost,
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
  for (const stream of registry.listStreams(installation.id)) {
    const chat = chats.find(
      (item) => feishuStreamKey(item.chat_id) === stream.stream_key,
    );
    if (chat && stream.connector instanceof FeishuChatPollConnector) {
      stream.connector.rememberChat(chat);
    }
  }
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
  const names = pickedChatNames(config, ids);
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
