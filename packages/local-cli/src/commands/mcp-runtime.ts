import { createInterface } from "node:readline";
import type { CliOutput } from "../cli-runtime";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export async function runMcpStdio(input: {
  name: string;
  tools: McpTool[];
  stdout: CliOutput;
  callTool: (params: unknown) => Promise<unknown>;
  errorFallback: string;
}): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: JsonRpcRequest;
    try {
      request = parseRequest(JSON.parse(line));
    } catch (error) {
      writeResponse(input.stdout, null, undefined, rpcError(-32700, errorMessage(error, input.errorFallback)));
      continue;
    }
    if (request.id === undefined) continue;
    try {
      if (request.method === "initialize") {
        writeResponse(input.stdout, request.id, {
          protocolVersion: protocolVersion(request.params),
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: input.name, version: "1.0.0" },
        });
        continue;
      }
      if (request.method === "ping") {
        writeResponse(input.stdout, request.id, {});
        continue;
      }
      if (request.method === "tools/list") {
        writeResponse(input.stdout, request.id, { tools: input.tools });
        continue;
      }
      if (request.method === "tools/call") {
        const result = await input.callTool(request.params);
        writeResponse(input.stdout, request.id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        });
        continue;
      }
      writeResponse(input.stdout, request.id, undefined, rpcError(-32601, "Method not found"));
    } catch (error) {
      writeResponse(input.stdout, request.id, {
        content: [{ type: "text", text: errorMessage(error, input.errorFallback) }],
        isError: true,
      });
    }
  }
}

export function tool(
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

export function stringProperty() {
  return { type: "string", minLength: 1 };
}

export function integerProperty(minimum: number, maximum: number) {
  return { type: "integer", minimum, maximum };
}

export function objectProperty() {
  return { type: "object" };
}

export function arrayProperty(items: Record<string, unknown>) {
  return { type: "array", items };
}

export function safeMcpBaseUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} base URL must be absolute`);
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${label} base URL must use HTTPS or loopback HTTP`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} base URL must not contain credentials, query or fragment`);
  }
  return url;
}

export async function requestPersonalApi(input: {
  baseUrl: URL;
  apiKey?: string;
  method: "GET" | "POST";
  path: string;
  payload?: unknown;
}): Promise<unknown> {
  const response = await fetch(new URL(input.path, input.baseUrl), {
    method: input.method,
    signal: AbortSignal.timeout(120_000),
    headers: {
      accept: "application/json",
      ...(input.method === "POST" ? { "content-type": "application/json" } : {}),
      ...(input.apiKey ? { "x-regenic-personal-key": input.apiKey } : {}),
    },
    ...(input.method === "POST" ? { body: JSON.stringify(input.payload ?? {}) } : {}),
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

export function asObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
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
    ...(object.id === undefined ? {} : { id: object.id }),
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

function protocolVersion(params: unknown): string {
  const version = asOptionalObject(params)?.protocolVersion;
  return typeof version === "string" && version ? version : "2025-03-26";
}

function asOptionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rpcError(code: number, value: string) {
  return { code, message: value };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
