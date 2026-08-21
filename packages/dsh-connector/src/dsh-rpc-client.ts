import { randomUUID } from "node:crypto";
import { DshApiError, type DshHistoryEvent, type DshHistoryPage } from "./dsh-cli-client";

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

  async sessionPrompt(input: { sessionId: string; text: string }): Promise<{
    accepted: true;
    rpc_id: string;
  }> {
    const { rpc_id } = await this.call("session.prompt", {
      sessionId: input.sessionId,
      mode: "queue",
      content: [{ type: "text", text: input.text }],
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
