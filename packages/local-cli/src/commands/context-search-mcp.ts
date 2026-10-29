import {
  assertObjectKeys,
  optionString,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";
import {
  arrayProperty,
  asObject,
  integerProperty,
  requestPersonalApi,
  requiredString,
  runMcpStdio,
  safeMcpBaseUrl,
  stringProperty,
  tool,
} from "./mcp-runtime";

const boundaryProperty = {
  type: "object",
  additionalProperties: false,
  properties: {
    occurred_at: stringProperty(),
    event_id: stringProperty(),
  },
  required: ["occurred_at", "event_id"],
};

const TOOLS = [
  tool(
    "search_conversations",
    "Search authorized context and return bounded conversation windows with stable message IDs, reply links, completeness flags and continuation boundaries.",
    {
      query: stringProperty(),
      limit: integerProperty(1, 20),
      filters: {
        type: "object",
        additionalProperties: false,
        properties: {
          sources: arrayProperty(stringProperty()),
          thread_ids: arrayProperty(stringProperty()),
        },
      },
      context: {
        type: "object",
        additionalProperties: false,
        properties: {
          before: integerProperty(0, 12),
          after: integerProperty(0, 12),
          reply_depth: integerProperty(0, 8),
          max_messages: integerProperty(1, 100),
        },
      },
      locale: stringProperty(),
    },
    ["query"],
  ),
  tool(
    "read_conversation_window",
    "Continue a search_conversations result from a returned before, after or gap boundary using the same conversation read_epoch.",
    {
      thread_id: stringProperty(),
      read_epoch: stringProperty(),
      direction: { type: "string", enum: ["before", "after"] },
      boundary: boundaryProperty,
      until: boundaryProperty,
      limit: integerProperty(1, 50),
      locale: stringProperty(),
    },
    ["thread_id", "read_epoch", "direction", "boundary"],
  ),
];

export async function runContextSearchMcp(
  options: CommandOptions,
  env: NodeJS.ProcessEnv,
  stdout: CliOutput,
): Promise<void> {
  assertObjectKeys(options, new Set(["base-url"]), "context-search-mcp option");
  const baseUrl = safeMcpBaseUrl(
    optionString(options, "base-url")
      ?? env.REGENIC_API_URL
      ?? "http://127.0.0.1:4370",
    "Context search MCP",
  );
  const apiKey = env.REGENIC_PERSONAL_API_KEY?.trim();
  await runMcpStdio({
    name: "regenic-context-search",
    tools: TOOLS,
    stdout,
    callTool: (params) => callTool(baseUrl, apiKey, params),
    errorFallback: "Context search MCP request failed",
  });
}

async function callTool(
  baseUrl: URL,
  apiKey: string | undefined,
  params: unknown,
): Promise<unknown> {
  const object = asObject(params, "tools/call params");
  const name = requiredString(object.name, "tool name");
  const args = asObject(object.arguments ?? {}, "tool arguments");
  const locale = typeof args.locale === "string" && args.locale.trim()
    ? args.locale.trim()
    : "en";
  if (locale.length > 64) {
    throw new Error("locale must not exceed 64 characters");
  }
  const payload = Object.fromEntries(
    Object.entries(args).filter(([key]) => key !== "locale"),
  );
  if (name === "search_conversations") {
    return requestPersonalApi({
      baseUrl,
      apiKey,
      method: "POST",
      path: `/v1/me/context/search/expand?locale=${encodeURIComponent(locale)}`,
      payload,
    });
  }
  if (name === "read_conversation_window") {
    return requestPersonalApi({
      baseUrl,
      apiKey,
      method: "POST",
      path: `/v1/me/context/search/window?locale=${encodeURIComponent(locale)}`,
      payload,
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}
