const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ConnectorRunner,
  IngestionService,
  MemoryAuthorityStore,
  MemoryBlobStore,
  MemoryConnectorRuntimeStore,
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
    assert.equal(result.batch.records[1].external_id, "dsh-main:1");
    assert.equal(result.batch.records[1].actor.id, "assistant");
    assert.deepEqual(result.batch.records[1].direction_tags, ["inbound"]);
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
