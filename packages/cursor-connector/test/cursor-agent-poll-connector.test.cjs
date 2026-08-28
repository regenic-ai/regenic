const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ConnectorRunner,
  IngestionService,
  MemoryAuthorityStore,
  MemoryBlobStore,
  MemoryConnectorRuntimeStore,
  SURFACE_MEDIA_TYPE,
  verifyPollConnectorConformance,
} = require("@regenic/domain");
const {
  CursorAgentPollConnector,
  classifyCursorMessage,
} = require("../dist/cursor-agent-poll-connector");

function agent(overrides = {}) {
  return {
    id: "bc-1",
    name: "Add README",
    status: "IDLE",
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: "2026-08-21T00:05:00.000Z",
    latestRunId: "run-1",
    ...overrides,
  };
}

function messages() {
  return [
    { id: "msg-1", type: "user_message", text: "Add a README" },
    { id: "msg-2", type: "assistant_message", text: "Added README.md" },
  ];
}

function createConnector(client) {
  return new CursorAgentPollConnector(client, {
    connector_id: "cursor-agent",
    org_id: "local-owner",
    agent_id: "bc-1",
    agent_name: "Add README",
    now: () => "2026-08-21T00:06:00.000Z",
  });
}

function surface(record) {
  const part = record.content.find(
    (item) => item.role === "metadata" && item.media_type === SURFACE_MEDIA_TYPE,
  );
  return JSON.parse(part.text);
}

