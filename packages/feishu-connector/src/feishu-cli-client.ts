import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

export class FeishuApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "FeishuApiError";
  }
}

export interface FeishuSpawnResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export type FeishuSpawn = (input: {
  command: string[];
  env?: NodeJS.ProcessEnv;
  timeout_ms: number;
}) => Promise<FeishuSpawnResult>;

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
  };
  body?: {
    content?: string;
  };
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
}

export interface FeishuImClient {
  listMessages(input: FeishuListInput): Promise<FeishuHistoryPage>;
  sendText(input: {
    chat_id: string;
    text: string;
    uuid?: string;
  }): Promise<{ message_id: string }>;
}

export interface LarkCliClientOptions {
  command?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: FeishuSpawn;
  timeout_ms?: number;
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

  async listMessages(input: FeishuListInput): Promise<FeishuHistoryPage> {
    const params: Record<string, string | number> = {
      container_id_type: "chat",
      container_id: input.chat_id,
      sort_type: "ByCreateTimeAsc",
      page_size: input.page_size,
    };
    if (input.page_token) {
      params.page_token = input.page_token;
    }
    if (input.start_time) {
      params.start_time = input.start_time;
    }
    const payload = await this.request({
      method: "GET",
      path: "/open-apis/im/v1/messages",
      params,
    });
    return parseHistoryPage(payload);
  }

  async sendText(input: {
    chat_id: string;
    text: string;
    uuid?: string;
  }): Promise<{ message_id: string }> {
    const payload = await this.request({
      method: "POST",
      path: "/open-apis/im/v1/messages",
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: input.chat_id,
        msg_type: "text",
        content: JSON.stringify({ text: input.text }),
        ...(input.uuid ? { uuid: input.uuid } : {}),
      },
    });
    const messageId = readMessageId(payload);
    if (!messageId) {
      throw new FeishuApiError("lark-cli send did not return message_id");
    }
    return { message_id: messageId };
  }

  async authStatus(): Promise<boolean> {
    const result = await this.spawn({
      command: [this.command, "auth", "status", "--json"],
      env: this.options.env,
      timeout_ms: Math.min(this.timeoutMs, 2_000),
    });
    return larkCliUserReady(result.stdout, result.exit_code);
  }

  private async request(input: {
    method: "GET" | "POST";
    path: string;
    params?: Record<string, string | number>;
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
    const result = await this.spawn({
      command: argv,
      env: this.options.env,
      timeout_ms: this.timeoutMs,
    });
    return unwrapLarkCli(result);
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
          }
        : undefined,
      body: isObject(value.body)
        ? { content: stringValue(value.body.content) }
        : undefined,
    },
  ];
}

function readMessageId(value: unknown): string | undefined {
  if (isObject(value) && typeof value.message_id === "string") {
    return value.message_id;
  }
  if (isObject(value) && isObject(value.data) && typeof value.data.message_id === "string") {
    return value.data.message_id;
  }
  return undefined;
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
}): Promise<FeishuSpawnResult> {
  const [bin, ...args] = input.command;
  if (!bin) {
    throw new FeishuApiError("lark-cli command is missing");
  }
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, ...input.env },
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
