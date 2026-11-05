import { randomUUID } from "node:crypto";
import { DshApiError, type DshHistoryEvent, type DshHistoryPage } from "./dsh-cli-client";
import {
  dshMuxCancelFrame,
  dshMuxOpenFrame,
  openDshMuxSocket,
  type DshMuxOpen,
  type DshMuxSocket,
} from "./dsh-mux-socket";
import type { DshPromptPart } from "./dsh-prompt-part";

export interface DshFetchResponse {
  ok: boolean;
  status: number;
  headers?: Pick<Headers, "get">;
  json(): Promise<unknown>;
}

export type DshFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    redirect?: "follow" | "error" | "manual";
    signal?: AbortSignal;
  },
) => Promise<DshFetchResponse>;

export interface DshWebRpcClientOptions {
  base_url: string;
  access_token?: string;
  fetch?: DshFetch;
  createId?: () => string;
  openSocket?: DshMuxOpen;
  stream_timeout_ms?: number;
}

export interface DshMuxConnection {
  url: string;
  cookie: string;
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
  private readonly openSocket: DshMuxOpen;
  private readonly streamTimeoutMs: number;
  private readonly throughSeqs = new Map<string, number>();
  private connectionPromise: Promise<DshMuxConnection> | null = null;

  constructor(private readonly options: DshWebRpcClientOptions) {
    this.baseUrl = options.base_url.replace(/\/+$/, "");
    if (this.baseUrl.length === 0) {
      throw new Error("DSH base_url must be a non-empty URL");
    }
    this.fetch = options.fetch ?? fetch;
    this.createId = options.createId ?? randomUUID;
    this.openSocket = options.openSocket ?? openDshMuxSocket;
    this.streamTimeoutMs = options.stream_timeout_ms ?? 10_000;
  }

  /**
   * DSH serves history as a `session/follow` opening snapshot (newest window)
   * plus backwards `session/page` reads bounded by that snapshot's cursor.
   */
  async sessionHistory(input: {
    sessionId: string;
    maxMessages?: number;
    beforeSeq?: number;
  }): Promise<DshHistoryPage> {
    if (input.beforeSeq === undefined) {
      const snapshot = await this.followSnapshot(input.sessionId, input.maxMessages);
      return { events: snapshot.events, hasMore: snapshot.hasMore };
    }
    const throughSeq =
      this.throughSeqs.get(input.sessionId)
      ?? (await this.followSnapshot(input.sessionId, 1)).cursor;
    const request: Record<string, unknown> = {
      address: sessionAddress(input.sessionId),
      throughSeq,
      beforeSeq: input.beforeSeq,
    };
    if (input.maxMessages !== undefined) {
      request.maxMessages = input.maxMessages;
    }
    const { value } = await this.call("session/page", { request });
    return parseHistoryPage(value);
  }

  async sessionList(input: { cursor?: string } = {}): Promise<DshSessionListPage> {
    const request: Record<string, unknown> = {};
    if (input.cursor) {
      request.cursor = input.cursor;
    }
    const { value } = await this.call("session/list", { _request: request });
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
    const request: Record<string, unknown> = {};
    if (input.workspaceId) {
      request.workspaceId = input.workspaceId;
    }
    if (input.cwd) {
      request.cwd = input.cwd;
    }
    if (input.agentPreset) {
      request.agentPreset = input.agentPreset;
    }
    const { value } = await this.call("session/create", { request });
    const sessionId = createdSessionId(value);
    if (!sessionId) {
      throw new DshApiError("DSH session/create did not return a sessionId");
    }
    return { sessionId };
  }

  async sessionPrompt(input: DshSessionPromptInput): Promise<{
    accepted: true;
    rpc_id: string;
  }> {
    const requestId = this.createId();
    await this.call("session/prompt", {
      request: {
        requestId,
        sessionId: input.sessionId,
        mode: "queue",
        content: promptContent(input).map(wirePromptPart),
      },
    });
    return { accepted: true, rpc_id: requestId };
  }