describe("CursorAgentPollConnector", () => {
  it("maps Cloud Agent conversation turns like a session journal", async () => {
    const connector = createConnector({
      async getAgent() {
        return agent();
      },
      async getConversation() {
        return { id: "bc-1", messages: messages() };
      },
    });

    const result = await connector.poll(null);
    assert.equal(result.next_cursor, "msg-2");
    assert.equal(result.batch.records[0].external_id, "bc-1:msg-1");
    assert.equal(result.batch.records[0].actor.id, "user");
    assert.deepEqual(result.batch.records[0].direction_tags, ["outbound"]);
    assert.equal(surface(result.batch.records[0]).kind, "user");
    assert.equal(result.batch.records[1].external_id, "bc-1:msg-2");
    assert.equal(surface(result.batch.records[1]).kind, "assistant");
    assert.equal(surface(result.batch.records[1]).actor_label, "Cursor");
    assert.equal(result.batch.records[2].type, "thread_status");
    assert.equal(surface(result.batch.records[2]).turn.state, "ended");
  });

  it("resumes after the last message id and marks an active run as working", async () => {
    const connector = createConnector({
      async getAgent() {
        return agent({ status: "ACTIVE", latestRunId: "run-2" });
      },
      async getConversation() {
        return {
          id: "bc-1",
          messages: [
            ...messages(),
            { id: "msg-3", type: "user_message", text: "Also add tests" },
          ],
        };
      },
    });

    const result = await connector.poll({ value: "msg-2" });
    assert.equal(result.batch.records[0].external_id, "bc-1:msg-3");
    const working = result.batch.records.find((record) => record.type === "thread_status");
    assert.equal(working?.external_id, "bc-1:working.run-2");
    assert.equal(surface(working).activity, "working");
    assert.equal(
      result.batch.records.find((record) => record.operation === "revise")?.external_id,
      "bc-1:msg-2",
    );
    assert.equal(result.next_cursor, "msg-3");
  });

  it("emits ended for an idle agent before scheduling a pending flush", async () => {
    const flushes = [];
    const connector = createConnector({
      async getAgent() {
        return agent({ status: "IDLE", latestRunId: "run-1" });
      },
      async getConversation() {
        return { id: "bc-1", messages: messages() };
      },
      async flushPending(agentId) {
        flushes.push(agentId);
      },
    });
    const result = await connector.poll(null);
    const status = result.batch.records.find((record) => record.type === "thread_status");
    assert.equal(surface(status).turn.state, "ended");
    assert.deepEqual(flushes, []);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(flushes, ["bc-1"]);
  });

  it("does not flush while the observed agent is still active", async () => {
    const flushes = [];
    const connector = createConnector({
      async getAgent() {
        return agent({ status: "ACTIVE", latestRunId: "run-2" });
      },
      async getConversation() {
        return { id: "bc-1", messages: messages() };
      },
      async flushPending(agentId) {
        flushes.push(agentId);
      },
    });
    await connector.poll(null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(flushes, []);
  });

  it("is stable for the shared poll conformance check", async () => {
    const connector = createConnector({
      async getAgent() {
        return agent();
      },
      async getConversation() {
        return { id: "bc-1", messages: messages() };
      },
    });
    const report = await verifyPollConnectorConformance({
      connector,
      cursor: null,
      connector_id: "cursor-agent",
      source: "cursor",
    });
    assert.equal(report.record_count, 3);
    assert.equal(report.next_cursor, "msg-2");
  });

  it("settles a page through the shared connector runtime", async () => {
    const connector = createConnector({
      async getAgent() {
        return agent();
      },
      async getConversation() {
        return { id: "bc-1", messages: messages() };
      },
    });
    const runtime = new MemoryConnectorRuntimeStore();
    await runtime.createInstallation({
      id: "cursor-installation",
      org_id: "local-owner",
      connector_type: "cursor-agent",
      status: "enabled",
      config: { agent_id: "bc-1" },
      created_at: "2026-08-21T00:00:00.000Z",
    });
    const runner = new ConnectorRunner(
      connector,
      new IngestionService(new MemoryBlobStore(), new MemoryAuthorityStore()),
      runtime,
      () => "2026-08-21T00:06:00.000Z",
    );
    const run = await runner.poll({
      installation_id: "cursor-installation",
      stream_key: "agent:bc-1",
      lease_owner: "worker-a",
      lease_duration_ms: 30_000,
    });
    assert.equal(run.status, "completed");
    assert.equal(run.result.records[0].status, "accepted");
  });

  it("drops empty and unknown conversation nodes", () => {
    assert.equal(
      classifyCursorMessage({ id: "x", type: "user_message", text: "  " }),
      undefined,
    );
    assert.equal(
      classifyCursorMessage({ id: "x", type: "tool_call", text: "read" }),
      undefined,
    );
  });

  it("keeps markdown line breaks so Inbox can render headings and tables", () => {
    const markdown = [
      "## 先看结论",
      "",
      "| 法律 | 何时生效 |",
      "| ---- | ---- |",
      "| 《国防动员法》修订 | 2026年10月1日 |",
      "",
      "- 职工医保参保仍是法定义务",
    ].join("\n");
    const mapped = classifyCursorMessage({
      id: "a1",
      type: "assistant_message",
      text: `${markdown}\n\n\n`,
    });
    assert.equal(mapped?.text, markdown);
  });

  it("revises the last assistant on a later poll so flattened markdown can heal", async () => {
    const markdown = "## 先看结论\n\n| 法律 | 何时生效 |\n| ---- | ---- |\n| 国防动员法 | 2026年10月1日 |";
    const connector = createConnector({
      async getAgent() {
        return agent();
      },
      async getConversation() {
        return {
          id: "bc-1",
          messages: [
            { id: "msg-1", type: "user_message", text: "分析一下" },
            { id: "msg-2", type: "assistant_message", text: markdown },
          ],
        };
      },
    });
    const result = await connector.poll({ value: "msg-2" });
    const revised = result.batch.records.find((record) => record.operation === "revise");
    assert.equal(revised?.external_id, "bc-1:msg-2");
    const body = revised?.content.find((part) => part.role === "body")?.text;
    assert.equal(body, markdown);
  });

  it("stamps turns at poll time in conversation order, not agent createdAt", async () => {
    const connector = createConnector({
      async getAgent() {
        return agent();
      },
      async getConversation() {
        return { id: "bc-1", messages: messages() };
      },
    });
    const result = await connector.poll(null);
    assert.equal(result.batch.records[0].occurred_at, "2026-08-21T00:06:00.000Z");
    assert.equal(result.batch.records[1].occurred_at, "2026-08-21T00:06:00.001Z");
  });

  it("stamps a later page at poll time using the full conversation index", async () => {
    const connector = createConnector({
      async getAgent() {
        return agent();
      },
      async getConversation() {
        return {
          id: "bc-1",
          messages: [
            ...messages(),
            { id: "msg-3", type: "user_message", text: "Also add tests" },
            { id: "msg-4", type: "assistant_message", text: "Added tests" },
          ],
        };
      },
    });
    const result = await connector.poll({ value: "msg-2" });
    assert.equal(result.batch.records[0].external_id, "bc-1:msg-3");
    assert.equal(result.batch.records[0].occurred_at, "2026-08-21T00:06:00.002Z");
    assert.equal(result.batch.records[1].external_id, "bc-1:msg-4");
    assert.equal(result.batch.records[1].occurred_at, "2026-08-21T00:06:00.003Z");
  });

  it("keeps one assistant in a progress streak and tombstones the earlier bubbles", async () => {
    const connector = createConnector({
      async getAgent() {
        return agent();
      },
      async getConversation() {
        return {
          id: "bc-1",
          messages: [
            { id: "msg-1", type: "user_message", text: "Where is the code?" },
            {
              id: "msg-2",
              type: "assistant_message",
              text: "I will look at the roadmap first.",
            },
            {
              id: "msg-3",
              type: "assistant_message",
              text: "The code is in the workspace.",
            },
          ],
        };
      },
    });
    const result = await connector.poll(null);
    const types = result.batch.records.map((record) => [
      record.operation,
      record.external_id,
    ]);
    assert.deepEqual(types, [
      ["create", "bc-1:msg-1"],
      ["create", "bc-1:msg-3"],
      ["tombstone", "bc-1:msg-2"],
      ["create", "bc-1:ended.run-1"],
    ]);
    assert.equal(result.next_cursor, "msg-3");
    assert.equal(result.batch.records[1].occurred_at, "2026-08-21T00:06:00.001Z");
    const replay = await connector.poll({ value: "msg-3" });
    assert.equal(replay.batch.records[0].operation, "revise");
    assert.equal(replay.batch.records[0].external_id, "bc-1:msg-3");
    assert.equal(replay.batch.records[0].occurred_at, "2026-08-21T00:06:00.001Z");
  });

  it("does not ingest the in-flight assistant while the agent is still working", async () => {
    const connector = createConnector({
      async getAgent() {
        return agent({ status: "ACTIVE", latestRunId: "run-2" });
      },
      async getConversation() {
        return {
          id: "bc-1",
          messages: [
            ...messages(),
            { id: "msg-3", type: "user_message", text: "Also add tests" },
            {
              id: "msg-4",
              type: "assistant_message",
              text: "I am looking at the tests now.",
            },
          ],
        };
      },
    });
    const result = await connector.poll({ value: "msg-2" });
    assert.equal(result.batch.records[0].external_id, "bc-1:msg-3");
    assert.equal(
      result.batch.records.find((record) => record.type === "thread_status")?.external_id,
      "bc-1:working.run-2",
    );
    assert.equal(result.next_cursor, "msg-3");
  });

  it("keeps local SDK turn ids on the same inbox conversation as the agent", async () => {
    const { conversationId } = require("@regenic/domain");
    const agentId = "agent-90c1d4ef-ad4c-4e48-a6bb-bb9ad3baca92";
    const connector = new CursorAgentPollConnector(
      {
        async getAgent() {
          return {
            id: agentId,
            name: "hi",
            status: "IDLE",
            createdAt: "2026-08-21T00:00:00.000Z",
            updatedAt: "2026-08-21T00:05:00.000Z",
            latestRunId: "run-1",
          };
        },
        async getConversation() {
          return {
            id: agentId,
            messages: [
              {
                id: `${agentId}:0:user`,
                type: "user_message",
                text: "hi",
              },
              {
                id: `${agentId}:0:assistant:1`,
                type: "assistant_message",
                text: "你好",
              },
            ],
          };
        },
      },
      {
        connector_id: "cursor-agent",
        org_id: "local-owner",
        agent_id: agentId,
        now: () => "2026-08-21T00:06:00.000Z",
      },
    );
    const result = await connector.poll(null);
    const thread = `cursor:${agentId}`;
    assert.equal(conversationId("cursor", result.batch.records[0].external_id), thread);
    assert.equal(conversationId("cursor", result.batch.records[1].external_id), thread);
    assert.equal(conversationId("cursor", result.batch.records[2].external_id), thread);
  });
});
