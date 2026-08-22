import { randomUUID } from "node:crypto";
import { DshApiError, type DshHistoryEvent, type DshHistoryPage } from "./dsh-cli-client";
import type { DshPromptPart } from "./dsh-prompt-part";

export interface DshFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type DshFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<DshFetchResponse>;

export interface DshWebRpcClientOptions {
  base_url: string;
  access_token?: string;
  fetch?: DshFetch;
  createId?: () => string;
}

export interface DshSessionPromptInput {
  sessionId: string;
  text?: string;
  content?: DshPromptPart[];
}

export interface DshSessionListPage {
  session_ids: string[];
  next_cursor?: string;
  has_more: boolean;
}

export class DshWebRpcClient {
  private readonly baseUrl: string;
  private readonly fetch: DshFetch;
  private readonly createId: () => string;

  constructor(private readonly options: DshWebRpcClientOptions) {
    this.baseUrl = options.base_url.replace(/\/+$/, "");
    if (this.baseUrl.length === 0) {
      throw new Error("DSH base_url must be a non-empty URL");
    }
    this.fetch = options.fetch ?? fetch;
    this.createId = options.createId ?? randomUUID;
  }

  async sessionHistory(input: {
    sessionId: string;
    maxMessages?: number;
    beforeSeq?: number;
  }): Promise<DshHistoryPage> {
    const payload: Record<string, unknown> = { sessionId: input.sessionId };
    if (input.maxMessages !== undefined) {
      payload.maxMessages = input.maxMessages;
    }
    if (input.beforeSeq !== undefined) {
      payload.beforeSeq = input.beforeSeq;
    }
    const { value } = await this.call("session.history", payload);
    return parseHistoryPage(value);
  }

  async sessionList(input: { cursor?: string } = {}): Promise<DshSessionListPage> {
    const payload: Record<string, unknown> = {};
    if (input.cursor) {
      payload.cursor = input.cursor;
    }
    const { value } = await this.call("session.list", payload);
    return parseSessionListPage(value);
  }

  async listAllSessionIds(options: {
    max_pages?: number;
    max_sessions?: number;
  } = {}): Promise<string[]> {
    const maxPages = options.max_pages ?? 20;
    const maxSessions = options.max_sessions ?? 100;
    const ids: string[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const listed = await this.sessionList(cursor ? { cursor } : {});
      for (const sessionId of listed.session_ids) {
        if (seen.has(sessionId)) {
          continue;
        }
        seen.add(sessionId);
        ids.push(sessionId);
        if (ids.length >= maxSessions) {
          return ids;
        }
      }
      if (!listed.has_more || !listed.next_cursor || listed.next_cursor === cursor) {
        break;
      }
      cursor = listed.next_cursor;
    }
    return ids;
  }

  async sessionCreate(
    input: { workspaceId?: string; cwd?: string; agentPreset?: string } = {},
  ): Promise<{ sessionId: string }> {
    const payload: Record<string, unknown> = {};
    if (input.workspaceId) {
      payload.workspaceId = input.workspaceId;
    }
    if (input.cwd) {
      payload.cwd = input.cwd;
    }
    if (input.agentPreset) {
      payload.agentPreset = input.agentPreset;
    }
    const { value } = await this.call("session.create", payload);
    const sessionId = createdSessionId(value);
    if (!sessionId) {
      throw new DshApiError("DSH session.create did not return a sessionId");
    }
    return { sessionId };
  }

  async sessionPrompt(input: DshSessionPromptInput): Promise<{
    accepted: true;
    rpc_id: string;
  }> {
    const { rpc_id } = await this.call("session.prompt", {
      sessionId: input.sessionId,
      mode: "queue",
      content: promptContent(input),
    });
    return { accepted: true, rpc_id };
  }

