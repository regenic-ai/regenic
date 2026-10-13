const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  MemoryConnectorRuntimeStore,
  SYNC_CATALOG_STREAM,
  SyncMetricsRegistry,
  UNSEEN_SEED_PER_TICK,
  buildSyncSoakReport,
  planDueSyncWork,
  recordPollFreshness,
  recordWorkQueueLag,
  selectSyncRunWakeKeys,
} = require("../dist");

function member(index) {
  return {
    installation_id: "install-1",
    stream_key: `channel:C${index}`,
    thread_id: `slack:C${index}`,
    generation: 1,
    discovered_at: "2026-09-21T00:00:00.000Z",
    last_seen_at: "2026-09-21T00:00:00.000Z",
  };
}

describe("10k due-work soak", () => {
  it("plans, claims, and wakes without loading every stream on the claim path", async () => {
    const now = "2026-09-21T00:00:00.000Z";
    const members = Array.from({ length: 10_000 }, (_, index) => member(index));
    const metrics = new SyncMetricsRegistry();
    const store = new MemoryConnectorRuntimeStore();
    await store.createInstallation({
      id: "install-1",
      org_id: "org-1",
      connector_type: "fake",
      status: "enabled",
      config: {},
      created_at: now,
    });

    const planStarted = Date.now();
    const planned = planDueSyncWork({
      installation_id: "install-1",
      now,
      plane: "bootstrap",
      preferredThreadId: "slack:C1",
      members,
      states: new Map(),
    });
    const planMs = Date.now() - planStarted;
    const dueNow = planned.filter((item) => item.next_due_at === now);
    const enqueueStarted = Date.now();
    assert.equal(await store.enqueueSyncWorkMany(planned), planned.length);
    const enqueueMs = Date.now() - enqueueStarted;

    const claimStarted = Date.now();
    const claimed = await store.claimSyncWork({
      owner: "soak",
      now: "2026-09-21T00:00:01.000Z",
      lease_ms: 30_000,
      limit: 32,
      unassigned: true,
    });
    const claimMs = Date.now() - claimStarted;
    for (const item of claimed) {
      recordWorkQueueLag(metrics, item.next_due_at, { lane: item.lane }, Date.parse("2026-09-21T00:00:01.000Z"));
    }
    recordPollFreshness(metrics, 60_000, { lane: "live", status: "hot" });

    const wakeKeys = selectSyncRunWakeKeys({
      mode: "quick_start",
      members,
      preferredThreadId: "slack:C1",
    });
    await store.wakeUnassignedSyncWork({
      installation_id: "install-1",
      stream_keys: wakeKeys,
      now: "2026-09-21T00:00:02.000Z",
    });

    const report = buildSyncSoakReport({
      plan_ms: planMs,
      claim_ms: claimMs,
      planned: planned.length,
      due_now: dueNow.length,
      claimed: claimed.length,
      metrics: metrics.snapshot(),
      progress: {
        discovered: members.length,
        seeded: 0,
        unseeded: members.length,
        backfilling: 0,
        media_pending: 0,
        catalog_complete: true,
        bootstrap_pending: members.length,
        steady: 0,
      },
      memory: {
        rss_bytes: process.memoryUsage().rss,
        heap_used_bytes: process.memoryUsage().heapUsed,
      },
      wal_bytes: null,
    });

    assert.equal(planned.some((item) => item.stream_key === SYNC_CATALOG_STREAM), false);
    assert.equal(planned.length, 10_000);
    assert.equal(dueNow.length, 1 + UNSEEN_SEED_PER_TICK);
    assert.equal(claimed.length, dueNow.length);
    assert.equal(wakeKeys.length, 1 + UNSEEN_SEED_PER_TICK);
    assert.equal(
      await store.hasUnassignedSyncWork({
        installation_id: "install-1",
        lanes: ["live", "interactive"],
      }),
      true,
    );
    assert.ok(planMs < 500, `planDueSyncWork took ${planMs}ms`);
    assert.ok(enqueueMs < 1_000, `enqueueSyncWorkMany took ${enqueueMs}ms`);
    assert.ok(claimMs < 100, `claimSyncWork took ${claimMs}ms`);
    assert.equal(report.metrics.work_queue_lag_ms > 0, true);
    assert.equal(report.metrics.freshness_ms, 60_000);
    assert.ok(report.readiness.eta);
    assert.ok(report.readiness.eta.high_ms < 10_000 * 180_000);
    assert.ok(report.memory.rss_bytes > 0);
  });
});
