const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { SyncMetricsRegistry, recordPollFreshness, recordWorkQueueLag, syncMetricDeltas } = require("../dist");

describe("sync observability", () => {
  it("aggregates metrics by stable labels", () => {
    const metrics = new SyncMetricsRegistry();
    metrics.record({
      name: "source_poll_ms",
      value: 12,
      labels: { stream_key: "s1", installation_id: "i1" },
    });
    metrics.record({
      name: "source_poll_ms",
      value: 20,
      labels: { installation_id: "i1", stream_key: "s1" },
    });

    const [aggregate] = metrics.snapshot();
    assert.equal(aggregate.count, 2);
    assert.equal(aggregate.sum, 32);
    assert.equal(aggregate.max, 20);
    assert.equal(aggregate.last, 20);
  });

  it("drops non-finite values", () => {
    const metrics = new SyncMetricsRegistry();
    metrics.record({ name: "wal_bytes", value: Number.NaN });
    assert.deepEqual(metrics.snapshot(), []);
  });

  it("records work-queue lag from next_due_at without a stream_key label", () => {
    const metrics = new SyncMetricsRegistry();
    recordWorkQueueLag(
      metrics,
      "2026-09-21T00:00:00.000Z",
      { installation_id: "install-1", lane: "live" },
      Date.parse("2026-09-21T00:00:05.000Z"),
    );
    const [aggregate] = metrics.snapshot();
    assert.equal(aggregate.name, "work_queue_lag_ms");
    assert.equal(aggregate.last, 5_000);
    assert.equal(aggregate.labels.stream_key, undefined);
    assert.equal(aggregate.labels.lane, "live");
  });

  it("records poll-only freshness without a stream_key label", () => {
    const metrics = new SyncMetricsRegistry();
    recordPollFreshness(metrics, 3_600_000, {
      installation_id: "install-1",
      lane: "live",
      status: "cold",
    });
    const [aggregate] = metrics.snapshot();
    assert.equal(aggregate.name, "freshness_ms");
    assert.equal(aggregate.last, 3_600_000);
    assert.equal(aggregate.labels.stream_key, undefined);
    assert.equal(aggregate.labels.status, "cold");
  });

  it("returns only samples recorded between two snapshots", () => {
    const metrics = new SyncMetricsRegistry();
    metrics.record({
      name: "database_transaction_ms",
      value: 4,
      labels: { operation: "commit_sync_page" },
    });
    const before = metrics.snapshot();
    metrics.record({
      name: "database_transaction_ms",
      value: 9,
      labels: { operation: "commit_sync_page" },
    });
    metrics.record({
      name: "writer_wait_ms",
      value: 2,
      labels: { operation: "commitSyncPage" },
    });
    const points = syncMetricDeltas(before, metrics.snapshot());
    assert.deepEqual(
      points.map((point) => [point.name, point.value, point.labels.operation]),
      [
        ["database_transaction_ms", 9, "commit_sync_page"],
        ["writer_wait_ms", 2, "commitSyncPage"],
      ],
    );
  });
});