  private async call(
    method: string,
    payload: Record<string, unknown>,
  ): Promise<{ value: unknown; rpc_id: string }> {
    const rpcId = this.createId();
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.options.access_token) {
      headers.authorization = `Bearer ${this.options.access_token}`;
    }
    const url = `${this.baseUrl}/api/${method}`;
    let response: DshFetchResponse;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          type: "client-request",
          rpcId,
          method,
          payload,
        }),
      });
    } catch (error) {
      throw new DshApiError(
        `Cannot reach DSH web at ${this.baseUrl} (is \`dsh web\` running?): ${
          error instanceof Error ? error.message : String(error)
        }`,
        "unavailable",
      );
    }
    if (!response.ok) {
      throw new DshApiError(`DSH HTTP ${response.status}`, "internal");
    }
    return parseServerResponse(await response.json(), rpcId);
  }
}

function parseSessionListPage(value: unknown): DshSessionListPage {
  const page = isObject(value) ? value : {};
  const items = Array.isArray(value)
    ? value
    : Array.isArray(page.items)
      ? page.items
      : [];
  const sessionIds = items.flatMap((item) => {
    const sessionId = sessionIdFromListItem(item);
    return sessionId ? [sessionId] : [];
  });
  const nextCursor =
    stringField(page, "nextCursor")
    ?? stringField(page, "next_cursor")
    ?? stringField(page, "cursor");
  return {
    session_ids: sessionIds,
    next_cursor: nextCursor,
    has_more: page.hasMore === true || page.has_more === true || Boolean(nextCursor),
  };
}

function createdSessionId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (!isObject(value)) {
    return undefined;
  }
  return (
    stringField(value, "sessionId")
    ?? stringField(value, "session_id")
    ?? stringField(value, "id")
  );
}

function sessionIdFromListItem(item: unknown): string | undefined {
  if (typeof item === "string" && item.trim().length > 0) {
    return item.trim();
  }
  if (!isObject(item)) {
    return undefined;
  }
  return (
    stringField(item, "sessionId")
    ?? stringField(item, "session_id")
    ?? stringField(item, "id")
  );
}

function stringField(
  value: Record<string, unknown>,
  name: string,
): string | undefined {
  const field = value[name];
  return typeof field === "string" && field.trim().length > 0
    ? field.trim()
    : undefined;
}

function parseHistoryPage(value: unknown): DshHistoryPage {
  if (!isObject(value) || !Array.isArray(value.events)) {
    throw new DshApiError("DSH session.history returned an invalid page");
  }
  return {
    hasMore: value.hasMore === true,
    events: value.events.map((item, index) => {
      const event = unwrapHistoryEntry(item);
      if (
        !isObject(event) ||
        typeof event.type !== "string" ||
        !Number.isInteger(event.seq) ||
        !Number.isFinite(event.time)
      ) {
        throw new DshApiError(`DSH history event ${index} is invalid`);
      }
      return event as unknown as DshHistoryEvent;
    }),
  };
}

function unwrapHistoryEntry(item: unknown): unknown {
  if (
    isObject(item) &&
    isObject(item.event) &&
    typeof item.event.type === "string"
  ) {
    return item.event;
  }
  return item;
}

function parseServerResponse(
  body: unknown,
  rpcId: string,
): { value: unknown; rpc_id: string } {
  if (!isObject(body) || body.type !== "server-response") {
    throw new DshApiError("DSH response is not a server-response");
  }
  if (body.rpcId !== rpcId) {
    throw new DshApiError("DSH response rpcId does not match the request");
  }
  if (!isObject(body.result)) {
    throw new DshApiError("DSH response result is missing");
  }
  if (body.result.ok === true) {
    return { value: body.result.value, rpc_id: rpcId };
  }
  const error = isObject(body.result.error) ? body.result.error : {};
  throw new DshApiError(
    typeof error.message === "string" ? error.message : "DSH request failed",
    typeof error.code === "string" ? error.code : undefined,
  );
}

export function promptContent(input: {
  text?: string;
  content?: DshPromptPart[];
}): DshPromptPart[] {
  if (input.content && input.content.length > 0) {
    if (input.content.some((part) => part.type === "text")) {
      return input.content;
    }
    const text = input.text?.trim() ?? "";
    return text.length > 0
      ? [{ type: "text", text }, ...input.content]
      : input.content;
  }
  return [{ type: "text", text: input.text ?? "" }];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
