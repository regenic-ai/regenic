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
