const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  catalogDueWork,
  dueWorkCoverageLanes,
  firstSeedHeadFromEnv,
  firstSeedStaggerDelayMs,
  needsCatalogDueWork,
  planDueSyncWork,
  selectQuickStartStreamKeys,
  selectSyncRunWakeKeys,
  SYNC_CATALOG_STREAM,
  syncRunWorkLanes,
  syncRunWorkPlane,
  UNSEEN_SEED_PER_TICK,
  uncoveredCatalogMembers,
} = require("../dist");

function member(streamKey, extras = {}) {
  return {
    installation_id: "install-1",
    stream_key: streamKey,
    generation: extras.generation ?? 1,
    discovered_at: "2026-09-21T00:00:00.000Z",
    last_seen_at: "2026-09-21T00:00:00.000Z",
    ...extras,
  };
}

function state(streamKey, extras = {}) {
  return [
    streamKey,
    {
      installation_id: "install-1",
      stream_key: streamKey,
      phase: extras.phase ?? "steady",
      media_pending: extras.media_pending ?? false,
      generation: extras.generation ?? 1,
      updated_at: "2026-09-21T00:00:00.000Z",
      ...extras,
    },
  ];
}

describe("due-work planner", () => {
  it("enqueues live work and defers idle streams", () => {
    const planned = planDueSyncWork({
      installation_id: "install-1",
      now: "2026-09-21T00:00:00.000Z",
      plane: "steady",
      preferredThreadId: "slack:C-hot",
      members: [
        member("__skip__", { stream_key: SYNC_CATALOG_STREAM }),
        member("hot", { thread_id: "slack:C-hot" }),
        member("cold", { thread_id: "slack:C-cold" }),
        member("quiet", { thread_id: "slack:C-quiet" }),
        member("old", { thread_id: "slack:C-old" }),
      ],
      states: new Map([
        state("hot", { phase: "live" }),
        state("cold", {
          phase: "steady",
          idle_until: "2026-09-21T00:03:00.000Z",
        }),
        state("quiet", { phase: "steady" }),
        state("old", { phase: "history" }),
      ]),
    });
    assert.deepEqual(
      planned.map((item) => [item.lane, item.stream_key, item.next_due_at]),
      [
        ["interactive", "hot", "2026-09-21T00:00:00.000Z"],
        ["live", "cold", "2026-09-21T00:03:00.000Z"],
        ["live", "quiet", "2026-09-21T01:00:00.000Z"],
      ],
    );
    assert.ok(planned[0].priority > planned[1].priority);
  });

  it("schedules bootstrap history without touching idle live streams", () => {
    const planned = planDueSyncWork({
      installation_id: "install-1",
      now: "2026-09-21T00:00:00.000Z",
      plane: "bootstrap",
      members: [member("seed"), member("backfill"), member("ready")],
      states: new Map([
        state("seed", { phase: "unseeded" }),
        state("backfill", { phase: "history" }),
        state("ready", { phase: "steady" }),
      ]),
    });
    assert.deepEqual(
      planned.map((item) => [item.lane, item.stream_key, item.next_due_at]),
      [
        ["live", "seed", "2026-09-21T00:00:00.000Z"],
        ["history", "backfill", "2026-09-21T00:00:00.000Z"],
      ],
    );
  });

  it("reads first-seed head size from env and spreads leftover delays", () => {
    assert.equal(firstSeedHeadFromEnv({}), UNSEEN_SEED_PER_TICK);
    assert.equal(firstSeedHeadFromEnv({ REGENIC_SYNC_FIRST_SEED_HEAD: "8" }), 8);
    assert.equal(
      firstSeedStaggerDelayMs({ index: 0, count: 2, windowMs: 3_600_000 }),
      1_800_000,
    );
    assert.equal(
      firstSeedStaggerDelayMs({ index: 1, count: 2, windowMs: 3_600_000 }),
      3_600_000,
    );
  });

  it("enqueues catalog discovery instead of implying a full stream scan", () => {
    assert.equal(
      needsCatalogDueWork({ members: [], catalog: null }),
      true,
    );
    assert.equal(
      needsCatalogDueWork({
        members: [member("hot")],
        catalog: { complete: true },
      }),
      false,
    );
    assert.equal(
      needsCatalogDueWork({
        members: [member("hot")],
        catalog: { complete: false },
      }),
      true,
    );
    const item = catalogDueWork({
      installation_id: "install-1",
      now: "2026-09-21T00:00:00.000Z",
      generation: 2,
    });
    assert.equal(item.lane, "catalog");
    assert.equal(item.stream_key, SYNC_CATALOG_STREAM);
    assert.equal(item.id, "due:install-1:catalog:2:__catalog__");
  });

  it("skips members that already have unassigned work at this generation", () => {
    assert.deepEqual(dueWorkCoverageLanes("steady"), [
      "interactive",
      "live",
      "media",
    ]);
    assert.deepEqual(dueWorkCoverageLanes("bootstrap"), ["history"]);
    const uncovered = uncoveredCatalogMembers(
      [
        member("channel:new"),
        member("channel:old"),
        member("__skip__", { stream_key: SYNC_CATALOG_STREAM }),
      ],
      [
        { stream_key: "channel:old", generation: 1 },
        { stream_key: SYNC_CATALOG_STREAM, generation: 1 },
      ],
    );
    assert.deepEqual(
      uncovered.map((item) => item.stream_key),
      ["channel:new"],
    );
  });

  it("plans 10_000 members without a per-tick cursor scan", () => {
    const now = "2026-09-21T00:00:00.000Z";
    const members = Array.from({ length: 10_000 }, (_, index) =>
      member(`channel:C${index}`, { thread_id: `slack:C${index}` }),
    );
    const states = new Map(
      members.map((item, index) =>
        state(item.stream_key, {
          phase: index % 20 === 0 ? "history" : "steady",
          idle_until:
            index % 7 === 0 ? "2026-09-21T00:05:00.000Z" : undefined,
        }),
      ),
    );
    const started = Date.now();
    const planned = planDueSyncWork({
      installation_id: "install-1",
      now,
      plane: "steady",
      preferredThreadId: "slack:C1",
      members,
      states,
    });
    const elapsed = Date.now() - started;
    assert.ok(planned.length > 8_000);
    assert.ok(planned.every((item) => item.lane !== "history"));
    assert.equal(planned[0].lane, "interactive");
    assert.equal(planned[0].stream_key, "channel:C1");
    assert.equal(planned[0].next_due_at, now);
    const dueNow = planned.filter((item) => item.next_due_at === now);
    assert.equal(dueNow.length, 1);
    const quiet = planned.find((item) => item.stream_key === "channel:C2");
    assert.equal(quiet.next_due_at, "2026-09-21T04:00:00.000Z");
    assert.ok(
      planned.filter((item) => item.next_due_at > now).length > 8_000,
    );
    assert.ok(
      elapsed < 500,
      `planDueSyncWork(10k) took ${elapsed}ms`,
    );
  });

  it("seeds a recent unseeded head and staggers the rest", () => {
    const now = "2026-09-21T00:00:00.000Z";
    const planned = planDueSyncWork({
      installation_id: "install-1",
      now,
      plane: "steady",
      preferredThreadId: "slack:C-hot",
      firstSeedLimit: 2,
      coldIdleMs: 3_600_000,
      members: [
        member("hot", {
          thread_id: "slack:C-hot",
          last_seen_at: "2026-09-21T00:00:00.000Z",
        }),
        member("recent-b", {
          thread_id: "slack:C-b",
          last_seen_at: "2026-09-21T00:00:30.000Z",
        }),
        member("recent-a", {
          thread_id: "slack:C-a",
          last_seen_at: "2026-09-21T00:00:40.000Z",
        }),
        member("tail-1", {
          thread_id: "slack:C-1",
          last_seen_at: "2026-09-20T00:00:00.000Z",
        }),
        member("tail-2", {
          thread_id: "slack:C-2",
          last_seen_at: "2026-09-19T00:00:00.000Z",
        }),
      ],
      states: new Map(),
    });
    const dueNow = planned.filter((item) => item.next_due_at === now);
    assert.deepEqual(
      dueNow.map((item) => [item.lane, item.stream_key]),
      [
        ["interactive", "hot"],
        ["live", "recent-a"],
        ["live", "recent-b"],
      ],
    );
    const deferred = planned.filter((item) => item.next_due_at !== now);
    assert.deepEqual(
      deferred.map((item) => item.stream_key),
      ["tail-1", "tail-2"],
    );
    assert.ok(deferred[0].next_due_at > now);
    assert.ok(deferred[1].next_due_at > deferred[0].next_due_at);
    assert.ok(deferred[1].next_due_at <= "2026-09-21T01:00:00.000Z");
  });

  it("does not due-now 10_000 unseeded streams", () => {
    const now = "2026-09-21T00:00:00.000Z";
    const members = Array.from({ length: 10_000 }, (_, index) =>
      member(`channel:C${index}`, {
        thread_id: `slack:C${index}`,
        last_seen_at: "2026-09-21T00:00:00.000Z",
      }),
    );
    const started = Date.now();
    const planned = planDueSyncWork({
      installation_id: "install-1",
      now,
      plane: "bootstrap",
      preferredThreadId: "slack:C1",
      members,
      states: new Map(),
    });
    const elapsed = Date.now() - started;
    const dueNow = planned.filter((item) => item.next_due_at === now);
    assert.equal(planned.length, 10_000);
    assert.equal(dueNow.length, 17);
    assert.equal(dueNow[0].lane, "interactive");
    assert.equal(dueNow[0].stream_key, "channel:C1");
    assert.ok(dueNow.slice(1).every((item) => item.lane === "live"));
    assert.ok(
      planned.filter((item) => item.next_due_at > now).length > 9_900,
    );
    const dueTimes = new Set(
      planned
        .filter((item) => item.next_due_at !== now)
        .map((item) => item.next_due_at),
    );
    assert.ok(dueTimes.size > 1_000);
    assert.ok(
      elapsed < 500,
      `planDueSyncWork(10k unseeded) took ${elapsed}ms`,
    );
  });
});

