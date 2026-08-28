const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { CursorApiError, CursorCloudClient } = require("../dist/cursor-api-client");

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

describe("CursorCloudClient", () => {
  it("lists agents with Basic auth and skips archived rows", async () => {
    const calls = [];
    const client = new CursorCloudClient({
      api_key: "key-1",
      base_url: "https://api.cursor.test",
      async fetch(url, init) {
        calls.push({ url, method: init.method, authorization: init.headers.authorization });
        return jsonResponse(200, {
          items: [
            { id: "bc-1", name: "Fix login", status: "IDLE" },
            { id: "bc-2", name: "Old", status: "ARCHIVED" },
          ],
        });
      },
    });

    assert.deepEqual(await client.listAllAgentIds(), ["bc-1"]);
    assert.equal(calls[0].method, "GET");
    assert.equal(
      calls[0].url,
      "https://api.cursor.test/v1/agents?limit=100&includeArchived=false",
    );
    assert.equal(
      calls[0].authorization,
      `Basic ${Buffer.from("key-1:", "utf8").toString("base64")}`,
    );
  });

  it("reads conversation from v1, then falls back to v0", async () => {
    const paths = [];
    const client = new CursorCloudClient({
      api_key: "key-1",
      base_url: "https://api.cursor.test",
      async fetch(url) {
        const path = new URL(url).pathname;
        paths.push(path);
        if (path.endsWith("/v1/agents/bc-1/conversation")) {
          return jsonResponse(404, { message: "not found" });
        }
        return jsonResponse(200, {
          id: "bc-1",
          messages: [{ id: "msg-1", type: "user_message", text: "Add README" }],
        });
      },
    });

    const conversation = await client.getConversation("bc-1");
    assert.deepEqual(paths, [
      "/v1/agents/bc-1/conversation",
      "/v0/agents/bc-1/conversation",
    ]);
    assert.equal(conversation.messages[0].text, "Add README");
  });

  it("creates a follow-up run", async () => {
    const client = new CursorCloudClient({
      api_key: "key-1",
      base_url: "https://api.cursor.test",
      async fetch(url, init) {
        assert.equal(url, "https://api.cursor.test/v1/agents/bc-1/runs");
        assert.equal(init.method, "POST");
        assert.deepEqual(JSON.parse(init.body), { prompt: { text: "Also add tests" } });
        return jsonResponse(200, {
          run: { id: "run-2", agentId: "bc-1", status: "CREATING" },
        });
      },
    });

    const run = await client.createRun("bc-1", "Also add tests");
    assert.equal(run.id, "run-2");
  });

  it("maps 401 to missing credentials", async () => {
    const client = new CursorCloudClient({
      api_key: "bad",
      base_url: "https://api.cursor.test",
      async fetch() {
        return jsonResponse(401, { message: "Invalid API key" });
      },
    });
    await assert.rejects(() => client.me(), (error) => {
      assert.equal(error instanceof CursorApiError, true);
      assert.equal(error.status, 401);
      assert.equal(error.code, "missing_credentials");
      assert.equal(error.message, "Invalid API key");
      return true;
    });
  });
});
