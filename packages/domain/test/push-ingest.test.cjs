const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  IngestionService,
  MemoryAuthorityStore,
  MemoryBlobStore,
  MemoryConnectorRuntimeStore,
  PushIngestBackpressureError,
  PushIngestGate,
  PushIngestRejectedError,
  SyncMetricsRegistry,
} = require("../dist");

const installation = { id: "installation-1", org_id: "local-owner" };

function event(externalId, overrides = {}) {
  return {
    operation: "create",
    source: "fake",
    external_id: externalId,
    occurred_at: "2026-11-16T00:00:00.000Z",
    actor: { id: "user" },
    scope: { id: "personal" },
    type: "message",
    content: [{ role: "body", media_type: "text/plain", text: externalId }],
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe("push ingest gate", () => {
  it("persists before acking and dedupes replays on source identity", async () => {
    const service = new IngestionService(new MemoryBlobStore(), new MemoryAuthorityStore());
    const gate = new PushIngestGate(service);
    const push = {
      stream_key: "chat-1",
      batch_id: "batch-1",
      events: [event("m-1"), event("m-2")],
      watermark: "w-2",
    };
    const first = await gate.submit({ installation, source: "fake", batch: push });
    assert.equal(first.accepted_count, 2);
    assert.equal(first.batch_id, "batch-1");
    assert.equal(first.watermark, "w-2");
    const replay = await gate.submit({ installation, source: "fake", batch: push });
    assert.equal(replay.accepted_count, 0);
    assert.equal(replay.duplicate_count, 2);
    assert.equal(gate.snapshot("installation-1").acked_batches, 2);
  });

  it("withholds the watermark while any event needs a retry", async () => {
    const gate = new PushIngestGate({
      async ingest(batch) {
        return {
          valid: true,
          connector_id: batch.connector_id,
          delivery_id: batch.delivery_id,
          records: [
            { external_id: "m-1", status: "accepted", event_id: "e-1" },
            { external_id: "m-2", status: "retryable_failure", error_code: "concurrent_source_update" },
          ],
        };
      },
    });
    const ack = await gate.submit({
      installation,
      source: "fake",
      batch: { stream_key: "chat-1", events: [event("m-1"), event("m-2")], watermark: "w-2" },
    });
    assert.equal(ack.retryable_count, 1);
    assert.equal(ack.watermark, undefined);
    assert.ok(ack.batch_id);
  });

  it("rejects malformed batches and records for another source", async () => {
    const gate = new PushIngestGate({ async ingest() { throw new Error("not reached"); } });
    await assert.rejects(
      gate.submit({ installation, source: "fake", batch: { stream_key: "s", events: [] } }),
      (error) => error instanceof PushIngestRejectedError && error.code === "invalid_envelope",
    );
    await assert.rejects(
      gate.submit({
        installation,
        source: "fake",
        batch: { stream_key: "s", events: [event("m-1", { occurred_at: "yesterday" })] },
      }),
      (error) => error instanceof PushIngestRejectedError && error.code === "invalid_record",
    );
    await assert.rejects(
      gate.submit({
        installation,
        source: "fake",
        batch: { stream_key: "s", events: [event("m-1", { source: "other-channel" })] },
      }),
      (error) =>
        error instanceof PushIngestRejectedError &&
        error.code === "connector_mismatch" &&
        error.issues[0].path.join(".") === "events.0.source",
    );
  });

  it("bounds each installation's queue and reports backpressure", async () => {
    const hold = deferred();
    let started = 0;
    const gate = new PushIngestGate(
      {
        async ingest(batch) {
          started += 1;
          await hold.promise;
          return { valid: true, connector_id: batch.connector_id, delivery_id: batch.delivery_id, records: [] };
        },
      },
      { limits: {
        max_pending_per_installation: 2,
        max_inflight_per_installation: 1,
        max_pending_global: 10,
        max_inflight_global: 4,
        retry_after_ms: 750,
      } },
    );
    const submit = (id, stream) => gate.submit({
      installation: { id, org_id: "local-owner" },
      source: "fake",
      batch: { stream_key: stream, events: [event(`${id}-${stream}`)] },
    });
    const a1 = submit("a", "1");
    const a2 = submit("a", "2");
    await assert.rejects(
      gate.submit({
        installation: { id: "a", org_id: "local-owner" },
        source: "fake",
        batch: { stream_key: "3", events: [] },
      }),
      (error) =>
        error instanceof PushIngestBackpressureError &&
        error.scope === "installation" &&
        error.retry_after_ms === 750,
    );
    const b1 = submit("b", "1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(started, 2, "a is capped at one in flight; b is not starved by a");
    assert.deepEqual(
      { queued: gate.snapshot("a").queued, inflight: gate.snapshot("a").inflight },
      { queued: 1, inflight: 1 },
    );
    assert.equal(gate.snapshot("a").backpressure_rejections, 1);
    hold.resolve();
    await Promise.all([a1, a2, b1]);
    assert.equal(started, 3);
    assert.deepEqual(
      { queued: gate.snapshot("a").queued, inflight: gate.snapshot("a").inflight },
      { queued: 0, inflight: 0 },
    );
  });

  it("applies a global pending bound across installations", async () => {
    const hold = deferred();
    const gate = new PushIngestGate(
      {
        async ingest(batch) {
          await hold.promise;
          return { valid: true, connector_id: batch.connector_id, delivery_id: batch.delivery_id, records: [] };
        },
      },
      { limits: {
        max_pending_per_installation: 5,
        max_inflight_per_installation: 1,
        max_pending_global: 2,
        max_inflight_global: 1,
        retry_after_ms: 1_000,
      } },
    );
    const submit = (id) => gate.submit({
      installation: { id, org_id: "local-owner" },
      source: "fake",
      batch: { stream_key: "s", events: [event(id)] },
    });
    const pending = [submit("a"), submit("b")];
    assert.equal(gate.busy(), true);
    await assert.rejects(
      submit("c"),
      (error) => error instanceof PushIngestBackpressureError && error.scope === "global",
    );
    hold.resolve();
    await Promise.all(pending);
    await submit("c");
    assert.equal(gate.busy(), false);
    assert.equal(gate.pressured(), false);
  });

  it("keeps backfill moving during one in-flight ack and pauses when the gate is full", async () => {
    const hold = deferred();
    const gate = new PushIngestGate(
      {
        async ingest(batch) {
          await hold.promise;
          return { valid: true, connector_id: batch.connector_id, delivery_id: batch.delivery_id, records: [] };
        },
      },
    );
    const submit = (id) => gate.submit({
      installation: { id, org_id: "local-owner" },
      source: "fake",
      batch: { stream_key: "s", events: [event(id)] },
    });
    const pending = submit("a");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gate.busy(), true);
    assert.equal(gate.pressured(), false);
    assert.equal(gate.installationBusy("a"), true);
    assert.equal(gate.installationBusy("b"), false);
    const capped = new PushIngestGate(
      {
        async ingest(batch) {
          await hold.promise;
          return { valid: true, connector_id: batch.connector_id, delivery_id: batch.delivery_id, records: [] };
        },
      },
      { limits: {
        max_pending_per_installation: 4,
        max_inflight_per_installation: 1,
        max_pending_global: 8,
        max_inflight_global: 1,
        retry_after_ms: 1_000,
      } },
    );
    const held = capped.submit({
      installation: { id: "full", org_id: "local-owner" },
      source: "fake",
      batch: { stream_key: "s", events: [event("full")] },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(capped.pressured(), true);
    assert.equal(capped.installationBusy("full"), true);
    hold.resolve();
    await Promise.all([pending, held]);
    assert.equal(gate.installationBusy("a"), false);
    assert.equal(capped.pressured(), false);
  });

  it("persists the watermark before acking and only for clean batches", async () => {
    const store = new MemoryConnectorRuntimeStore();
    const created = await store.createInstallation({
      id: "install-w",
      org_id: "local-owner",
      connector_type: "fake",
      status: "enabled",
      config: {},
      created_at: "2026-11-16T00:00:00.000Z",
    });
    const target = { id: created.id, org_id: created.org_id };
    let retryable = false;
    const gate = new PushIngestGate(
      {
        async ingest(batch) {
          return {
            valid: true,
            connector_id: batch.connector_id,
            delivery_id: batch.delivery_id,
            records: [retryable
              ? { external_id: "m", status: "retryable_failure", error_code: "busy" }
              : { external_id: "m", status: "accepted", event_id: "e" }],
          };
        },
      },
      { watermarks: store, now: () => Date.parse("2026-11-16T01:00:00.000Z") },
    );
    await gate.submit({
      installation: target,
      source: "fake",
      batch: { stream_key: "b", batch_id: "batch-b", events: [event("m")], watermark: "w-b1" },
    });
    await gate.submit({
      installation: target,
      source: "fake",
      batch: { stream_key: "a", events: [event("m")], watermark: "w-a1" },
    });
    retryable = true;
    await gate.submit({
      installation: target,
      source: "fake",
      batch: { stream_key: "b", events: [event("m")], watermark: "w-b2" },
    });
    const listed = await store.listPushWatermarks(created.id);
    assert.deepEqual(listed.map((item) => [item.stream_key, item.watermark]), [["a", "w-a1"], ["b", "w-b1"]]);
    assert.equal(listed[1].batch_id, "batch-b");
    assert.deepEqual(
      (await store.listPushWatermarks(created.id, { after: "a", limit: 5 })).map((item) => item.stream_key),
      ["b"],
    );
    assert.deepEqual(
      (await store.listPushWatermarks(created.id, { stream_keys: ["b", "zzz"] })).map((item) => item.stream_key),
      ["b"],
    );
    assert.deepEqual(await store.summarizePushWatermarks(created.id), {
      stream_count: 2,
      last_updated_at: "2026-11-16T01:00:00.000Z",
    });
    await store.deleteInstallation(created.id, created.org_id);
    assert.deepEqual(await store.summarizePushWatermarks(created.id), { stream_count: 0 });
  });

  it("records push lag, backlog, and backpressure into metrics", async () => {
    const metrics = new SyncMetricsRegistry();
    let now = Date.parse("2026-11-16T02:00:00.000Z");
    const hold = deferred();
    const gate = new PushIngestGate(
      {
        async ingest(batch) {
          await hold.promise;
          return {
            valid: true,
            connector_id: batch.connector_id,
            delivery_id: batch.delivery_id,
            records: [{ external_id: "m", status: "accepted", event_id: "e" }],
          };
        },
      },
      {
        metrics,
        now: () => now,
        limits: {
          max_pending_per_installation: 1,
          max_inflight_per_installation: 1,
          max_pending_global: 4,
          max_inflight_global: 1,
          retry_after_ms: 100,
        },
      },
    );
    const pending = gate.submit({
      installation,
      source: "fake",
      batch: { stream_key: "s", events: [event("m")], watermark: "w" },
    });
    await assert.rejects(
      gate.submit({
        installation,
        source: "fake",
        batch: { stream_key: "s", events: [event("m2")] },
      }),
      (error) => error instanceof PushIngestBackpressureError,
    );
    hold.resolve();
    await pending;
    now += 5_000;
    gate.sampleObservability(now);
    const names = new Map(metrics.snapshot().map((row) => [row.name, row]));
    assert.equal(names.get("push_backpressure")?.last, 1);
    assert.equal(names.get("push_ack_latency_ms")?.last, 0);
    assert.equal(names.get("accepted_records")?.last, 1);
    assert.equal(names.get("push_lag_ms")?.last, 5_000);
    assert.equal(gate.snapshot("installation-1", now).lag_ms, 5_000);
    assert.equal(gate.snapshotAll(now).length, 1);
  });
});
