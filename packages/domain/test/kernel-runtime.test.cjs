const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  applyKernelPressureToSyncBudget,
  classifyKernelPressure,
  kernelPressureView,
  kernelPressureThresholdsFromEnv,
  shouldDeferBackgroundSync,
} = require("../dist/kernel-pressure.js");
const { yieldToEventLoop } = require("../dist/sync-budget.js");
const { classifyKernelReachability } = require("../dist/kernel-reachability.js");
const {
  buildSyncProgressSnapshot,
  countSyncProgress,
  SyncProgressSnapshotStore,
  syncProgressViewFromCounts,
} = require("../dist/sync-progress-snapshot.js");
const {
  personalReadTierFromDetail,
  personalReadTierSpec,
} = require("../dist/personal-read-tier.js");

describe("kernel pressure", () => {
  it("classifies heap and lag", () => {
    assert.equal(
      classifyKernelPressure({ rss_bytes: 100_000_000, heap_used_bytes: 90_000_000 }),
      "ok",
    );
    assert.equal(
      classifyKernelPressure({
        rss_bytes: 500_000_000,
        heap_used_bytes: 450_000_000,
      }),
      "elevated",
    );
    assert.equal(
      classifyKernelPressure({
        rss_bytes: 900_000_000,
        heap_used_bytes: 850_000_000,
        event_loop_lag_ms: 600,
      }),
      "critical",
    );
  });

  it("throttles history and media first", () => {
    assert.deepEqual(
      applyKernelPressureToSyncBudget(
        { pages: 5, concurrency: 6, lane: "history" },
        "elevated",
      ),
      { pages: 1, concurrency: 1, lane: "history" },
    );
    assert.deepEqual(
      applyKernelPressureToSyncBudget(
        { pages: 1, concurrency: 2, lane: "media" },
        "critical",
      ),
      { pages: 1, concurrency: 0, lane: "media" },
    );
    assert.deepEqual(
      applyKernelPressureToSyncBudget(
        { pages: 5, concurrency: 6, lane: "live" },
        "elevated",
      ),
      { pages: 5, concurrency: 3, lane: "live" },
    );
  });

  it("marks interactive readiness from pressure", () => {
    assert.equal(
      kernelPressureView({
        rss_bytes: 100_000_000,
        heap_used_bytes: 90_000_000,
      }).interactive_ready,
      true,
    );
    assert.equal(
      kernelPressureView({
        rss_bytes: 900_000_000,
        heap_used_bytes: 850_000_000,
      }).interactive_ready,
      false,
    );
  });

  it("defers background sync while interactive reads are waiting", () => {
    assert.equal(
      shouldDeferBackgroundSync({
        rss_bytes: 100_000_000,
        heap_used_bytes: 90_000_000,
        interactive_waiters: 0,
      }),
      false,
    );
    assert.equal(
      shouldDeferBackgroundSync({
        rss_bytes: 100_000_000,
        heap_used_bytes: 90_000_000,
        interactive_waiters: 2,
      }),
      true,
    );
  });

  it("defers background sync under critical pressure even without waiters", () => {
    assert.equal(
      shouldDeferBackgroundSync({
        rss_bytes: 900_000_000,
        heap_used_bytes: 850_000_000,
        interactive_waiters: 0,
      }),
      true,
    );
    assert.equal(
      shouldDeferBackgroundSync({
        rss_bytes: 100_000_000,
        heap_used_bytes: 90_000_000,
        event_loop_lag_ms: 600,
        interactive_waiters: 0,
      }),
      true,
    );
  });

  it("reads pressure thresholds from env overrides", () => {
    const thresholds = kernelPressureThresholdsFromEnv({
      REGENIC_KERNEL_ELEVATED_HEAP_BYTES: "536870912",
      REGENIC_KERNEL_CRITICAL_LAG_MS: "750",
    });
    assert.equal(thresholds.elevated_heap_bytes, 536_870_912);
    assert.equal(thresholds.critical_lag_ms, 750);
    assert.equal(thresholds.critical_heap_bytes, 768 * 1024 * 1024);
  });
});

