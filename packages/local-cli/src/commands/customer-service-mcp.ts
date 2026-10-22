import { createInterface } from "node:readline";
import {
  assertObjectKeys,
  optionString,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: McpTool[] = [
  tool("create_customer_task", "Bind a customer question to its current authorized source message.", {
    source_event_id: stringProperty(),
    content_hash: stringProperty(),
    question: stringProperty(),
    query_at: stringProperty(),
  }, ["source_event_id", "content_hash"]),
  tool("search_context", "Search and expand authorized conversation evidence for one customer task.", {
    task_id: stringProperty(),
    query: stringProperty(),
    objective: stringProperty(),
    max_items: integerProperty(1, 100),
    neighbor_count: integerProperty(0, 12),
    include_related: { type: "boolean" },
  }, ["task_id", "query"]),
  tool("read_context", "Continue an authorized conversation read using an opaque task-bound handle.", {
    task_id: stringProperty(),
    continuation_handle: stringProperty(),
    max_items: integerProperty(1, 40),
  }, ["task_id", "continuation_handle"]),
  tool("update_customer_brief", "Submit evidence-bound customer, project, batch, intent and member resolution.", {
    task_id: stringProperty(),
    customer: objectProperty(),
    project: objectProperty(),
    batch: objectProperty(),
    intent: objectProperty(),
    expected_member_count: integerProperty(0, 1_000),
    expected_count_evidence: stringProperty(),
    members_closed: { type: "boolean" },
    members: { type: "array", items: objectProperty() },
    requested_fields: { type: "array", items: stringProperty() },
    unresolved: { type: "array", items: stringProperty() },
    query_at: stringProperty(),
  }, [
    "task_id",
    "customer",
    "project",
    "batch",
    "intent",
    "members_closed",
    "members",
    "requested_fields",
  ]),
  tool("query_customer_business", "Run the configured scoped read-only business query for a verified brief.", {
    task_id: stringProperty(),
    page: stringProperty(),
  }, ["task_id"]),
  tool("create_customer_reply_draft", "Create a claim-to-evidence mapped customer reply draft for human review.", {
    task_id: stringProperty(),
    text: stringProperty(),
    claims: { type: "array", items: objectProperty() },
    covered_member_keys: { type: "array", items: stringProperty() },
    unresolved: { type: "array", items: stringProperty() },
  }, ["task_id", "text", "claims", "covered_member_keys"]),
  tool("get_customer_task", "Read the current version and state of one customer service task.", {
    task_id: stringProperty(),
  }, ["task_id"]),
];

export async function runCustomerServiceMcp(
  options: CommandOptions,
  env: NodeJS.ProcessEnv,
  stdout: CliOutput,
): Promise<void> {
  assertObjectKeys(options, new Set(["base-url"]), "customer-service-mcp option");
  const baseUrl = safeBaseUrl(
    optionString(options, "base-url")
      ?? env.REGENIC_API_URL
      ?? "http://127.0.0.1:4370",
  );
  const apiKey = env.REGENIC_PERSONAL_API_KEY?.trim();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: JsonRpcRequest;
    try {
      request = parseRequest(JSON.parse(line));
    } catch (error) {
      writeResponse(stdout, null, undefined, rpcError(-32700, message(error)));
      continue;
    }
    if (request.id === undefined) continue;
    try {
      if (request.method === "initialize") {
        writeResponse(stdout, request.id, {
          protocolVersion: protocolVersion(request.params),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "regenic-customer-service", version: "1.0.0" },
        });
        continue;
      }
      if (request.method === "ping") {
        writeResponse(stdout, request.id, {});
        continue;
      }
      if (request.method === "tools/list") {
        writeResponse(stdout, request.id, { tools: TOOLS });
        continue;
      }
      if (request.method === "tools/call") {
        const result = await callTool(baseUrl, apiKey, request.params);
        writeResponse(stdout, request.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        });
        continue;
      }
      writeResponse(stdout, request.id, undefined, rpcError(-32601, "Method not found"));
    } catch (error) {
      writeResponse(stdout, request.id, {
        content: [{ type: "text", text: message(error) }],
        isError: true,
      });
    }
  }
}

