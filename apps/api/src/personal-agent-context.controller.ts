import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { isPersonalApiEnabled } from "@regenic/config";
import { WORK_CONTEXT_AGENT_STATUS_METHOD, type CopyLocale } from "@regenic/domain";
import {
  PersonalAgentContextAccessService,
  type AgentContextCredential,
  type AgentContextScope,
} from "./personal-agent-context-access.service";
import { PersonalContextService } from "./personal-context.service";
import { PersonalConversationLabelsService } from "./personal-conversation-labels.service";
import { requestLocale } from "./request-locale";

type JsonRpcId = string | number | null;

const SERVER_NAME = "regenic-context";

const boundary = {
  type: "object",
  additionalProperties: false,
  properties: {
    occurred_at: { type: "string", minLength: 1 },
    event_id: { type: "string", minLength: 1 },
  },
  required: ["occurred_at", "event_id"],
};
const str = { type: "string", minLength: 1 };
const int = (minimum: number, maximum: number) => ({ type: "integer", minimum, maximum });

const TOOLS = [
  {
    name: "read_task_conversation",
    description:
      "Read the chat this task came from: messages around the current one, plus what it replies to. Start here. Page further with read_conversation_window using the returned continuation boundary and read_epoch.",
    properties: {
      before: int(0, 50),
      after: int(0, 50),
      event_id: str,
      locale: str,
    },
    required: [] as string[],
  },
  {
    name: "read_conversation_window",
    description:
      "Continue a conversation from a returned before, after or gap boundary using the same read_epoch.",
    properties: {
      thread_id: str,
      read_epoch: str,
      direction: { type: "string", enum: ["before", "after"] },
      boundary,
      until: boundary,
      limit: int(1, 50),
      locale: str,
    },
    required: ["thread_id", "read_epoch", "direction", "boundary"],
  },
  {
    name: "search_conversations",
    description:
      "Search all authorized chats and files. Use only when the task needs other chats. Hits may concern someone else; check before relying on them.",
    properties: {
      query: str,
      kind: { type: "string", enum: ["all", "messages", "files"] },
      limit: int(1, 20),
      filters: {
        type: "object",
        additionalProperties: false,
        properties: {
          sources: { type: "array", items: str },
          thread_ids: { type: "array", items: str },
        },
      },
      context: {
        type: "object",
        additionalProperties: false,
        properties: {
          before: int(0, 12),
          after: int(0, 12),
          reply_depth: int(0, 8),
          max_messages: int(1, 100),
        },
      },
      locale: str,
    },
    required: ["query"],
  },
];

/**
 * Streamable HTTP MCP endpoint for agents working a Regenic run. Plain JSON
 * responses only; no sessions or server-sent events. Loopback agents only:
 * browsers are refused by rejecting any Origin header.
 */
@Controller("v1/agent/context")
export class PersonalAgentContextController {
  constructor(
    @Inject(PersonalAgentContextAccessService)
    private readonly access: PersonalAgentContextAccessService,
    @Inject(PersonalContextService)
    private readonly context: PersonalContextService,
    @Inject(PersonalConversationLabelsService)
    private readonly labels: PersonalConversationLabelsService,
  ) {}

  @Get("mcp")
  stream(@Res() response: Response) {
    response.status(HttpStatus.METHOD_NOT_ALLOWED).setHeader("allow", "POST").end();
  }

