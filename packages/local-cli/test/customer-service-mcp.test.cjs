const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
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
