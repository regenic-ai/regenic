import type { SyncDirectoryPage, SyncSource } from "@regenic/domain";
import type { FeishuChat, FeishuChatMode, FeishuImClient } from "./feishu-cli-client";
import { FEISHU_SOURCE } from "./feishu-message";
import { feishuStreamKey } from "./feishu-streams";

const GROUP_PAGE_SIZE = 100;
const P2P_PAGE_SIZE = 50;

interface FeishuRecentCatalogClient {
  listRecentChats?(
    types?: FeishuChatMode[],
    options?: { names?: boolean },
  ): Promise<FeishuChat[]>;
  listChats?: FeishuImClient["listChats"];
}

export function createFeishuRecentSyncSource(
  client: FeishuRecentCatalogClient,
  kinds: FeishuChatMode[],
): SyncSource {
  return {
    async listDirectory(): Promise<SyncDirectoryPage> {
      const chats = await listRecentFeishuCatalogChats(client, kinds);
      return {
        members: chats.map((chat) => ({
          stream_key: feishuStreamKey(chat.chat_id),
          thread_id: `${FEISHU_SOURCE}:${chat.chat_id}`,
          ...(chat.name?.trim() ? { label: chat.name.trim() } : {}),
          kind: chat.chat_mode,
        })),
        complete: true,
      };
    },
  };
}

export function createFeishuSyncSource(
  client: Pick<FeishuImClient, "listChats">,
  kinds: FeishuChatMode[],
): SyncSource {
  const wantsGroup = kinds.includes("group");
  const wantsP2p = kinds.includes("p2p");
  return {
    async listDirectory(cursor: string | null): Promise<SyncDirectoryPage> {
      if (typeof client.listChats !== "function") {
        return { members: [], complete: true };
      }
      const state = parseDirectoryCursor(cursor, wantsGroup, wantsP2p);
      if (state.phase === "mixed") {
        return listPhase(client, kinds, state.token, "mixed", false);
      }
      if (state.phase === "group") {
        return listPhase(client, ["group"], state.token, "group", wantsP2p);
      }
      return listPhase(client, ["p2p"], state.token, "p2p", false);
    },
  };
}

async function listPhase(
  client: Pick<FeishuImClient, "listChats">,
  types: FeishuChatMode[],
  token: string | undefined,
  phase: DirectoryPhase,
  continueToP2p: boolean,
): Promise<SyncDirectoryPage> {
      const page = await client.listChats!({
    page_size: phase === "group" ? GROUP_PAGE_SIZE : P2P_PAGE_SIZE,
    page_token: token,
    types,
    // Groups already carry name on /im/v1/chats. P2p needs contact fill.
    names: phase === "p2p" || phase === "mixed",
  });
  const members = page.items
    .filter((chat) => chatMatchesKinds(chat, types))
    .map((chat) => ({
      stream_key: feishuStreamKey(chat.chat_id),
      thread_id: `${FEISHU_SOURCE}:${chat.chat_id}`,
      ...(chat.name?.trim() ? { label: chat.name.trim() } : {}),
      kind: chat.chat_mode,
    }));
  if (page.has_more === true && page.page_token) {
    return {
      members,
      next_cursor:
        phase === "mixed"
          ? page.page_token
          : encodeDirectoryCursor(phase, page.page_token),
      complete: false,
    };
  }
  return {
    members,
    next_cursor: continueToP2p ? encodeDirectoryCursor("p2p") : undefined,
    complete: !continueToP2p,
  };
}

type DirectoryPhase = "group" | "p2p" | "mixed";

function parseDirectoryCursor(
  cursor: string | null,
  wantsGroup: boolean,
  wantsP2p: boolean,
): { phase: DirectoryPhase; token?: string } {
  if (!cursor) {
    return { phase: wantsGroup ? "group" : "p2p" };
  }
  try {
    const parsed = JSON.parse(cursor) as { phase?: unknown; token?: unknown };
    if (parsed.phase === "group" || parsed.phase === "p2p") {
      return {
        phase: parsed.phase,
        token: typeof parsed.token === "string" ? parsed.token : undefined,
      };
    }
  } catch {
    // A leftover +chat-list token from before the split census.
  }
  if (wantsGroup && wantsP2p) {
    return { phase: "mixed", token: cursor };
  }
  return { phase: wantsGroup ? "group" : "p2p", token: cursor };
}

function encodeDirectoryCursor(phase: "group" | "p2p", token?: string): string {
  return JSON.stringify(token ? { phase, token } : { phase });
}

function chatMatchesKinds(chat: FeishuChat, kinds: FeishuChatMode[]): boolean {
  return !chat.chat_mode || kinds.includes(chat.chat_mode);
}

async function listRecentFeishuCatalogChats(
  client: FeishuRecentCatalogClient,
  kinds: FeishuChatMode[],
): Promise<FeishuChat[]> {
  try {
    if (client.listRecentChats) {
      return (await client.listRecentChats(kinds, { names: true })).filter((chat) =>
        chatMatchesKinds(chat, kinds),
      );
    }
    if (client.listChats) {
      const page = await client.listChats({
        page_size: 50,
        types: kinds,
        names: kinds.includes("p2p"),
      });
      return page.items.filter((chat) => chatMatchesKinds(chat, kinds));
    }
  } catch {
    // Keep the install usable when the directory misses.
  }
  return [];
}