  @Post("mcp")
  async rpc(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body() body: unknown,
  ) {
    const credential = this.authenticate(request);
    const message = asObject(body);
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(null, -32600, "Invalid JSON-RPC request");
    }
    const id = message.id as JsonRpcId | undefined;
    if (id === undefined) {
      response.status(HttpStatus.ACCEPTED);
      return undefined;
    }
    response.status(HttpStatus.OK);
    const params = asObject(message.params) ?? {};
    switch (message.method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: typeof params.protocolVersion === "string" && params.protocolVersion
            ? params.protocolVersion
            : "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: "1.0.0" },
        });
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        if (credential.kind === "agent") this.access.markAgentConnected();
        return rpcResult(id, { tools: toolList(credential) });
      case WORK_CONTEXT_AGENT_STATUS_METHOD:
        return rpcResult(id, {
          agent_connected_at: credential.kind === "agent"
            ? this.access.agentConnectedSince() ?? null
            : null,
        });
      case "tools/call":
        try {
          const result = await this.call(credential, params);
          return rpcResult(id, {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          });
        } catch (error) {
          return rpcResult(id, {
            content: [{ type: "text", text: errorText(error) }],
            isError: true,
          });
        }
      default:
        return rpcError(id, -32601, "Method not found");
    }
  }

  private authenticate(request: Request): AgentContextCredential {
    if (!isPersonalApiEnabled()) {
      throw new HttpException(
        { error: { code: "not_found", message: "Not Found" } },
        HttpStatus.NOT_FOUND,
      );
    }
    if (request.get("origin")) {
      throw new HttpException(
        { error: { code: "forbidden_origin", message: "Origin is not allowed" } },
        HttpStatus.FORBIDDEN,
      );
    }
    const header = request.get("authorization")?.trim() ?? "";
    const token = /^bearer\s+/i.test(header)
      ? header.replace(/^bearer\s+/i, "")
      : request.get("x-regenic-context-token");
    const credential = this.access.verify(token);
    if (!credential) {
      throw new HttpException(
        { error: { code: "unauthorized", message: "A valid Regenic context token is required" } },
        HttpStatus.UNAUTHORIZED,
      );
    }
    return credential;
  }

  private async call(
    credential: AgentContextCredential,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const name = typeof params.name === "string" ? params.name : "";
    const args = { ...(asObject(params.arguments) ?? {}) };
    const runId = credential.kind === "run"
      ? credential.run_id
      : typeof args.run_id === "string" ? args.run_id.trim() : "";
    delete args.run_id;
    if (!runId) {
      throw new Error("run_id is required; use the run_id from AGENTS.md");
    }
    const scope = await this.access.scope(runId);
    if (!scope) {
      throw new Error("This run is finished or unknown; context is no longer available");
    }
    const locale = requestLocale(typeof args.locale === "string" ? args.locale : undefined);
    delete args.locale;
    const at = new Date().toISOString();
    if (name === "read_task_conversation") {
      const result = await this.readTask(scope, args, locale);
      await this.access.recordRead(runId, {
        at,
        tool: name,
        thread_id: scope.item.thread_id,
        ...(result.title ? { title: result.title } : {}),
        messages: result.messages.length,
      });
      return result;
    }
    if (name === "read_conversation_window") {
      const window = await this.context.searchWindow(args);
      const result = await this.decorateWindow(window, locale);
      await this.access.recordRead(runId, {
        at,
        tool: name,
        thread_id: window.thread_id,
        ...("title" in result && result.title ? { title: result.title } : {}),
        messages: window.messages.length,
      });
      return result;
    }
    if (name === "search_conversations") {
      const result = await this.search(args, locale);
      await this.access.recordRead(runId, {
        at,
        tool: name,
        query: typeof args.query === "string" ? args.query.slice(0, 200) : undefined,
        messages: result.conversations.reduce(
          (sum: number, conversation: { messages: unknown[] }) => sum + conversation.messages.length,
          0,
        ),
      });
      return result;
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  private async readTask(
    scope: AgentContextScope,
    args: Record<string, unknown>,
    locale: CopyLocale,
  ) {
    const result = await this.context.readTaskConversation({
      thread_id: scope.item.thread_id,
      event_id: typeof args.event_id === "string" ? args.event_id : scope.item.head_event_id,
      before: args.before as number | undefined,
      after: args.after as number | undefined,
    });
    if (!result.messages.length) return { ...result, title: null, channel_label: null };
    const labels = await this.labels.describe([result], locale);
    const thread = labels.threads.get(result.thread_id);
    return {
      ...result,
      title: thread?.title ?? null,
      channel_label: thread?.channel_label ?? null,
      messages: result.messages.map((message) => ({
        ...message,
        actor_label: labels.actors.get(message.event_id) ?? null,
      })),
    };
  }

  private async decorateWindow(
    window: Awaited<ReturnType<PersonalContextService["searchWindow"]>>,
    locale: CopyLocale,
  ) {
    if (!window.messages.length) return window;
    const labels = await this.labels.describe([window], locale);
    return {
      ...window,
      title: labels.threads.get(window.thread_id)?.title ?? null,
      messages: window.messages.map((message) => ({
        ...message,
        actor_label: labels.actors.get(message.event_id) ?? null,
      })),
    };
  }

  private async search(args: Record<string, unknown>, locale: CopyLocale) {
    const result = await this.context.searchExpanded(args);
    if (!result.conversations.length) return result;
    const labels = await this.labels.describe(result.conversations, locale);
    return {
      ...result,
      conversations: result.conversations.map((conversation) => ({
        ...conversation,
        title: labels.threads.get(conversation.thread_id)?.title ?? null,
        channel_label: labels.threads.get(conversation.thread_id)?.channel_label ?? null,
        messages: conversation.messages.map((message) => ({
          ...message,
          actor_label: labels.actors.get(message.event_id) ?? null,
        })),
      })),
    };
  }
}

function toolList(credential: AgentContextCredential) {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: credential.kind === "agent"
        ? { run_id: str, ...tool.properties }
        : tool.properties,
      required: credential.kind === "agent"
        ? ["run_id", ...tool.required]
        : tool.required,
    },
  }));
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function errorText(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const message = asObject(asObject(response)?.error)?.message;
    if (typeof message === "string") return message;
  }
  return error instanceof Error ? error.message : "Context request failed";
}
