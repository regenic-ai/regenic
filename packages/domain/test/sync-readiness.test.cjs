const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DEFAULT_COLD_STREAM_IDLE_MS,
  DEFAULT_HOT_STREAM_IDLE_MS,
  UNSEEN_SEED_PER_TICK,
  buildSyncSoakReport,
  estimateSyncEta,
  estimateSyncReadiness,
  remainingSyncStreams,
  SYNC_SOAK_METRIC_NAMES,
} = require("../dist");

describe("sync readiness", () => {
  it("does not invent an ETA when nothing remains", () => {
    assert.equal(remainingSyncStreams(null), 0);
    assert.equal(estimateSyncEta({ remaining_streams: 0 }), null);
    const readiness = estimateSyncReadiness({
      progress: {
        discovered: 12,
        seeded: 12,
        unseeded: 0,
        backfilling: 0,
        media_pending: 0,
        catalog_complete: true,
        bootstrap_pending: 0,
        steady: 12,
      },
    });
    assert.equal(readiness.eta, null);
    assert.equal(readiness.freshness_source, "none");
  });

  it("publishes poll freshness instead of a fake 60s SLO", () => {
    const readiness = estimateSyncReadiness({
      metrics: [
        {
          name: "freshness_ms",
          labels: { lane: "live", status: "cold" },
          count: 1,
          sum: 3_600_000,
          max: 3_600_000,
          last: 3_600_000,
          recorded_at: "2026-09-21T00:00:00.000Z",
        },
        {
          name: "freshness_ms",
          labels: { lane: "interactive", status: "hot" },
          count: 1,
          sum: 15_000,
          max: 15_000,
          last: 15_000,
          recorded_at: "2026-09-21T00:00:00.000Z",
        },
      ],
    });
    assert.equal(readiness.freshness_ms, 15_000);
    assert.equal(readiness.freshness_source, "poll");
  });

  it("surfaces 429 before writer wait", () => {
    const readiness = estimateSyncReadiness({
      metrics: [
        {
          name: "source_429",
          labels: {},
          count: 2,
          sum: 2,
          max: 1,
          last: 1,
          recorded_at: "2026-09-21T00:00:00.000Z",
        },
        {
          name: "writer_wait_ms",
          labels: {},
          count: 1,
          sum: 900,
          max: 900,
          last: 900,
          recorded_at: "2026-09-21T00:00:00.000Z",
        },
      ],
    });
    assert.equal(readiness.throttle_reason, "source_429");
  });

  it("gives a 10k unseeded catalog an hour-scale range, not 10k times live idle", () => {
    const eta = estimateSyncEta({
      remaining_streams: 10_000,
      first_seed_per_tick: UNSEEN_SEED_PER_TICK,
      tick_ms: 10_000,
      hot_idle_ms: DEFAULT_HOT_STREAM_IDLE_MS,
      cold_idle_ms: DEFAULT_COLD_STREAM_IDLE_MS,
    });
    assert.ok(eta);
    assert.ok(eta.low_ms > 0);
    assert.ok(eta.high_ms >= eta.low_ms);
    assert.ok(eta.high_ms < 16 * 60 * 60 * 1000);
    assert.ok(eta.high_ms < 10_000 * 180_000);
    const small = estimateSyncEta({ remaining_streams: 8 });
    assert.equal(small.low_ms, 0);
    assert.equal(small.high_ms, DEFAULT_HOT_STREAM_IDLE_MS);
  });
});

describe("sync soak report", () => {
  it("always records the acceptance metric names", () => {
    const report = buildSyncSoakReport({
      plan_ms: 12,
      claim_ms: 4,
      planned: 10_000,
      due_now: 17,
      claimed: 32,
      metrics: [
        {
          name: "work_queue_lag_ms",
          labels: { lane: "live" },
          count: 32,
          sum: 320,
          max: 20,
          last: 8,
          recorded_at: "2026-09-21T00:00:00.000Z",
        },
      ],
      progress: {
        discovered: 10_000,
        seeded: 0,
        unseeded: 10_000,
        backfilling: 0,
        media_pending: 0,
        catalog_complete: true,
        bootstrap_pending: 10_000,
        steady: 0,
      },
      memory: { rss_bytes: 1, heap_used_bytes: 1 },
      wal_bytes: 0,
      now: () => "2026-09-21T00:00:00.000Z",
    });
    assert.deepEqual(Object.keys(report.metrics).sort(), [...SYNC_SOAK_METRIC_NAMES].sort());
    assert.equal(report.metrics.work_queue_lag_ms, 8);
    assert.equal(report.metrics.freshness_ms, 0);
    assert.equal(report.readiness.remaining_streams, 10_000);
    assert.ok(report.readiness.eta);
  });
});
