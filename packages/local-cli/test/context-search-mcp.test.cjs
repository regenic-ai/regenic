const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const { createServer } = require("node:http");
const { join } = require("node:path");
const { test } = require("node:test");

test("context search MCP exposes expanded search and continuation tools", async (t) => {
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
    if (request.url.startsWith("/v1/me/context/search/expand")) {
      response.end(JSON.stringify({
        request_id: "request-1",
        snapshot_id: "snapshot-1",
        conversations: [{
          thread_id: "fixture:customer-a",
          read_epoch: "epoch-1",
          anchor_event_ids: ["event-2"],
          messages: [{
            event_id: "event-1",
            external_id: "customer-a:1",
            thread_id: "fixture:customer-a",
            text: "Earlier context",
            selection_reason: "neighbor",
          }, {
            event_id: "event-2",
            external_id: "customer-a:2",
            thread_id: "fixture:customer-a",
            text: "Customer question",
            selection_reason: "hit",
          }],
          continuation: {
            before: { occurred_at: "2026-10-24T00:00:00.000Z", event_id: "event-1" },
            after: null,
            gaps: [],
          },
          truncated: true,
        }],
      }));
      return;
    }
    response.end(JSON.stringify({
      thread_id: "fixture:customer-a",
      read_epoch: "epoch-1",
      messages: [{
        event_id: "event-0",
        external_id: "customer-a:0",
        thread_id: "fixture:customer-a",
        text: "Older context",
        selection_reason: "continued",
      }],
      continuation: null,
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const address = server.address();
  const child = spawn(process.execPath, [
    join(__dirname, "..", "dist", "main.js"),
    "context-search-mcp",
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
  for (const request of [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "search_conversations",
        arguments: {
          query: "customer question",
          kind: "messages",
          limit: 5,
          filters: { sources: ["fixture"] },
          context: { before: 4, after: 4, reply_depth: 8, max_messages: 40 },
          locale: "zh-CN",
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "read_conversation_window",
        arguments: {
          thread_id: "fixture:customer-a",
          read_epoch: "epoch-1",
          direction: "before",
          boundary: {
            occurred_at: "2026-10-24T00:00:00.000Z",
            event_id: "event-1",
          },
          limit: 20,
          locale: "zh-CN",
        },
      },
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "unknown_tool", arguments: {} },
    },
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "search_conversations",
        arguments: { query: "question", locale: "x".repeat(65) },
      },
    },
  ]) {
    child.stdin.write(`${JSON.stringify(request)}\n`);
  }
  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 0);

  const responses = output.trim().split("\n").map(JSON.parse);
  assert.equal(responses[0].result.serverInfo.name, "regenic-context-search");
  assert.deepEqual(
    responses[1].result.tools.map((entry) => entry.name),
    ["search_conversations", "read_conversation_window"],
  );
  assert.deepEqual(
    responses[1].result.tools[0].inputSchema.required,
    ["query"],
  );
  assert.deepEqual(responses[1].result.tools[0].inputSchema.properties.kind.enum, ["all", "messages", "files"]);
  assert.equal(
    responses[2].result.structuredContent.conversations[0].messages[1].external_id,
    "customer-a:2",
  );
  assert.equal(
    responses[3].result.structuredContent.messages[0].event_id,
    "event-0",
  );
  assert.equal(responses[4].result.isError, true);
  assert.match(responses[4].result.content[0].text, /Unknown tool/);
  assert.equal(responses[5].result.isError, true);
  assert.match(responses[5].result.content[0].text, /locale/);

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "/v1/me/context/search/expand?locale=zh-CN");
  assert.equal(requests[0].apiKey, "personal-key");
  assert.deepEqual(requests[0].body, {
    query: "customer question",
    kind: "messages",
    limit: 5,
    filters: { sources: ["fixture"] },
    context: { before: 4, after: 4, reply_depth: 8, max_messages: 40 },
  });
  assert.equal(requests[1].url, "/v1/me/context/search/window?locale=zh-CN");
  assert.equal(requests[1].body.locale, undefined);
  assert.equal(requests[1].body.thread_id, "fixture:customer-a");
  assert.equal(requests[1].body.read_epoch, "epoch-1");
});
