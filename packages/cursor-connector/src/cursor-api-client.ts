export const DEFAULT_CURSOR_API_BASE = "https://api.cursor.com";
export const CURSOR_API_KEY_ENV = "CURSOR_API_KEY";

export type CursorFetch = (
  url: string,
  init: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export class CursorApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "CursorApiError";
  }
}

export interface CursorAgentSummary {
  id: string;
  name?: string;
  status?: string;
  url?: string;
  createdAt?: string;
  updatedAt?: string;
  latestRunId?: string;
}

export interface CursorConversationMessage {
  id: string;
  type: string;
  text?: string;
}

export interface CursorConversation {
  id: string;
  messages: CursorConversationMessage[];
}

export interface CursorRun {
  id: string;
  agentId?: string;
  status?: string;
}

export interface CursorMe {
  apiKeyName?: string;
  userEmail?: string;
}

export interface CursorCloudClientOptions {
  api_key: string;
  base_url?: string;
  fetch?: CursorFetch;
}

export class CursorCloudClient {
  private readonly baseUrl: string;
  private readonly fetch: CursorFetch;

  constructor(private readonly options: CursorCloudClientOptions) {
    const key = options.api_key.trim();
    if (!key) {
      throw new CursorApiError("Cursor API key is empty", 401, "missing_credentials");
    }
    this.baseUrl = trimSlash(options.base_url ?? DEFAULT_CURSOR_API_BASE);
    this.fetch = options.fetch ?? fetch;
  }

  async me(): Promise<CursorMe> {
    const body = await this.request("GET", "/v1/me");
    return asObject(body);
  }

  async listAgents(input: { limit?: number; cursor?: string } = {}): Promise<{
    items: CursorAgentSummary[];
    nextCursor?: string;
  }> {
    const query = new URLSearchParams();
    query.set("limit", String(input.limit ?? 100));
    query.set("includeArchived", "false");
    if (input.cursor) {
      query.set("cursor", input.cursor);
    }
    const body = await this.request("GET", `/v1/agents?${query.toString()}`);
    const object = asObject(body);
    const items = Array.isArray(object.items) ? object.items : [];
    return {
      items: items.flatMap((item) => {
        const agent = parseAgent(item);
        return agent ? [agent] : [];
      }),
      nextCursor: stringField(object, "nextCursor"),
    };
  }

  async listAllAgentIds(maxPages = 5): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const batch = await this.listAgents({ cursor });
      for (const item of batch.items) {
        if (item.status !== "ARCHIVED") {
          ids.push(item.id);
        }
      }
      if (!batch.nextCursor) {
        break;
      }
      cursor = batch.nextCursor;
    }
    return [...new Set(ids)];
  }

  async getAgent(agentId: string): Promise<CursorAgentSummary> {
    const agent = parseAgent(await this.request("GET", `/v1/agents/${encodeURIComponent(agentId)}`));
    if (!agent) {
      throw new CursorApiError(`Cursor agent ${agentId} is invalid`, 502, "sync_failed");
    }
    return agent;
  }

  async getConversation(agentId: string): Promise<CursorConversation> {
    const encoded = encodeURIComponent(agentId);
    try {
      return parseConversation(agentId, await this.request("GET", `/v1/agents/${encoded}/conversation`));
    } catch (error) {
      if (!isMissingRoute(error)) {
        throw error;
      }
      return parseConversation(
        agentId,
        await this.request("GET", `/v0/agents/${encoded}/conversation`),
      );
    }
  }

  async createRun(agentId: string, text: string): Promise<CursorRun> {
    const body = await this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/runs`, {
      prompt: { text },
    });
    const object = asObject(body);
    const run = parseRun(object.run ?? object);
    if (!run) {
      throw new CursorApiError("Cursor follow-up did not return a run", 502, "send_failed");
    }
    return run;
  }

  async createAgent(input: {
    text: string;
    model?: string;
    repository?: string;
    ref?: string;
  }): Promise<CursorAgentSummary> {
    const payload: Record<string, unknown> = {
      prompt: { text: input.text },
    };
    if (input.model?.trim()) {
      payload.model = input.model.trim();
    }
    if (input.repository) {
      payload.repos = [
        {
          url: input.repository,
          ...(input.ref ? { startingRef: input.ref } : {}),
        },
      ];
    }
    const body = await this.request("POST", "/v1/agents", payload);
    const object = asObject(body);
    const agent = parseAgent(object.agent ?? object);
    if (!agent) {
      throw new CursorApiError("Cursor create did not return an agent", 502, "send_failed");
    }
    return agent;
  }

  private async request(
    method: string,
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: basicAuth(this.options.api_key),
        accept: "application/json",
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    if (response.ok) {
      if (response.status === 204) {
        return {};
      }
      return response.json();
    }
    const detail = await readErrorDetail(response);
    throw new CursorApiError(
      detail || `Cursor API ${method} ${path} failed (${response.status})`,
      response.status,
      statusCode(response.status),
    );
  }
}

function basicAuth(apiKey: string): string {
  return `Basic ${Buffer.from(`${apiKey}:`, "utf8").toString("base64")}`;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function statusCode(status: number): string {
  if (status === 401 || status === 403) {
    return "missing_credentials";
  }
  if (status === 409) {
    return "send_failed";
  }
  return "sync_failed";
}

function isMissingRoute(error: unknown): boolean {
  return error instanceof CursorApiError && (error.status === 404 || error.status === 405);
}

function parseAgent(value: unknown): CursorAgentSummary | undefined {
  const object = asObject(value);
  const id = stringField(object, "id");
  if (!id) {
    return undefined;
  }
  return {
    id,
    name: stringField(object, "name"),
    status: stringField(object, "status"),
    url: stringField(object, "url"),
    createdAt: stringField(object, "createdAt"),
    updatedAt: stringField(object, "updatedAt"),
    latestRunId: stringField(object, "latestRunId"),
  };
}

function parseConversation(agentId: string, value: unknown): CursorConversation {
  const object = asObject(value);
  const messages = Array.isArray(object.messages) ? object.messages : [];
  return {
    id: stringField(object, "id") ?? agentId,
    messages: messages.flatMap((item) => {
      const message = asObject(item);
      const id = stringField(message, "id");
      const type = stringField(message, "type");
      if (!id || !type) {
        return [];
      }
      return [
        {
          id,
          type,
          text: stringField(message, "text"),
        },
      ];
    }),
  };
}

function parseRun(value: unknown): CursorRun | undefined {
  const object = asObject(value);
  const id = stringField(object, "id");
  if (!id) {
    return undefined;
  }
  return {
    id,
    agentId: stringField(object, "agentId"),
    status: stringField(object, "status"),
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(object: Record<string, unknown>, name: string): string | undefined {
  const value = object[name];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

async function readErrorDetail(response: {
  json(): Promise<unknown>;
  text(): Promise<string>;
}): Promise<string | undefined> {
  try {
    const body = await response.json();
    const object = asObject(body);
    const message = stringField(object, "message") ?? stringField(object, "error");
    if (message) {
      return message;
    }
    const nested = object.error;
    if (nested && typeof nested === "object") {
      return stringField(nested as Record<string, unknown>, "message");
    }
  } catch {
    try {
      const text = (await response.text()).trim();
      return text || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