async function callTool(
  baseUrl: URL,
  apiKey: string | undefined,
  params: unknown,
): Promise<unknown> {
  const object = asObject(params, "tools/call params");
  const name = requiredString(object.name, "tool name");
  const args = asObject(object.arguments ?? {}, "tool arguments");
  const taskId = typeof args.task_id === "string" ? encodeURIComponent(args.task_id) : undefined;
  const routes: Record<string, { method: "GET" | "POST"; path: string; omit: string[] }> = {
    create_customer_task: {
      method: "POST",
      path: "/v1/me/context/customer-tasks",
      omit: [],
    },
    search_context: {
      method: "POST",
      path: `/v1/me/context/customer-tasks/${requiredTaskId(taskId)}/search`,
      omit: ["task_id"],
    },
    read_context: {
      method: "POST",
      path: `/v1/me/context/customer-tasks/${requiredTaskId(taskId)}/read`,
      omit: ["task_id"],
    },
    update_customer_brief: {
      method: "POST",
      path: `/v1/me/context/customer-tasks/${requiredTaskId(taskId)}/brief`,
      omit: ["task_id"],
    },
    query_customer_business: {
      method: "POST",
      path: `/v1/me/context/customer-tasks/${requiredTaskId(taskId)}/query`,
      omit: ["task_id"],
    },
    create_customer_reply_draft: {
      method: "POST",
      path: `/v1/me/context/customer-tasks/${requiredTaskId(taskId)}/draft`,
      omit: ["task_id"],
    },
    get_customer_task: {
      method: "GET",
      path: `/v1/me/context/customer-tasks/${requiredTaskId(taskId)}`,
      omit: ["task_id"],
    },
  };
  const route = routes[name];
  if (!route || !TOOLS.some((candidate) => candidate.name === name)) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const payload = Object.fromEntries(
    Object.entries(args).filter(([key]) => !route.omit.includes(key)),
  );
  const response = await fetch(new URL(route.path, baseUrl), {
    method: route.method,
    headers: {
      accept: "application/json",
      ...(route.method === "POST" ? { "content-type": "application/json" } : {}),
      ...(apiKey ? { "x-regenic-personal-key": apiKey } : {}),
    },
    ...(route.method === "POST" ? { body: JSON.stringify(payload) } : {}),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Regenic API returned invalid JSON (${response.status})`);
  }
  if (!response.ok) {
    const error = asOptionalObject(asOptionalObject(body)?.error);
    throw new Error(typeof error?.message === "string"
      ? error.message
      : `Regenic API request failed (${response.status})`);
  }
  return body;
}

function parseRequest(value: unknown): JsonRpcRequest {
  const object = asObject(value, "JSON-RPC request");
  if (object.jsonrpc !== "2.0" || typeof object.method !== "string") {
    throw new Error("Invalid JSON-RPC request");
  }
  if (object.id !== undefined
    && object.id !== null
    && typeof object.id !== "string"
    && typeof object.id !== "number") {
    throw new Error("Invalid JSON-RPC id");
  }
  return {
    jsonrpc: "2.0",
    method: object.method,
    ...(object.id === undefined ? {} : { id: object.id as JsonRpcId }),
    ...(object.params === undefined ? {} : { params: object.params }),
  };
}

function writeResponse(
  stdout: CliOutput,
  id: JsonRpcId,
  result?: unknown,
  error?: { code: number; message: string },
): void {
  stdout.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id,
    ...(error ? { error } : { result }),
  })}\n`);
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
): McpTool {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties,
      required,
    },
  };
}

function stringProperty() {
  return { type: "string", minLength: 1 };
}

function integerProperty(minimum: number, maximum: number) {
  return { type: "integer", minimum, maximum };
}

function objectProperty() {
  return { type: "object" };
}

function safeBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Customer service MCP base URL must be absolute");
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Customer service MCP base URL must use HTTPS or loopback HTTP");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Customer service MCP base URL must not contain credentials, query or fragment");
  }
  return url;
}

function protocolVersion(params: unknown): string {
  const version = asOptionalObject(params)?.protocolVersion;
  return typeof version === "string" && version ? version : "2025-03-26";
}

function requiredTaskId(value: string | undefined): string {
  if (!value) throw new Error("task_id is required");
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function asObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asOptionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rpcError(code: number, value: string) {
  return { code, message: value };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Customer service MCP request failed";
}