describe("sync run due-work selection", () => {
  it("maps modes onto claim lanes without a full catalog scan", () => {
    assert.equal(syncRunWorkPlane("quick_start"), "bootstrap");
    assert.equal(syncRunWorkPlane("archive"), "bootstrap");
    assert.equal(syncRunWorkPlane("continuous"), "steady");
    assert.deepEqual(syncRunWorkLanes("quick_start"), [
      "interactive",
      "live",
      "catalog",
    ]);
    assert.deepEqual(syncRunWorkLanes("continuous"), [
      "interactive",
      "live",
      "catalog",
      "media",
    ]);
    assert.deepEqual(syncRunWorkLanes("archive"), [
      "interactive",
      "live",
      "catalog",
      "history",
    ]);
  });

  it("wakes the open thread plus a recent head, including already-seeded streams", () => {
    const keys = selectQuickStartStreamKeys({
      preferredThreadId: "slack:C-open",
      limit: 2,
      members: [
        member(SYNC_CATALOG_STREAM),
        member("old", {
          thread_id: "slack:C-old",
          last_seen_at: "2026-09-20T00:00:00.000Z",
        }),
        member("seeded-recent", {
          thread_id: "slack:C-seeded",
          last_seen_at: "2026-09-21T12:00:00.000Z",
        }),
        member("open", {
          thread_id: "slack:C-open",
          last_seen_at: "2026-09-19T00:00:00.000Z",
        }),
        member("fresh", {
          thread_id: "slack:C-fresh",
          last_seen_at: "2026-09-21T11:00:00.000Z",
        }),
      ],
    });
    assert.deepEqual(keys, ["open", "seeded-recent", "fresh"]);
  });

  it("does not wake 10_000 streams for a quick start", () => {
    const members = Array.from({ length: 10_000 }, (_, index) =>
      member(`channel:C${index}`, {
        thread_id: `slack:C${index}`,
        last_seen_at: `2026-09-21T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      }),
    );
    const started = Date.now();
    const keys = selectSyncRunWakeKeys({
      mode: "quick_start",
      preferredThreadId: "slack:C1",
      members,
    });
    assert.equal(keys[0], "channel:C1");
    assert.equal(keys.length, 1 + UNSEEN_SEED_PER_TICK);
    assert.equal(
      selectSyncRunWakeKeys({ mode: "continuous", members }).length,
      0,
    );
    assert.deepEqual(
      selectSyncRunWakeKeys({
        mode: "archive",
        members,
        streamKeys: ["channel:C9", "channel:C9", ""],
      }),
      ["channel:C9"],
    );
    assert.ok(
      Date.now() - started < 250,
      "selecting wake keys should not scan-sleep 10k members",
    );
  });
});