  async respond(input: {
    rpc_id: string;
    value: unknown;
  }): Promise<{ accepted: boolean; reason?: string }> {
    const response = await this.authenticatedRequest("api/respond", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-response",
        rpcId: input.rpc_id,
        result: { ok: true, value: input.value },
      }),
    });
    if (!response.ok) {
      throw httpStatusError(response.status, this.options.access_token);
    }
    return parseRespondReceipt(await response.json());
  }

  muxUrl(): string {
    return this.url("api/remote.mux").replace(/^http/i, "ws");
  }

  /**
   * DSH binds each `/connect` cookie to at most one Mux socket (a second
   * upgrade gets 409) and disposes that cookie when its socket closes, so
   * every socket gets its own cookie; the cached one is HTTP-only.
   */
  async muxConnection(): Promise<DshMuxConnection> {
    if (!this.options.access_token?.trim()) {
      return { url: this.muxUrl(), cookie: "" };
    }
    return this.openConnection();
  }

  invalidateConnection(): void {
    this.connectionPromise = null;
  }

  /** Unary Remote call: `POST /api/<namespace>/<method>` with `{ args }`. */
  private async call(
    endpoint: string,
    args: Record<string, unknown>,
  ): Promise<{ value: unknown; rpc_id: string }> {
    const rpcId = this.createId();
    const response = await this.authenticatedRequest(`api/${endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId,
        method: endpoint,
        payload: { args },
      }),
    });
    if (!response.ok) {
      throw httpStatusError(response.status, this.options.access_token);
    }
    return parseServerResponse(await response.json(), rpcId);
  }

  private async followSnapshot(
    sessionId: string,
    maxMessages?: number,
  ): Promise<{ events: DshHistoryEvent[]; hasMore: boolean; cursor: number }> {
    const request: Record<string, unknown> = { address: sessionAddress(sessionId) };
    if (maxMessages !== undefined) {
      request.maxMessages = maxMessages;
    }
    const value = await this.streamFirst("session/follow", { request });
    if (!isObject(value) || value.type !== "snapshot" || !Number.isInteger(value.cursor)) {
      throw new DshApiError("DSH session/follow did not open with a snapshot");
    }
    const cursor = value.cursor as number;
    this.throughSeqs.set(sessionId, cursor);
    const page = parseHistoryPage(value);
    return { ...page, cursor };
  }

  /** Open one Mux stream, return its first item, then cancel the stream. */
  private async streamFirst(
    endpoint: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      return await this.streamFirstOnce(endpoint, args);
    } catch (error) {
      if (!isUpgradeUnauthorized(error)) {
        throw this.unavailable(error);
      }
      try {
        return await this.streamFirstOnce(endpoint, args);
      } catch (retryError) {
        throw isUpgradeUnauthorized(retryError)
          ? httpStatusError(401, this.options.access_token)
          : this.unavailable(retryError);
      }
    }
  }

  private async streamFirstOnce(
    endpoint: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const connection = await this.muxConnection();
    const streamId = this.createId();
    return new Promise<unknown>((resolve, reject) => {
      let socket: DshMuxSocket | undefined;
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket?.send(dshMuxCancelFrame(streamId));
        socket?.close();
        settle();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new DshApiError(`DSH ${endpoint} stream timed out`, "unavailable")));
      }, this.streamTimeoutMs);
      timer.unref?.();
      this.openSocket({
        url: connection.url,
        cookie: connection.cookie,
        onMessage: (data) => {
          const frame = parseStreamFrame(data, streamId);
          if (!frame) {
            return;
          }
          if (frame.type === "item") {
            finish(() => resolve(frame.value));
          } else if (frame.type === "error") {
            finish(() => reject(new DshApiError(frame.message, frame.code)));
          } else {
            finish(() => reject(new DshApiError(`DSH ${endpoint} stream ended without data`)));
          }
        },
        onClose: () => {
          finish(() => reject(new DshApiError(`DSH ${endpoint} stream closed`, "unavailable")));
        },
      }).then(
        (opened) => {
          socket = opened;
          if (settled) {
            opened.close();
            return;
          }
          opened.send(dshMuxOpenFrame(streamId, endpoint, args));
        },
        (error: unknown) => finish(() => reject(error)),
      );
    });
  }

  private unavailable(error: unknown): DshApiError {
    if (error instanceof DshApiError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    const token = this.options.access_token;
    return new DshApiError(
      `Cannot reach DSH web at ${this.baseUrl} (is \`dsh web\` running?): ${
        token ? message.replaceAll(token, "[redacted]") : message
      }`,
      "unavailable",
    );
  }

  private async authenticatedRequest(
    path: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<DshFetchResponse> {
    let response: DshFetchResponse;
    try {
      if (!this.options.access_token?.trim()) {
        return await this.fetch(this.url(path), init);
      }
      let connection = await this.connection();
      response = await this.fetchWithCookie(path, init, connection);
      if (response.status === 401) {
        this.invalidateConnection();
        connection = await this.connection();
        response = await this.fetchWithCookie(path, init, connection);
      }
    } catch (error) {
      if (error instanceof DshApiError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new DshApiError(
        `Cannot reach DSH web at ${this.baseUrl} (is \`dsh web\` running?): ${
          this.options.access_token
            ? message.replaceAll(this.options.access_token, "[redacted]")
            : message
        }`,
        "unavailable",
      );
    }
    return response;
  }

  private async fetchWithCookie(
    path: string,
    init: { method: string; headers: Record<string, string>; body?: string },
    connection: DshMuxConnection,
  ): Promise<DshFetchResponse> {
    return this.fetch(this.url(path), {
      ...init,
      headers: { ...init.headers, cookie: connection.cookie },
    });
  }

  private connection(): Promise<DshMuxConnection> {
    if (!this.connectionPromise) {
      this.connectionPromise = this.openConnection().catch((error: unknown) => {
        this.connectionPromise = null;
        throw error;
      });
    }
    return this.connectionPromise;
  }

  private async openConnection(): Promise<DshMuxConnection> {
    const token = this.options.access_token?.trim();
    if (!token) {
      throw httpStatusError(401);
    }
    const url = new URL(this.url("connect"));
    url.searchParams.set("token", token);
    url.searchParams.set("interactions", "none");
    const response = await this.fetch(url.href, {
      method: "GET",
      headers: {},
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status !== 302) {
      throw httpStatusError(response.status, token);
    }
    const location = response.headers?.get("location");
    const setCookie = response.headers?.get("set-cookie");
    const cookie = setCookie?.split(";", 1)[0]?.trim();
    if (!location || !cookie || !cookie.includes("=")) {
      throw new DshApiError("DSH connect response is missing its Mux location or authentication cookie");
    }
    const muxUrl = new URL(location, url);
    if (muxUrl.origin !== url.origin) {
      throw new DshApiError("DSH connect response redirected to an unexpected origin");
    }
    return {
      url: muxUrl.href.replace(/^http/i, "ws"),
      cookie,
    };
  }

  private url(path: string): string {
    return new URL(path, `${this.baseUrl}/`).href;
  }
}

function httpStatusError(
  status: number,
  accessToken?: string,
): DshApiError {
  if (status === 401) {
    const message = accessToken
      ? "DSH rejected the configured token (HTTP 401). Verify the saved DSH web token exactly matches the current token printed by the running dsh web server. If it changed, replace it in Engine → DSH → Edit. Do not paste the full browser URL."
      : "DSH authentication failed (HTTP 401): a token is required. Enter the token printed by dsh web in the installation's DSH web token field (not the full browser URL). REGENIC_DSH_TOKEN remains available as an environment fallback.";
    return new DshApiError(
      message,
      "unauthorized",
    );
  }
  if (status === 404) {
    return new DshApiError(
      "DSH does not expose the requested API route (HTTP 404). Update DSH to a compatible version.",
      "not_found",
    );
  }
  return new DshApiError(`DSH HTTP ${status}`, "internal");
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
  // DSH lists never-prompted "New Session" placeholders as blank and hides them.
  if (item.blank === true) {
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
  const records = isObject(value)
    ? Array.isArray(value.records) ? value.records : value.events
    : undefined;
  if (!isObject(value) || !Array.isArray(records)) {
    throw new DshApiError("DSH session history returned an invalid page");
  }
  return {
    hasMore: value.hasMore === true,
    events: records.map((item, index) => {
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

export function parseRespondReceipt(body: unknown): {
  accepted: boolean;
  reason?: string;
} {
  if (!isObject(body)) {
    throw new DshApiError("DSH respond receipt is invalid");
  }
  if (body.accepted === true) {
    return { accepted: true };
  }
  if (body.accepted === false) {
    return {
      accepted: false,
      reason: typeof body.reason === "string" ? body.reason : "not-pending",
    };
  }
  throw new DshApiError("DSH respond receipt is invalid");
}

function promptContent(input: {
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

function wirePromptPart(part: DshPromptPart): Record<string, unknown> {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  return {
    type: "image",
    mediaType: part.mediaType,
    data: part.data,
    ...(part.name ? { name: part.name } : {}),
  };
}

function sessionAddress(sessionId: string): { kind: "session"; sessionId: string } {
  return { kind: "session", sessionId };
}

type DshStreamFrame =
  | { type: "item"; value: unknown }
  | { type: "end" }
  | { type: "error"; code?: string; message: string };

export function parseStreamFrame(data: string, streamId: string): DshStreamFrame | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data) as unknown;
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || parsed.streamId !== streamId) {
    return undefined;
  }
  if (parsed.type === "item") {
    return { type: "item", value: parsed.value };
  }
  if (parsed.type === "end") {
    return { type: "end" };
  }
  if (parsed.type === "error") {
    const error = isObject(parsed.error) ? parsed.error : {};
    return {
      type: "error",
      code: typeof error.code === "string" ? error.code : undefined,
      message: typeof error.message === "string" ? error.message : "DSH stream failed",
    };
  }
  return undefined;
}

function isUpgradeUnauthorized(error: unknown): boolean {
  return error instanceof Error && /\b401\b/.test(error.message) && !(error instanceof DshApiError);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