describe("catalog field when", () => {
  const { matchesCatalogFieldWhen } = require("../dist/catalog-field-when.js");

  it("matches a single value or any listed value", () => {
    assert.equal(
      matchesCatalogFieldWhen({ field: "selection", value: "all" }, {
        selection: "all",
      }),
      true,
    );
    assert.equal(
      matchesCatalogFieldWhen({ field: "selection", values: ["all", "recent"] }, {
        selection: "recent",
      }),
      true,
    );
    assert.equal(
      matchesCatalogFieldWhen({ field: "selection", values: ["all", "recent"] }, {
        selection: "pick",
      }),
      false,
    );
  });
});

describe("sync budget", () => {
  it("yields the event loop", async () => {
    let yielded = false;
    const pending = yieldToEventLoop().then(() => {
      yielded = true;
    });
    assert.equal(yielded, false);
    await pending;
    assert.equal(yielded, true);
  });
});

describe("sync progress snapshot", () => {
  it("counts scoped members without full catalog reread on peek", () => {
    const counts = countSyncProgress(
      [
        { installation_id: "i1", stream_key: "chat:a", generation: 1, discovered_at: "t", last_seen_at: "t" },
        { installation_id: "i1", stream_key: "chat:b", generation: 1, discovered_at: "t", last_seen_at: "t" },
      ],
      [
        {
          installation_id: "i1",
          stream_key: "chat:a",
          phase: "history",
          generation: 1,
          updated_at: "t",
        },
      ],
      true,
    );
    assert.equal(counts.catalog_members, 2);
    assert.equal(counts.seeded, 1);
    assert.equal(counts.unseeded, 1);
    assert.equal(counts.backfilling, 1);
    assert.deepEqual(syncProgressViewFromCounts(counts).backfilling, 1);
  });

  it("stores and serves installation snapshots", () => {
    const store = new SyncProgressSnapshotStore();
    const snapshot = buildSyncProgressSnapshot({
      installation_id: "feishu-1",
      members: [
        { installation_id: "feishu-1", stream_key: "chat:a", generation: 1, discovered_at: "t", last_seen_at: "t" },
      ],
      states: [],
      catalog_complete: true,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    store.publish(snapshot);
    assert.equal(store.peekProgress("feishu-1")?.discovered, 1);
    assert.equal(store.peek("feishu-1")?.updated_at, "2026-01-01T00:00:00.000Z");
  });
});

describe("personal read tier", () => {
  it("maps detail=0 to snapshot engine reads", () => {
    assert.equal(personalReadTierFromDetail(false), "engine");
    assert.equal(personalReadTierFromDetail("0"), "engine");
    assert.equal(
      personalReadTierSpec("engine").sync_progress,
      "snapshot",
    );
    assert.equal(
      personalReadTierSpec("heartbeat").sync_progress,
      "none",
    );
  });

  it("keeps heads off channel overlays unless live=1", () => {
    const {
      personalInboxReadTierSpec,
      personalInboxReadTier,
      shouldQueryInboxChannelOverlays,
    } = require("../dist/personal-read-tier.js");
    assert.equal(personalInboxReadTier({ heads: true }), "heads");
    assert.equal(
      personalInboxReadTierSpec("heads").connector_prompts,
      false,
    );
    assert.equal(shouldQueryInboxChannelOverlays({ heads: true }), false);
    assert.equal(
      shouldQueryInboxChannelOverlays({ heads: true, live: true }),
      true,
    );
  });
});

describe("inbox summary snapshot", () => {
  it("stores org-scoped summarize results", () => {
    const { InboxSummarySnapshotStore } = require("../dist/inbox-summary-snapshot.js");
    const store = new InboxSummarySnapshotStore();
    store.publish({
      org_id: "org-1",
      count: 12,
      digest: "12:2026:evt",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    assert.deepEqual(store.summary("org-1"), {
      count: 12,
      digest: "12:2026:evt",
    });
    assert.equal(store.summary("org-2"), null);
  });
});

describe("kernel reachability", () => {
  it("distinguishes offline, degraded, and live", () => {
    assert.equal(
      classifyKernelReachability({ health_ok: false }),
      "offline",
    );
    assert.equal(
      classifyKernelReachability({ health_ok: true, personal_ok: true, latency_ms: 500 }),
      "live",
    );
    assert.equal(
      classifyKernelReachability({ health_ok: true, personal_ok: true, latency_ms: 9_000 }),
      "degraded",
    );
    assert.equal(
      classifyKernelReachability({
        health_ok: true,
        personal_ok: true,
        latency_ms: 500,
        pressure_level: "critical",
      }),
      "degraded",
    );
  });
});
