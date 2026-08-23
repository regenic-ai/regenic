import {
  ChannelDriverError,
  type ChannelDriver,
  type ConnectorInstallation,
  type ConnectorStream,
  type ConversationThread,
  type DeliveryReceipt,
  type JsonValue,
  type NewConnectorInstallation,
} from "@regenic/domain";
import {
  LarkCliClient,
  feishuChatOptionLabel,
  type FeishuChat,
  type FeishuChatMode,
  type FeishuImClient,
} from "./feishu-cli-client";
import { FeishuChatEgress } from "./feishu-chat-egress";
import { FeishuChatPollConnector } from "./feishu-chat-poll-connector";
import { FEISHU_SOURCE } from "./feishu-message";
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

  async resolveStreams(installation, _host, env) {
    const client = larkClient(env);
    const chats = await resolveFeishuChatTargets(installation.config, client);
    return createFeishuStreams(installation, chats, client);
  },

  async resolveThreadStream(installation, thread, _host, env) {
    const client = larkClient(env);
    const chats = await resolveFeishuChatTargets(installation.config, client);
    const chat =
      chats.find((item) => item.chat_id === thread.target) ??
      { chat_id: thread.target };
    const stream = createFeishuStreams(installation, [chat], client)[0];
    if (!stream) {
      throw new ChannelDriverError("sync_failed", "Feishu thread stream failed to mount");
    }
    return stream;
  },

  async bindEgress(installation, thread, _host, env) {
    return new FeishuChatEgress(larkClient(env), {
      installation_id: installation.id,
      chat_id: thread.target,
    });
  },

  outboundId(thread: ConversationThread, receipt: DeliveryReceipt) {
    return `${thread.target}:out:${receipt.rpc_id ?? "local"}`;
  },

  async resolveConversationLabels(installation, threads, env) {
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
    const missing = wanted.filter(
      (thread) => !labels.has(`${thread.source}:${thread.target}`),
    );
    if (missing.length === 0) {
      return labels;
    }
    try {
      const chats = await resolveFeishuChatTargets(
        installation.config,
        larkClient(env),
      );
      for (const chat of chats) {
        const name = chat.name?.replace(/\s+/g, " ").trim();
        if (name) {
          labels.set(`${FEISHU_SOURCE}:${chat.chat_id}`, name);
        }
      }
    } catch {
      // Live chat list is optional. Config names still apply.
    }
    return labels;
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

export async function resolveFeishuChatTargets(
  config: Record<string, unknown>,
  client: Pick<LarkCliClient, "listAllChats">,
): Promise<FeishuChat[]> {
  if (feishuSelection(config) === "all") {
    return client.listAllChats(10, feishuKinds(config));
  }
  const ids = feishuPickedChatIds(config);
  const names = configStringList(config, "chat_names");
  const listed = await client.listAllChats(10, ["group", "p2p"]).catch(() => []);
  const byId = new Map(listed.map((chat) => [chat.chat_id, chat]));
  return ids.map((chat_id, index) => {
    const live = byId.get(chat_id);
    return {
      chat_id,
      name: live?.name ?? names[index],
      chat_mode: live?.chat_mode,
    };
  });
}

export const FEISHU_STREAM_PACE = {
  idle_ms: 15_000,
  catch_up_pages: 5,
} as const;

export function createFeishuStreams(
  installation: ConnectorInstallation,
  chats: FeishuChat[],
  client: FeishuImClient,
): ConnectorStream[] {
  return chats.map((chat) => ({
    stream_key: `chat:${chat.chat_id}`,
    pace: { ...FEISHU_STREAM_PACE },
    connector: new FeishuChatPollConnector(client, {
      connector_id: installation.id,
      org_id: installation.org_id,
      chat_id: chat.chat_id,
      chat_name: chat.name,
      chat_mode: chat.chat_mode,
    }),
  }));
}

function larkClient(env: NodeJS.ProcessEnv): LarkCliClient {
  return new LarkCliClient({
    command: env.REGENIC_LARK_CLI,
    env,
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
