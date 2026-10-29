const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { join } = require("node:path");
const { test } = require("node:test");

test("customer service MCP exposes agent tools but not review or send", async () => {
  const child = spawn(process.execPath, [
    join(__dirname, "..", "dist", "main.js"),
    "customer-service-mcp",
  ], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26" },
  })}\n`);
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  })}\n`);
  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  const responses = output.trim().split("\n").map(JSON.parse);
  assert.equal(responses[0].result.serverInfo.name, "regenic-customer-service");
  const names = responses[1].result.tools.map((tool) => tool.name);
  assert.ok(names.includes("search_context"));
  assert.ok(names.includes("query_customer_business"));
  assert.ok(names.includes("create_customer_reply_draft"));
  assert.ok(!names.some((name) => /review|send/.test(name)));
});

test("customer service MCP creates a task without requiring task_id", async (t) => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      url: request.url,
      apiKey: request.headers["x-regenic-personal-key"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "task-1", status: "resolving_context" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const child = spawn(process.execPath, [
    join(__dirname, "..", "dist", "main.js"),
    "customer-service-mcp",
    "--base-url",
    `http://127.0.0.1:${address.port}`,
  ], {
    env: { ...process.env, REGENIC_PERSONAL_API_KEY: "personal-key" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "create_customer_task",
      arguments: {
        source_event_id: "event-1",
        content_hash: "a".repeat(64),
      },
    },
  })}\n`);
  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 0);

  const response = JSON.parse(output.trim());
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.structuredContent.id, "task-1");
  assert.deepEqual(requests, [{
    url: "/v1/me/context/customer-tasks",
    apiKey: "personal-key",
    body: {
      source_event_id: "event-1",
      content_hash: "a".repeat(64),
    },
  }]);
});
