const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ConnectorRunner,
  INGEST_SCHEMA_VERSION,
  MemoryConnectorRuntimeStore,
} = require("../dist");

function batch() {
  return {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "fake-poll",
    org_id: "local-owner",
    delivery_id: "page-1",
    received_at: "2026-08-12T00:00:00.000Z",
    records: [],
  };
}

function validResult(records) {
  return {
    valid: true,
    connector_id: "fake-poll",
    delivery_id: "page-1",
    records,
  };
}

async function createRuntime() {
  const runtime = new MemoryConnectorRuntimeStore();
  await runtime.createInstallation({
    id: "installation-1",
    org_id: "local-owner",
    connector_type: "fake-poll",
    status: "enabled",
    config: {},
    created_at: "2026-08-12T00:00:00.000Z",
  });
  return runtime;
}

function createRunner(runtime, records) {
  const seenCursors = [];
  const connector = {
    async poll(cursor) {
      seenCursors.push(cursor?.value ?? null);
      return { batch: batch(), next_cursor: "cursor-2" };
    },
  };
  const processor = { async ingest() { return validResult(records); } };
  const runner = new ConnectorRunner(
    connector,
    processor,
    runtime,
    () => "2026-08-12T00:00:00.000Z",
  );
  return { runner, seenCursors };
}

const input = {
  installation_id: "installation-1",
  stream_key: "personal",
  lease_owner: "worker-a",
  lease_duration_ms: 30_000,
};

describe("ConnectorRunner", () => {
  it("settles an accepted page and advances its cursor", async () => {
    const runtime = await createRuntime();
    const { runner, seenCursors } = createRunner(runtime, [
      { external_id: "message-1", status: "accepted", event_id: "event-1" },
    ]);

    const run = await runner.poll(input);
    const cursor = await runtime.getCursor("installation-1", "personal");

    assert.equal(run.status, "completed");
    assert.deepEqual(seenCursors, [null]);
    assert.equal(cursor.cursor, "cursor-2");
    assert.equal(cursor.cursor_version, 2);
  });

  it("advances past a record only after it is durably quarantined", async () => {
    const runtime = await createRuntime();
    const { runner } = createRunner(runtime, [
      {
        external_id: "bad-message",
        status: "quarantined",
        error_code: "content_unavailable",
      },
    ]);

    const run = await runner.poll(input);
    const cursor = await runtime.getCursor("installation-1", "personal");

    assert.equal(run.status, "completed");
    assert.equal(cursor.cursor, "cursor-2");
  });

  it("does not advance a cursor after a retryable record failure", async () => {
    const runtime = await createRuntime();
    const { runner } = createRunner(runtime, [
      {
        external_id: "message-1",
        status: "retryable_failure",
        error_code: "concurrent_source_update",
      },
    ]);

    const run = await runner.poll(input);
    const cursor = await runtime.getCursor("installation-1", "personal");

    assert.equal(run.status, "retryable_failure");
    assert.equal(cursor.cursor, undefined);
    assert.equal(cursor.cursor_version, 1);
  });

  it("rejects a concurrent lease owner before polling", async () => {
    const runtime = await createRuntime();
    await runtime.acquireLease({
      ...input,
      now: "2026-08-12T00:00:00.000Z",
    });
    const { runner, seenCursors } = createRunner(runtime, []);

    const run = await runner.poll({ ...input, lease_owner: "worker-b" });

    assert.equal(run.status, "lease_unavailable");
    assert.deepEqual(seenCursors, []);
  });

  it("settles and releases the lease when the processor throws", async () => {
    const runtime = await createRuntime();
    const connector = {
      async poll() {
        return { batch: batch(), next_cursor: "cursor-2" };
      },
    };
    const processor = {
      async ingest() {
        throw new Error("store unavailable");
      },
    };
    const runner = new ConnectorRunner(
      connector,
      processor,
      runtime,
      () => "2026-08-12T00:00:00.000Z",
    );

    await assert.rejects(() => runner.poll(input), /store unavailable/);
    const nextLease = await runtime.acquireLease({
      ...input,
      lease_owner: "worker-b",
      now: "2026-08-12T00:00:01.000Z",
    });
    const cursor = await runtime.getCursor("installation-1", "personal");

    assert.equal(nextLease.lease_owner, "worker-b");
    assert.equal(cursor.cursor, undefined);
  });
});