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
const { DshCliSessionClient, DshSessionPollConnector, MemoryDshRunLog } = require("../dist");

function run(seq, task, stdout) {
  return {
    run_id: `run-${seq}`,
    seq,
    task,
    stdout,
    started_at: "2026-08-21T00:00:00.000Z",
    finished_at: "2026-08-21T00:00:01.000Z",
  };
}

function createConnector(log) {
  return new DshSessionPollConnector(new DshCliSessionClient(log), {
    connector_id: "dsh-session",
    org_id: "local-owner",
    session_id: "dsh-main",
    now: () => "2026-08-21T00:00:00.000Z",
  });
}

describe("DshSessionPollConnector", () => {
  it("maps journaled CLI runs into inbound and outbound records", async () => {
    const connector = createConnector(new MemoryDshRunLog([run(0, "Hello", "Hi")]));
    const result = await connector.poll(null);

    assert.equal(result.next_cursor, "1");
    assert.equal(result.batch.records[0].external_id, "dsh-main:0");
    assert.equal(result.batch.records[0].actor.id, "user");
    assert.deepEqual(result.batch.records[0].direction_tags, ["outbound"]);
    assert.equal(surfaceKind(result.batch.records[0]), "user");
    assert.equal(result.batch.records[1].external_id, "dsh-main:1");
    assert.equal(result.batch.records[1].actor.id, "assistant");
    assert.deepEqual(result.batch.records[1].direction_tags, ["inbound"]);
    assert.equal(surfaceKind(result.batch.records[1]), "assistant");
  });

  it("maps DSH web history like the harness conversation nodes", async () => {
    const connector = new DshSessionPollConnector(
      {
        async sessionHistory() {
          return {
            hasMore: false,
            events: [
              {
                type: "user/message",
                seq: 1,
                time: 1_724_208_000_000,
                data: {
                  role: "user",
                  content: [{ type: "text", text: "Review the form" }],
                  source: { kind: "user" },
                },
              },
              {
                type: "user/message",
                seq: 2,
                time: 1_724_208_000_100,
                data: {
                  role: "user",
                  content: [{ type: "text", text: "Current runtime context" }],
                  source: { kind: "plugin", plugin: "dsh-agent-instructions" },
                },
              },
              {
                type: "assistant/message",
                seq: 3,
                time: 1_724_208_000_200,
                data: {
                  turn: 1,
                  step: 1,
                  message: {
                    role: "assistant",
                    content: [
                      { type: "reasoning", text: "I should inspect the diff." },
                      { type: "tool-call", id: "call_1", name: "bash", arguments: "{}" },
                    ],
                    source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
                  },
                },
              },
              {
                type: "assistant/chunk",
                seq: 4,
                time: 1_724_208_000_300,
                data: { turn: 1, step: 2, chunk: { type: "text-delta", text: "ignore" } },
              },
              {
                type: "assistant/message",
                seq: 5,
                time: 1_724_208_000_400,
                data: {
                  turn: 1,
                  step: 2,
                  message: {
                    role: "assistant",
                    content: [
                      { type: "reasoning", text: "Ready to answer." },
                      { type: "text", text: "The form is ready to ship." },
                    ],
                    source: { kind: "model", provider: "deepseek-official", model: "deepseek-v4-flash" },
                  },
                },
              },
            ],
          };
        },
      },
      {
        connector_id: "dsh-session",
        org_id: "local-owner",
        session_id: "sess-web",
        now: () => "2026-08-21T00:00:00.000Z",
      },
    );

    const result = await connector.poll(null);
    assert.deepEqual(
      result.batch.records.map((record) => [
        record.external_id,
        record.actor.id,
        surfaceKind(record),
        record.direction_tags,
      ]),
      [
        ["sess-web:1", "user", "user", ["outbound"]],
        ["sess-web:2", "plugin", "system", ["inbound"]],
        ["sess-web:5", "assistant", "assistant", ["inbound"]],
      ],
    );
    assert.match(result.batch.records[2].content[0].text, /ready to ship/);
    assert.doesNotMatch(result.batch.records[2].content[0].text, /Ready to answer/);
  });

  it("surfaces ask_user_question tool calls as assistant prompts", async () => {
    const connector = new DshSessionPollConnector(
      {
        async sessionHistory() {
          return {
            hasMore: false,
            events: [
              {
                type: "assistant/message",
                seq: 10,
                time: 1_724_208_001_000,
                data: {
                  message: {
                    content: [{ type: "text", text: "我需要先确认几个关键信息才能正确实现：" }],
                  },
                },
              },
              {
                type: "tool/call",
                seq: 11,
                time: 1_724_208_001_100,
                data: {
                  name: "bash",
                  arguments: "{\"command\":\"ls\"}",
                },
              },
              {
                type: "tool/call",
                seq: 12,
                time: 1_724_208_001_200,
                data: {
                  name: "ask_user_question",
                  arguments: JSON.stringify({
                    questions: [
                      {
                        id: "channel",
                        header: "发送渠道",
                        question: "日报通过什么方式发送给你？",
                        options: [
                          {
                            label: "写入本地文件（推荐）",
                            description: "每天生成一份 Markdown 日报",
                          },
                          { label: "Webhook / 邮件" },
                        ],
                      },
                      {
                        id: "scope",
                        question: "日报总结的范围是什么？",
                      },
                    ],
                  }),
                },
              },
            ],
          };
        },
      },
      {
        connector_id: "dsh-session",
        org_id: "local-owner",
        session_id: "sess-ask",
        now: () => "2026-08-21T00:00:00.000Z",
      },
    );

    const result = await connector.poll(null);
    assert.deepEqual(
      result.batch.records.map((record) => [
        record.external_id,
        surfaceKind(record),
      ]),
      [
        ["sess-ask:10", "assistant"],
        ["sess-ask:12", "assistant"],
      ],
    );
    assert.match(result.batch.records[1].content[0].text, /日报通过什么方式发送给你？/);
    assert.match(result.batch.records[1].content[0].text, /写入本地文件（推荐）/);
    assert.match(result.batch.records[1].content[0].text, /日报总结的范围是什么？/);
    assert.doesNotMatch(result.batch.records[1].content[0].text, /bash/);
    assert.equal(surfaceActivity(result.batch.records[1]), "awaiting_user");
  });

  it("marks invisible labor as a working thread status", async () => {
    const connector = new DshSessionPollConnector(
      {
        async sessionHistory() {
          return {
            hasMore: false,
            events: [
              {
                type: "user/message",
                seq: 1,
                time: 1_724_208_002_000,
                data: {
                  content: [{ type: "text", text: "Continue" }],
                  source: { kind: "user" },
                },
              },
              {
                type: "tool/call",
                seq: 2,
                time: 1_724_208_002_100,
                data: {
                  name: "bash",
                  arguments: "{\"command\":\"ls\"}",
                },
              },
            ],
          };
        },
      },
      {
        connector_id: "dsh-session",
        org_id: "local-owner",
        session_id: "sess-work",
        now: () => "2026-08-21T00:00:00.000Z",
      },
    );

    const result = await connector.poll(null);
    assert.deepEqual(
      result.batch.records.map((record) => [
        record.external_id,
        record.type,
        surfaceKind(record),
        surfaceActivity(record),
      ]),
      [
        ["sess-work:1", "message", "user", undefined],
        ["sess-work:2", "thread_status", "system", "working"],
      ],
    );
    assert.match(result.batch.records[1].content[0].text, /Still working/);
  });

  it("does not add a working marker after a visible assistant reply", async () => {
    const connector = new DshSessionPollConnector(
      {
        async sessionHistory() {
          return {
            hasMore: false,
            events: [
              {
                type: "assistant/reasoning",
                seq: 7,
                time: 1_724_208_003_000,
                data: {},
              },
              {
                type: "assistant/message",
                seq: 8,
                time: 1_724_208_003_100,
                data: {
                  message: { content: [{ type: "text", text: "Here is the outline." }] },
                },
              },
            ],
          };
        },
      },
      {
        connector_id: "dsh-session",
        org_id: "local-owner",
        session_id: "sess-done",
        now: () => "2026-08-21T00:00:00.000Z",
      },
    );

    const result = await connector.poll(null);
    assert.deepEqual(
      result.batch.records.map((record) => [
        record.external_id,
        surfaceKind(record),
        surfaceActivity(record),
      ]),
      [["sess-done:8", "assistant", undefined]],
    );
  });

  it("only accepts events after the committed seq cursor", async () => {
    const connector = createConnector(new MemoryDshRunLog([
      run(0, "Old", "Old reply"),
      run(1, "New", "New reply"),
    ]));
    const result = await connector.poll({ value: "1" });
    assert.equal(result.batch.records.length, 2);
    assert.equal(result.batch.records[0].external_id, "dsh-main:2");
    assert.equal(result.next_cursor, "3");
  });

  it("settles a CLI journal page through the shared connector runtime", async () => {
    const connector = createConnector(new MemoryDshRunLog([run(0, "Hello", "Hi")]));
    const runtime = new MemoryConnectorRuntimeStore();
    await runtime.createInstallation({
      id: "dsh-installation",
      org_id: "local-owner",
      connector_type: "dsh-session",
      status: "enabled",
      config: { transport: "cli", mailbox: "dsh-main" },
      created_at: "2026-08-21T00:00:00.000Z",
    });
    const runner = new ConnectorRunner(
      connector,
      new IngestionService(new MemoryBlobStore(), new MemoryAuthorityStore()),
      runtime,
      () => "2026-08-21T00:00:00.000Z",
    );

    const settled = await runner.poll({
      installation_id: "dsh-installation",
      stream_key: "session:dsh-main",
      lease_owner: "worker-a",
      lease_duration_ms: 30_000,
    });
    const cursor = await runtime.getCursor("dsh-installation", "session:dsh-main");

    assert.equal(settled.status, "completed");
    assert.equal(settled.result.records[0].status, "accepted");
    assert.equal(cursor.cursor, "1");
  });

  it("walks older DSH pages so the cursor does not skip the gap", async () => {
    const client = pagingHistoryClient(6, 2);
    const connector = new DshSessionPollConnector(client, {
      connector_id: "dsh-session",
      org_id: "local-owner",
      session_id: "dsh-main",
      page_size: 2,
      now: () => "2026-08-21T00:00:00.000Z",
    });

    const first = await connector.poll(null);
    assert.deepEqual(client.calls, [
      { sessionId: "dsh-main", maxMessages: 2, beforeSeq: undefined },
      { sessionId: "dsh-main", maxMessages: 2, beforeSeq: 4 },
      { sessionId: "dsh-main", maxMessages: 2, beforeSeq: 2 },
    ]);
    assert.deepEqual(first.batch.records.map((record) => record.external_id), [
      "dsh-main:0",
      "dsh-main:1",
    ]);
    assert.equal(first.next_cursor, "1");
    assert.equal(connector.lastSurfacePage.hasMore, true);

    const second = await connector.poll({ value: "1" });
    assert.deepEqual(second.batch.records.map((record) => record.external_id), [
      "dsh-main:2",
      "dsh-main:3",
    ]);
    assert.equal(second.next_cursor, "3");
  });

  it("resumes a bounded history walk instead of stalling past the page cap", async () => {
    const client = pagingHistoryClient(6, 2);
    const connector = new DshSessionPollConnector(client, {
      connector_id: "dsh-session",
      org_id: "local-owner",
      session_id: "dsh-main",
      page_size: 2,
      max_history_pages: 2,
      now: () => "2026-08-21T00:00:00.000Z",
    });

    const first = await connector.poll(null);
    assert.deepEqual(first.batch.records, []);
    assert.equal(first.next_cursor, "-1:2");
    assert.deepEqual(client.calls, [
      { sessionId: "dsh-main", maxMessages: 2, beforeSeq: undefined },
      { sessionId: "dsh-main", maxMessages: 2, beforeSeq: 4 },
    ]);

    const second = await connector.poll({ value: "-1:2" });
    assert.deepEqual(second.batch.records.map((record) => record.external_id), [
      "dsh-main:0",
      "dsh-main:1",
    ]);
    assert.equal(second.next_cursor, "1");
    assert.deepEqual(client.calls.slice(2), [
      { sessionId: "dsh-main", maxMessages: 2, beforeSeq: 2 },
    ]);
  });

  it("returns the requested DSH history page without using the ingest cursor", async () => {
    const client = pagingHistoryClient(6, 2);
    const connector = new DshSessionPollConnector(client, {
      connector_id: "dsh-session",
      org_id: "local-owner",
      session_id: "dsh-main",
      page_size: 2,
      now: () => "2026-08-21T00:00:00.000Z",
    });

    await connector.poll(null);
    const tail = await connector.historyPage();
    const older = await connector.historyPage({ beforeSeq: 4, maxMessages: 2 });

    assert.deepEqual(tail.events.map((event) => event.seq), [4, 5]);
    assert.equal(tail.hasMore, true);
    assert.deepEqual(older.events.map((event) => event.seq), [2, 3]);
    assert.equal(older.hasMore, true);
  });

  it("passes the reusable poll connector conformance suite", async () => {
    const connector = createConnector(new MemoryDshRunLog([run(0, "Hello", "Hi")]));
    const report = await verifyPollConnectorConformance({
      connector,
      cursor: null,
      connector_id: "dsh-session",
      source: "dsh",
    });
    assert.deepEqual(report, {
      delivery_id: report.delivery_id,
      record_count: 2,
      next_cursor: "1",
    });
  });
});

