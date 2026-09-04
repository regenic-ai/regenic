import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import {
  currentSyncLane,
  DeadlineExceededError,
  SyncSlotPool,
  withDeadline,
} from "@regenic/domain";
import { sniffMediaType } from "./feishu-message";
import type { FeishuMention } from "./feishu-message";
import {
  FeishuApiError,
  callFeishuOpenApi,
  callFeishuOpenApiBytes,
  feishuOpenApiBaseUrl,
  isFeishuTokenError,
  type FeishuOpenApiParams,
  type FeishuSortType,
} from "./feishu-openapi";
import type { FeishuUserTokenSource } from "./feishu-user-token";
import { parseFeishuReadStatus } from "./feishu-attention";

export { FeishuApiError, type FeishuSortType } from "./feishu-openapi";

export interface FeishuSpawnResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export type FeishuSpawn = (input: {
  command: string[];
  env?: NodeJS.ProcessEnv;
  timeout_ms: number;
  cwd?: string;
}) => Promise<FeishuSpawnResult>;

export interface FeishuUploadFile {
  filename: string;
  media_type: string;
  bytes: Uint8Array;
}

export interface FeishuDownloadResource {
  message_id: string;
  file_key: string;
  type: "image" | "file";
}

export interface FeishuDownloadedFile {
  bytes: Uint8Array;
  media_type: string;
  filename?: string;
}

export interface FeishuSendMessageInput {
  chat_id: string;
  msg_type: string;
  content: Record<string, unknown>;
  uuid?: string;
}

export interface FeishuHistoryItem {
  message_id: string;
  msg_type: string;
  create_time?: string;
  deleted?: boolean;
  chat_id?: string;
  root_id?: string;
  parent_id?: string;
  sender?: {
    id?: string;
    sender_type?: string;
    name?: string;
  };
  body?: {
    content?: string;
  };
  mentions?: FeishuMention[];
}

export interface FeishuHistoryPage {
  items: FeishuHistoryItem[];
  has_more: boolean;
  page_token?: string;
}

export interface FeishuListInput {
  chat_id: string;
  page_size: number;
  page_token?: string;
  start_time?: string;
  sort_type?: FeishuSortType;
}

export type FeishuChatMode = "group" | "p2p";

export interface FeishuChat {
  chat_id: string;
  name?: string;
  chat_mode?: FeishuChatMode;
  p2p_target_id?: string;
}

export interface FeishuChatPage {
  items: FeishuChat[];
  has_more: boolean;
  page_token?: string;
}

export interface FeishuImClient {
  listMessages(input: FeishuListInput): Promise<FeishuHistoryPage>;
  listChats?(input: {
    page_size: number;
    page_token?: string;
    types?: FeishuChatMode[];
    names?: boolean;
  }): Promise<FeishuChatPage>;
  getChat?(chatId: string): Promise<FeishuChat | null>;
  sendText(input: {
    chat_id: string;
    text: string;
    uuid?: string;
  }): Promise<{ message_id: string }>;
  sendMessage?(input: FeishuSendMessageInput): Promise<{ message_id: string }>;
  uploadImage?(input: FeishuUploadFile): Promise<{ image_key: string }>;
  uploadFile?(input: FeishuUploadFile): Promise<{ file_key: string }>;
  downloadResource?(input: FeishuDownloadResource): Promise<FeishuDownloadedFile>;
  resolveUserNames?(ids: string[]): Promise<Map<string, string>>;
  readMessageStatus?(messageIds: string[]): Promise<Map<string, boolean>>;
  readMessageUsers?(messageId: string): Promise<unknown>;
  selfUserId?(): Promise<string | undefined>;
}

export interface LarkCliClientOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: FeishuSpawn;
  timeout_ms?: number;
  userToken?: FeishuUserTokenSource;
  fetch?: typeof fetch;
}

export const LARK_CLI_CONCURRENCY = 2;
export const LARK_CLI_RETRIES = 2;

const larkCliSlots = new SyncSlotPool({
  total: LARK_CLI_CONCURRENCY,
  reserved: { interactive: 1 },
});

const readStatusInflight = new Map<string, Promise<Map<string, boolean>>>();

export async function withLarkCliSlot<T>(work: () => Promise<T>): Promise<T> {
  return larkCliSlots.withSlot(currentSyncLane(), work);
}

export function resetLarkCliSlot(): void {
  larkCliSlots.reset();
  readStatusInflight.clear();
}

export function isMissingLarkShortcutError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /unknown|not found|no such|unrecognized|invalid command|\+message-read-users/i.test(
    text,
  );
}

export function isTransientLarkError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const code = error instanceof FeishuApiError ? error.code : undefined;
  return (
    /timed out|EAGAIN|ECONNRESET|socket hang up|rate.?limit|too many requests/i.test(
      text,
    ) ||
    code === "99991400" ||
    code === "99991429"
  );
}

