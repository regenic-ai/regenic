import {
  assertObjectKeys,
  optionString,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";
import {
  asObject,
  integerProperty,
  objectProperty,
  requestPersonalApi,
  requiredString,
  runMcpStdio,
  safeMcpBaseUrl,
  stringProperty,
  tool,
  type McpTool,
} from "./mcp-runtime";

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
  const baseUrl = safeMcpBaseUrl(
    optionString(options, "base-url")
      ?? env.REGENIC_API_URL
      ?? "http://127.0.0.1:4370",
    "Customer service MCP",
  );
  const apiKey = env.REGENIC_PERSONAL_API_KEY?.trim();
  await runMcpStdio({
    name: "regenic-customer-service",
    tools: TOOLS,
    stdout,
    callTool: (params) => callTool(baseUrl, apiKey, params),
    errorFallback: "Customer service MCP request failed",
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
  return requestPersonalApi({
    baseUrl,
    apiKey,
    method: route.method,
    path: route.path,
    ...(route.method === "POST" ? { payload } : {}),
  });
}

function requiredTaskId(value: string | undefined): string {
  if (!value) throw new Error("task_id is required");
  return value;
}