function pagingHistoryClient(count, pageSize) {
  const events = Array.from({ length: count }, (_, seq) => historyEvent(seq));
  const calls = [];
  return {
    calls,
    async sessionHistory(input) {
      calls.push({
        sessionId: input.sessionId,
        maxMessages: input.maxMessages,
        beforeSeq: input.beforeSeq,
      });
      const older = input.beforeSeq === undefined
        ? events
        : events.filter((event) => event.seq < input.beforeSeq);
      const cap = input.maxMessages ?? pageSize;
      return {
        events: older.slice(-cap),
        hasMore: older.length > cap,
      };
    },
  };
}

function surfaceKind(record) {
  return surfaceOf(record).kind;
}

function surfaceActivity(record) {
  return surfaceOf(record).activity;
}

function surfaceOf(record) {
  const part = record.content.find(
    (entry) => entry.role === "metadata" && entry.media_type === SURFACE_MEDIA_TYPE,
  );
  return JSON.parse(part.text);
}

function historyEvent(seq) {
  const inbound = seq % 2 === 1;
  return {
    type: inbound ? "assistant/message" : "user/message",
    seq,
    time: 1_724_208_000_000 + seq,
    data: inbound
      ? { message: { content: [{ type: "text", text: `a${seq}` }] } }
      : { content: [{ type: "text", text: `u${seq}` }], source: { kind: "user" } },
  };
}