async function retryTransientLark<T>(work: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= LARK_CLI_RETRIES; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      last = error;
      if (attempt === LARK_CLI_RETRIES || !isTransientLarkError(error)) {
        throw error;
      }
      await delay(250 * (attempt + 1));
    }
  }
  throw last;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class LarkCliClient implements FeishuImClient {
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly spawn: FeishuSpawn;

  constructor(private readonly options: LarkCliClientOptions = {}) {
    this.command = resolveLarkCommand(
      options.command ?? options.env?.REGENIC_LARK_CLI ?? process.env.REGENIC_LARK_CLI,
    );
    this.timeoutMs = options.timeout_ms ?? 60_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("lark-cli timeout_ms must be a positive integer");
    }
    this.spawn = options.spawn ?? spawnLarkProcess;
  }

  async selfUserId(): Promise<string | undefined> {
    const id = (await this.options.userToken?.identity())?.user_open_id?.trim();
    return id || undefined;
  }

  private runCli(input: {
    command: string[];
    env?: NodeJS.ProcessEnv;
    timeout_ms: number;
    cwd?: string;
  }): Promise<FeishuSpawnResult> {
    return retryTransientLark(() =>
      withLarkCliSlot(() => this.spawn(input)),
    );
  }

  async listMessages(input: FeishuListInput): Promise<FeishuHistoryPage> {
    const params: Record<string, string | number> = {
      container_id_type: "chat",
      container_id: input.chat_id,
      sort_type: input.sort_type ?? "ByCreateTimeAsc",
      page_size: input.page_size,
      user_id_type: "open_id",
    };
    if (input.page_token) {
      params.page_token = input.page_token;
    }
    if (input.start_time) {
      params.start_time = input.start_time;
    }
    const request = {
      method: "GET" as const,
      path: "/open-apis/im/v1/messages",
      params,
    };
    // HTTP list shares the CLI slot pool so interactive polls keep a reserved lane.
    const viaHttp = this.options.userToken
      ? await withLarkCliSlot(() => this.requestViaHttp(request))
      : undefined;
    const payload =
      viaHttp !== undefined ? viaHttp : await this.requestViaCli(request);
    return parseHistoryPage(payload);
  }

  async listChats(input: {
    page_size: number;
    page_token?: string;
    types?: FeishuChatMode[];
    names?: boolean;
  }): Promise<FeishuChatPage> {
    const types = normalizeChatTypes(input.types);
    const page =
      types.length === 1 && types[0] === "group"
        ? await this.listChatsViaOpenApi(input)
        : await this.listChatsViaShortcut(input, types);
    if (input.names !== false) {
      await this.fillP2pNames(page.items);
    }
    return page;
  }

  /** Official /im/v1/chats is groups only. Used when the census does not need p2p. */
  private async listChatsViaOpenApi(input: {
    page_size: number;
    page_token?: string;
  }): Promise<FeishuChatPage> {
    const params: Record<string, string | number> = {
      page_size: Math.min(Math.max(1, input.page_size), 100),
      sort_type: "ByActiveTimeDesc",
      user_id_type: "open_id",
    };
    if (input.page_token) {
      params.page_token = input.page_token;
    }
    const request = {
      method: "GET" as const,
      path: "/open-apis/im/v1/chats",
      params,
    };
    const viaHttp = this.options.userToken
      ? await withLarkCliSlot(() => this.requestViaHttp(request))
      : undefined;
    const page = parseChatPage(
      viaHttp !== undefined ? viaHttp : await this.requestViaCli(request),
    );
    return {
      ...page,
      items: page.items.map((chat) => ({
        ...chat,
        chat_mode: chat.chat_mode ?? "group",
      })),
    };
  }

  async getChat(chatId: string): Promise<FeishuChat | null> {
    const id = chatId.trim();
    if (!id) {
      return null;
    }
    const cached = chatInfoCache.get(id);
    const now = Date.now();
    if (cached && now - cached.at < CHAT_INFO_TTL_MS) {
      return cached.chat ? { ...cached.chat } : null;
    }
    try {
      const payload = await this.request({
        method: "GET",
        path: `/open-apis/im/v1/chats/${encodeURIComponent(id)}`,
        params: { user_id_type: "open_id" },
      });
      const chat = parseChat(payload)[0] ?? null;
      if (chat && !chat.name && chat.p2p_target_id) {
        await this.fillP2pNames([chat]);
      }
      chatInfoCache.set(id, { chat, at: now });
      return chat ? { ...chat } : null;
    } catch {
      chatInfoCache.set(id, { chat: null, at: now });
      return null;
    }
  }

  private async listChatsViaShortcut(
    input: {
      page_size: number;
      page_token?: string;
    },
    types: FeishuChatMode[],
  ): Promise<FeishuChatPage> {
    const argv = [
      this.command,
      "im",
      "+chat-list",
      "--as",
      "user",
      "--types",
      types.join(","),
      "--page-size",
      String(input.page_size),
      "--format",
      "json",
    ];
    if (input.page_token) {
      argv.push("--page-token", input.page_token);
    }
    const result = await this.runCli({
      command: argv,
      env: this.options.env,
      timeout_ms: this.timeoutMs,
    });
    return parseChatPage(unwrapLarkCli(result));
  }

  async listRecentChats(
    types?: FeishuChatMode[],
    options?: { names?: boolean },
  ): Promise<FeishuChat[]> {
    const named = options?.names !== false;
    const key = `recent:${normalizeChatTypes(types).join(",")}:${named ? "named" : "id"}`;
    return this.cachedChatList(key, RECENT_CHAT_LIST_TTL_MS, async () => {
      const normalized = normalizeChatTypes(types);
      if (normalized.includes("group") && normalized.includes("p2p")) {
        const [groupPage, p2pPage] = await Promise.all([
          this.listChats({
            page_size: 50,
            types: ["group"],
            names: named,
          }),
          this.listChats({
            page_size: 50,
            types: ["p2p"],
            names: named,
          }),
        ]);
        return [...groupPage.items, ...p2pPage.items];
      }
      const page = await this.listChats({
        page_size: 50,
        types,
        names: named,
      });
      return page.items;
    });
  }

  async listAllChats(
    maxPages = 10,
    types?: FeishuChatMode[],
    options?: { deadline?: number },
  ): Promise<FeishuChat[]> {
    const key = `all:${normalizeChatTypes(types).join(",")}`;
    if (options?.deadline) {
      return this.fetchAllChats(maxPages, types, options.deadline);
    }
    return this.cachedChatList(key, CHAT_LIST_TTL_MS, () =>
      this.fetchAllChats(maxPages, types),
    );
  }

  private async cachedChatList(
    key: string,
    ttlMs: number,
    load: () => Promise<FeishuChat[]>,
  ): Promise<FeishuChat[]> {
    const cached = chatListCache.get(key);
    if (cached && Date.now() - cached.at < ttlMs) {
      return cached.chats;
    }
    const pending = chatListInflight.get(key);
    if (pending) {
      return pending;
    }
    const job = load().then((chats) => {
      chatListCache.set(key, { at: Date.now(), chats });
      return chats;
    });
    chatListInflight.set(key, job);
    try {
      return await job;
    } finally {
      if (chatListInflight.get(key) === job) {
        chatListInflight.delete(key);
      }
    }
  }

  private async fetchAllChats(
    maxPages: number,
    types?: FeishuChatMode[],
    deadline?: number,
  ): Promise<FeishuChat[]> {
    const normalized = normalizeChatTypes(types);
    const chats: FeishuChat[] = [];
    if (normalized.includes("group")) {
      chats.push(...(await this.fetchChatPages(maxPages, ["group"], deadline)));
    }
    if (normalized.includes("p2p")) {
      chats.push(...(await this.fetchChatPages(maxPages, ["p2p"], deadline)));
    }
    return chats;
  }

  private async fetchChatPages(
    maxPages: number,
    types: FeishuChatMode[],
    deadline?: number,
  ): Promise<FeishuChat[]> {
    const chats: FeishuChat[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const remaining = deadline ? deadline - Date.now() : 0;
      if (deadline && remaining <= 0) {
        break;
      }
      try {
        const result = await withDeadline(
          this.listChats({
            page_size: 50,
            page_token: pageToken,
            types,
            names: types.includes("p2p"),
          }),
          deadline ? remaining : 0,
          "catalog chat page",
        );
        chats.push(...result.items);
        if (!result.has_more || !result.page_token) {
          break;
        }
        pageToken = result.page_token;
      } catch (error) {
        if (deadline && error instanceof DeadlineExceededError) {
          break;
        }
        throw error;
      }
    }
    return chats;
  }

  async sendText(input: {
    chat_id: string;
    text: string;
    uuid?: string;
  }): Promise<{ message_id: string }> {
    return this.sendMessage({
      chat_id: input.chat_id,
      msg_type: "text",
      content: { text: input.text },
      uuid: input.uuid,
    });
  }

  async sendMessage(input: FeishuSendMessageInput): Promise<{ message_id: string }> {
    const payload = await this.request({
      method: "POST",
      path: "/open-apis/im/v1/messages",
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: input.chat_id,
        msg_type: input.msg_type,
        content: JSON.stringify(input.content),
        ...(input.uuid ? { uuid: input.uuid } : {}),
      },
    });
    const messageId = readMessageId(payload);
    if (!messageId) {
      throw new FeishuApiError("lark-cli send did not return message_id");
    }
    return { message_id: messageId };
  }

  async uploadImage(input: FeishuUploadFile): Promise<{ image_key: string }> {
    const payload = await this.uploadResource({
      resource: "images",
      fields: { image_type: "message" },
      file: input,
    });
    const imageKey = stringField(payload, "image_key");
    if (!imageKey) {
      throw new FeishuApiError("Feishu image upload did not return image_key");
    }
    return { image_key: imageKey };
  }

  async uploadFile(input: FeishuUploadFile): Promise<{ file_key: string }> {
    const filename = uploadFilename(input.filename, "attachment");
    const payload = await this.uploadResource({
      resource: "files",
      fields: {
        file_type: feishuFileType(input.media_type, filename),
        file_name: filename,
      },
      file: { ...input, filename },
    });
    const fileKey = stringField(payload, "file_key");
    if (!fileKey) {
      throw new FeishuApiError("Feishu file upload did not return file_key");
    }
    return { file_key: fileKey };
  }

  async downloadResource(input: FeishuDownloadResource): Promise<FeishuDownloadedFile> {
    const messageId = input.message_id.trim();
    const fileKey = input.file_key.trim();
    if (!messageId || !fileKey) {
      throw new FeishuApiError("Feishu download needs message_id and file_key");
    }
    try {
      return await this.downloadResourceViaCli({
        message_id: messageId,
        file_key: fileKey,
        type: input.type,
      });
    } catch (cliError) {
      try {
        const downloaded = await this.requestViaHttpBytes({
          method: "GET",
          path: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`,
          params: { type: input.type },
        });
        if (downloaded && downloaded.bytes.byteLength > 0) {
          return downloaded;
        }
      } catch {
        // User-token HTTP often returns JSON instead of file bytes.
      }
      throw cliError;
    }
  }

  private async downloadResourceViaCli(
    input: FeishuDownloadResource,
  ): Promise<FeishuDownloadedFile> {
    const directory = await mkdtemp(join(tmpdir(), "regenic-feishu-dl-"));
    const filename = input.type === "image" ? "image.bin" : "file.bin";
    try {
      const result = await this.runCli({
        command: [
          this.command,
          "im",
          "+messages-resources-download",
          "--as",
          "user",
          "--format",
          "json",
          "--message-id",
          input.message_id,
          "--file-key",
          input.file_key,
          "--type",
          input.type,
          "--output",
          `./${filename}`,
        ],
        env: this.options.env,
        timeout_ms: this.timeoutMs,
        cwd: directory,
      });
      const payload = unwrapLarkCli(result);
      const saved =
        stringField(payload, "saved_path") ??
        stringField(payload, "output") ??
        filename;
      const bytes = await readFile(isAbsolute(saved) ? saved : join(directory, saved));
      if (bytes.byteLength === 0) {
        throw new FeishuApiError("Feishu download saved an empty file");
      }
      const savedName = basename(saved);
      return {
        bytes,
        media_type: sniffMediaType(
          bytes,
          input.type === "image" ? "image/png" : "application/octet-stream",
        ),
        filename:
          savedName === "image.bin" || savedName === "file.bin"
            ? undefined
            : savedName,
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async fillP2pNames(chats: FeishuChat[]): Promise<void> {
    const missing = chats.filter((chat) => !chat.name && chat.p2p_target_id);
    if (missing.length === 0) {
      return;
    }
    const names = await this.resolveUserNames(
      missing.map((chat) => chat.p2p_target_id as string),
    );
    for (const chat of missing) {
      const name = chat.p2p_target_id
        ? names.get(chat.p2p_target_id)
        : undefined;
      if (name) {
        chat.name = name;
      }
    }
  }

  async resolveUserNames(ids: string[]): Promise<Map<string, string>> {
    const unique = [
      ...new Set(
        ids
          .map((id) => id.trim())
          .filter((id) => id.length > 0 && id.toLowerCase() !== "all" && id.toLowerCase() !== "@_all"),
      ),
    ];
    const names = new Map<string, string>();
    const missing: string[] = [];
    const now = Date.now();
    for (const id of unique) {
      const cached = userNameCache.get(id);
      if (cached && now - cached.at < USER_NAME_TTL_MS) {
        names.set(id, cached.name);
      } else {
        missing.push(id);
      }
    }
    for (let index = 0; index < missing.length; index += 50) {
      const batch = missing.slice(index, index + 50);
      const lookedUp = await this.lookupUserNamesCached(batch);
      for (const [id, name] of lookedUp) {
        userNameCache.set(id, { name, at: now });
        names.set(id, name);
      }
    }
    return names;
  }

  async readMessageUsers(messageId: string): Promise<unknown> {
    const id = messageId.trim();
    if (!id.startsWith("om_")) {
      return { items: [] };
    }
    // Hot path: UAT HTTP first. CLI shortcut/api only when no usable token.
    const viaHttp = await this.requestViaHttp({
      method: "GET",
      path: `/open-apis/im/v1/messages/${encodeURIComponent(id)}/read_users`,
      params: { user_id_type: "open_id", page_size: 50 },
      timeout_ms: Math.min(this.timeoutMs, 8_000),
    });
    if (viaHttp !== undefined) {
      return viaHttp;
    }
    try {
      return await this.readMessageUsersViaShortcut(id);
    } catch (error) {
      if (!isMissingLarkShortcutError(error)) {
        throw error;
      }
      return this.requestViaCli({
        method: "GET",
        path: `/open-apis/im/v1/messages/${encodeURIComponent(id)}/read_users`,
        params: { user_id_type: "open_id", page_size: 50 },
      });
    }
  }

  async readMessageStatus(messageIds: string[]): Promise<Map<string, boolean>> {
    const ids = [...new Set(messageIds.filter((id) => id.startsWith("om_")))].slice(0, 50);
    if (ids.length === 0) {
      return new Map();
    }
    const key = ids.slice().sort().join(",");
    const existing = readStatusInflight.get(key);
    if (existing) {
      return existing;
    }
    const job = this.fetchMessageStatus(ids).finally(() => {
      if (readStatusInflight.get(key) === job) {
        readStatusInflight.delete(key);
      }
    });
    readStatusInflight.set(key, job);
    return job;
  }

  private async fetchMessageStatus(
    ids: string[],
  ): Promise<Map<string, boolean>> {
    try {
      const payload = await this.request({
        method: "POST",
        path: "/open-apis/im/v1/messages/read_status",
        data: { message_ids: ids },
      });
      return parseFeishuReadStatus(payload);
    } catch {
      return new Map();
    }
  }

  async authStatus(): Promise<boolean> {
    const result = await this.runCli({
      command: [this.command, "auth", "status", "--json"],
      env: this.options.env,
      timeout_ms: Math.min(this.timeoutMs, 2_000),
    });
    return larkCliUserReady(result.stdout, result.exit_code);
  }

  private async request(input: {
    method: "GET" | "POST";
    path: string;
    params?: FeishuOpenApiParams;
    data?: Record<string, unknown>;
  }): Promise<unknown> {
    const viaHttp = await this.requestViaHttp(input);
    if (viaHttp !== undefined) {
      return viaHttp;
    }
    // CLI only when there is no usable user token (or auth refresh failed).
    // Transient HTTP failures must not silently occupy the CLI process pool.
    return this.requestViaCli(input);
  }

  /** User read_users is UAT-capable over HTTP; CLI remains auth/setup fallback. */
  private async requestViaCli(input: {
    method: "GET" | "POST";
    path: string;
    params?: FeishuOpenApiParams;
    data?: Record<string, unknown>;
  }): Promise<unknown> {
    const argv = [
      this.command,
      "api",
      input.method,
      input.path,
      "--as",
      "user",
      "--format",
      "json",
    ];
    if (input.params && Object.keys(input.params).length > 0) {
      argv.push("--params", JSON.stringify(input.params));
    }
    if (input.data) {
      argv.push("--data", JSON.stringify(input.data));
    }
    const result = await this.runCli({
      command: argv,
      env: this.options.env,
      timeout_ms: this.timeoutMs,
    });
    return unwrapLarkCli(result);
  }

  private async readMessageUsersViaShortcut(messageId: string): Promise<unknown> {
    // Official user path is one page. `--page-all` defaults to --page-delay 200ms
    // and up to 10 pages; we only need items.length > 0 to paint Read.
    const result = await this.runCli({
      command: [
        this.command,
        "im",
        "+message-read-users",
        "--message-id",
        messageId,
        "--user-id-type",
        "open_id",
        "--as",
        "user",
        "--json",
      ],
      env: this.options.env,
      timeout_ms: Math.min(this.timeoutMs, 8_000),
    });
    return unwrapLarkCli(result);
  }

  private async uploadResource(input: {
    resource: "images" | "files";
    fields: Record<string, string>;
    file: FeishuUploadFile;
  }): Promise<unknown> {
    if (input.file.bytes.byteLength === 0) {
      throw new FeishuApiError("Feishu upload rejected an empty file");
    }
    const directory = await mkdtemp(join(tmpdir(), "regenic-feishu-"));
    const filename = uploadFilename(
      input.file.filename,
      input.resource === "images" ? "image.png" : "upload",
    );
    try {
      await writeFile(join(directory, filename), input.file.bytes);
      const result = await this.runCli({
        command: [
          this.command,
          "im",
          input.resource,
          "create",
          "--as",
          "user",
          "--format",
          "json",
          "--data",
          JSON.stringify(input.fields),
          "--file",
          `./${filename}`,
        ],
        env: this.options.env,
        timeout_ms: this.timeoutMs,
        cwd: directory,
      });
      return unwrapLarkCli(result);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async requestHttp(input: {
    method: "GET" | "POST";
    path: string;
    params?: FeishuOpenApiParams;
    data?: Record<string, unknown>;
    form?: FormData;
    token: string;
    timeout_ms?: number;
  }): Promise<unknown> {
    const brand = await this.options.userToken?.brand();
    return callFeishuOpenApi({
      method: input.method,
      path: input.path,
      params: input.params,
      data: input.data,
      form: input.form,
      token: input.token,
      base_url: feishuOpenApiBaseUrl(brand),
      fetch: this.options.fetch,
      timeout_ms: input.timeout_ms ?? Math.min(this.timeoutMs, 20_000),
    });
  }

  private async requestHttpBytes(input: {
    method: "GET";
    path: string;
    params?: FeishuOpenApiParams;
    token: string;
    timeout_ms?: number;
  }): Promise<FeishuDownloadedFile> {
    const brand = await this.options.userToken?.brand();
    return callFeishuOpenApiBytes({
      method: input.method,
      path: input.path,
      params: input.params,
      token: input.token,
      base_url: feishuOpenApiBaseUrl(brand),
      fetch: this.options.fetch,
      timeout_ms: input.timeout_ms ?? Math.min(this.timeoutMs, 20_000),
    });
  }

  private async requestViaHttpBytes(input: {
    method: "GET";
    path: string;
    params?: FeishuOpenApiParams;
    timeout_ms?: number;
  }): Promise<FeishuDownloadedFile | undefined> {
    const source = this.options.userToken;
    if (!source) {
      return undefined;
    }
    const token = await source.token();
    if (!token) {
      return undefined;
    }
    try {
      return await retryTransientLark(() => this.requestHttpBytes({ ...input, token }));
    } catch (error) {
      if (isFeishuTokenError(error)) {
        await source.refresh();
        const next = await source.token();
        if (next) {
          try {
            return await this.requestHttpBytes({ ...input, token: next });
          } catch {
            return undefined;
          }
        }
        return undefined;
      }
      if (isTransientLarkError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private async requestViaHttp(input: {
    method: "GET" | "POST";
    path: string;
    params?: FeishuOpenApiParams;
    data?: Record<string, unknown>;
    form?: FormData;
    timeout_ms?: number;
  }): Promise<unknown | undefined> {
    const source = this.options.userToken;
    if (!source) {
      return undefined;
    }
    const token = await source.token();
    if (!token) {
      return undefined;
    }
    try {
      return await retryTransientLark(() => this.requestHttp({ ...input, token }));
    } catch (error) {
      if (isFeishuTokenError(error)) {
        await source.refresh();
        const next = await source.token();
        if (next) {
          try {
            return await this.requestHttp({ ...input, token: next });
          } catch (retryError) {
            // Still an auth problem after refresh — allow CLI fallback.
            if (isFeishuTokenError(retryError)) {
              return undefined;
            }
            throw retryError;
          }
        }
        return undefined;
      }
      // Transient (timeout / rate limit): surface to caller. Do not spend a
      // lark-cli slot just because HTTP was briefly unhealthy.
      throw error;
    }
  }

  private async lookupUserNamesCached(ids: string[]): Promise<Map<string, string>> {
    const key = ids.slice().sort().join(",");
    const existing = userNameInflight.get(key);
    if (existing) {
      return existing;
    }
    const pending = this.lookupUserNamesFresh(ids).finally(() => {
      if (userNameInflight.get(key) === pending) {
        userNameInflight.delete(key);
      }
    });
    userNameInflight.set(key, pending);
    return pending;
  }

  /**
   * Prefer official contact batch over HTTP (user token). Fall back to
   * `contact +search-user` for missing ids or when no token is available.
   */
  private async lookupUserNamesFresh(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) {
      return new Map();
    }
    const viaHttp = await this.lookupUserNamesViaOpenApi(ids);
    if (!viaHttp) {
      return this.lookupUserNamesViaCli(ids);
    }
    const missing = ids.filter((id) => !viaHttp.has(id));
    if (missing.length === 0) {
      return viaHttp;
    }
    const viaCli = await this.lookupUserNamesViaCli(missing);
    for (const [id, name] of viaCli) {
      viaHttp.set(id, name);
    }
    return viaHttp;
  }

  private async lookupUserNamesViaOpenApi(
    ids: string[],
  ): Promise<Map<string, string> | undefined> {
    try {
      const payload = await this.requestViaHttp({
        method: "GET",
        path: "/open-apis/contact/v3/users/batch",
        params: {
          user_id_type: "open_id",
          user_ids: ids,
        },
        timeout_ms: Math.min(this.timeoutMs, 15_000),
      });
      if (payload === undefined) {
        return undefined;
      }
      return parseUserNamePage(payload);
    } catch {
      return undefined;
    }
  }

  private async lookupUserNamesViaCli(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) {
      return new Map();
    }
    try {
      const result = await this.runCli({
        command: [
          this.command,
          "contact",
          "+search-user",
          "--as",
          "user",
          "--user-ids",
          ids.join(","),
          "--format",
          "json",
        ],
        env: this.options.env,
        timeout_ms: Math.min(this.timeoutMs, 15_000),
      });
      return parseUserNamePage(unwrapLarkCli(result));
    } catch {
      return new Map();
    }
  }
}

export function resolveLarkCommand(configured?: string): string {
  const command = configured?.trim() || "lark-cli";
  if (isAbsolute(command) && !existsSync(command)) {
    return "lark-cli";
  }
  return command;
}

export function unwrapLarkCli(result: FeishuSpawnResult): unknown {
  const stdout = result.stdout.trim();
  let parsed: unknown;
  if (stdout.length > 0) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new FeishuApiError(
        result.stderr.trim() || "lark-cli returned invalid JSON",
      );
    }
  }
  if (isObject(parsed) && parsed.ok === false) {
    const error = isObject(parsed.error) ? parsed.error : undefined;
    throw new FeishuApiError(
      stringValue(error?.message) ??
        (result.stderr.trim() || "lark-cli request failed"),
      stringValue(error?.subtype) ??
        (typeof error?.code === "number" ? String(error.code) : undefined),
    );
  }
  if (result.exit_code !== 0) {
    throw new FeishuApiError(
      result.stderr.trim() || `lark-cli exited with code ${result.exit_code}`,
    );
  }
  if (isObject(parsed) && typeof parsed.code === "number" && parsed.code !== 0) {
    throw new FeishuApiError(
      stringValue(parsed.msg) ?? `Feishu API error ${parsed.code}`,
      String(parsed.code),
    );
  }
  if (isObject(parsed) && "data" in parsed) {
    return parsed.data;
  }
  return parsed;
}

export function parseChatPage(value: unknown): FeishuChatPage {
  const root = isObject(value) && isObject(value.data) ? value.data : value;
  if (!isObject(root)) {
    throw new FeishuApiError("Feishu chat list response is invalid");
  }
  const raw = Array.isArray(root.items)
    ? root.items
    : Array.isArray(root.chats)
      ? root.chats
      : [];
  return {
    items: raw.flatMap((item) => parseChat(item)),
    has_more: root.has_more === true,
    page_token: stringValue(root.page_token),
  };
}

function parseChat(value: unknown): FeishuChat[] {
  if (!isObject(value) || typeof value.chat_id !== "string") {
    return [];
  }
  const status = stringValue(value.chat_status);
  if (status && status !== "normal") {
    return [];
  }
  const chatMode = stringValue(value.chat_mode);
  const p2pTargetId = stringValue(value.p2p_target_id);
  return [
    {
      chat_id: value.chat_id,
      name: stringValue(value.name) ?? localizedName(value.localized_name),
      chat_mode:
        chatMode === "p2p" || chatMode === "group" ? chatMode : undefined,
      ...(p2pTargetId ? { p2p_target_id: p2pTargetId } : {}),
    },
  ];
}

const USER_NAME_TTL_MS = 10 * 60 * 1000;
const CHAT_INFO_TTL_MS = 10 * 60 * 1000;
const CHAT_LIST_TTL_MS = 5 * 60_000;
const RECENT_CHAT_LIST_TTL_MS = 2 * 60_000;
const userNameCache = new Map<string, { name: string; at: number }>();
const userNameInflight = new Map<string, Promise<Map<string, string>>>();
const chatInfoCache = new Map<string, { chat: FeishuChat | null; at: number }>();
const chatListCache = new Map<string, { at: number; chats: FeishuChat[] }>();
const chatListInflight = new Map<string, Promise<FeishuChat[]>>();

export function resetFeishuUserNameCache(): void {
  userNameCache.clear();
  userNameInflight.clear();
}

export function resetFeishuChatInfoCache(): void {
  chatInfoCache.clear();
}

export function resetFeishuChatListCache(): void {
  chatListCache.clear();
  chatListInflight.clear();
}

export function parseUserNamePage(value: unknown): Map<string, string> {
  const root = isObject(value) && isObject(value.data) ? value.data : value;
  const names = new Map<string, string>();
  if (!isObject(root)) {
    return names;
  }
  const raw = Array.isArray(root.users)
    ? root.users
    : Array.isArray(root.items)
      ? root.items
      : [];
  for (const item of raw) {
    if (!isObject(item)) {
      continue;
    }
    const id =
      stringValue(item.open_id) ??
      stringValue(item.user_id) ??
      stringValue(item.id);
    const name =
      stringValue(item.name) ??
      stringValue(item.user_name) ??
      stringValue(item.nickname) ??
      stringValue(item.en_name) ??
      localizedName(item.localized_name);
    if (id && name) {
      names.set(id, name);
    }
  }
  return names;
}

function localizedName(value: unknown): string | undefined {
  if (typeof value === "string") {
    return stringValue(value);
  }
  if (!isObject(value)) {
    return undefined;
  }
  return (
    stringValue(value.zh_cn) ??
    stringValue(value.en_us) ??
    stringValue(value.name)
  );
}

function senderName(sender: Record<string, unknown>): string | undefined {
  return (
    stringValue(sender.name) ??
    stringValue(sender.sender_name) ??
    localizedName(sender.localized_name)
  );
}

export function feishuChatOptionLabel(chat: FeishuChat): string {
  const kind = chat.chat_mode === "p2p" ? "Direct" : "Group";
  return chat.name ? `${kind} · ${chat.name}` : `${kind} · ${chat.chat_id}`;
}

function normalizeChatTypes(types?: FeishuChatMode[]): FeishuChatMode[] {
  const selected = new Set(
    (types ?? []).filter((type) => type === "group" || type === "p2p"),
  );
  if (selected.size === 0) {
    return ["group", "p2p"];
  }
  return (["group", "p2p"] as const).filter((type) => selected.has(type));
}

export function parseHistoryPage(value: unknown): FeishuHistoryPage {
  const root = isObject(value) && isObject(value.data) ? value.data : value;
  if (!isObject(root)) {
    throw new FeishuApiError("Feishu history response is invalid");
  }
  const items = Array.isArray(root.items)
    ? root.items.flatMap((item) => parseHistoryItem(item))
    : [];
  return {
    items,
    has_more: root.has_more === true,
    page_token: stringValue(root.page_token),
  };
}

export function larkCliUserReady(stdout: string, exitCode: number): boolean {
  if (exitCode !== 0) {
    return false;
  }
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return false;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!isObject(parsed) || parsed.ok === false) {
      return false;
    }
    if (parsed.identity === "user") {
      return true;
    }
    if (isObject(parsed.identities) && isObject(parsed.identities.user)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function parseHistoryItem(value: unknown): FeishuHistoryItem[] {
  if (!isObject(value) || typeof value.message_id !== "string") {
    return [];
  }
  return [
    {
      message_id: value.message_id,
      msg_type: stringValue(value.msg_type) ?? "",
      create_time: stringValue(value.create_time),
      deleted: value.deleted === true,
      chat_id: stringValue(value.chat_id),
      root_id: stringValue(value.root_id),
      parent_id: stringValue(value.parent_id),
      sender: isObject(value.sender)
        ? {
            id: stringValue(value.sender.id),
            sender_type: stringValue(value.sender.sender_type),
            name: senderName(value.sender),
          }
        : undefined,
      body: isObject(value.body)
        ? { content: stringValue(value.body.content) }
        : undefined,
      mentions: parseMentions(value.mentions),
    },
  ];
}

function parseMentions(value: unknown): FeishuMention[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const mentions = value.flatMap((item) => {
    if (!isObject(item)) {
      return [];
    }
    const mention: FeishuMention = {
      key: stringValue(item.key),
      id: stringValue(item.id),
      name: stringValue(item.name),
    };
    if (!mention.key && !mention.id && !mention.name) {
      return [];
    }
    return [mention];
  });
  return mentions.length > 0 ? mentions : undefined;
}

function readMessageId(value: unknown): string | undefined {
  return stringField(value, "message_id");
}

function stringField(value: unknown, name: string): string | undefined {
  if (isObject(value) && typeof value[name] === "string") {
    return stringValue(value[name]);
  }
  if (isObject(value) && isObject(value.data) && typeof value.data[name] === "string") {
    return stringValue(value.data[name]);
  }
  return undefined;
}

export function feishuFileType(mediaType: string, filename: string): string {
  const type = mediaType.trim().toLowerCase();
  const name = filename.trim().toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) {
    return "pdf";
  }
  return "stream";
}

export function uploadFilename(name: string, fallback: string): string {
  const base = name.replace(/[/\\]/g, "").replace(/^\.+/g, "").trim();
  const cleaned = (base.length > 0 ? base : fallback).slice(0, 120);
  return cleaned.length > 0 ? cleaned : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export async function spawnLarkProcess(input: {
  command: string[];
  env?: NodeJS.ProcessEnv;
  timeout_ms: number;
  cwd?: string;
}): Promise<FeishuSpawnResult> {
  const [bin, ...args] = input.command;
  if (!bin) {
    throw new FeishuApiError("lark-cli command is missing");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...input.env },
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new FeishuApiError(`lark-cli timed out after ${input.timeout_ms}ms`));
    }, input.timeout_ms);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(
        new FeishuApiError(
          `Unable to start lark-cli (is it on PATH?): ${error.message}`,
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exit_code: code ?? 1,
      });
    });
  });
}
