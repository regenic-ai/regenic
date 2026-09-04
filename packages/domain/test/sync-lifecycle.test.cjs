const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  SyncLiveRing,
  advanceSyncState,
  deriveSyncPhaseFromHint,
  planBootstrapSyncWork,
  planSteadySyncWork,
  planSyncTick,
  summarizeSyncLifecycle,
  syncLifecycleMode,
} = require("../dist");

function member(streamKey, threadId) {
  return {
    installation_id: "feishu-1",
    stream_key: streamKey,
    thread_id: threadId,
    generation: 1,
    discovered_at: "2026-08-31T00:00:00.000Z",
    last_seen_at: "2026-08-31T00:00:00.000Z",
  };
}

function state(streamKey, phase, idleUntil) {
  return {
    installation_id: "feishu-1",
    stream_key: streamKey,
    phase,
    media_pending: false,
    generation: 1,
    updated_at: "2026-08-31T00:00:00.000Z",
    live_cursor: "{}",
    history_cursor: "{}",
    ...(idleUntil ? { idle_until: idleUntil } : {}),
  };
}

describe("sync lifecycle", () => {
  it("classifies bootstrap vs steady phases", () => {
    assert.equal(syncLifecycleMode("unseeded"), "bootstrap");
    assert.equal(syncLifecycleMode("history"), "bootstrap");
    assert.equal(syncLifecycleMode("live"), "steady");
    assert.equal(syncLifecycleMode("steady"), "steady");
  });

  it("defers context work until sync completes", () => {
    const {
      isSyncComplete,
      shouldDeferWorkForSync,
      syncPhaseForThread,
    } = require("../dist");
    assert.equal(isSyncComplete("live"), true);
    assert.equal(isSyncComplete("history"), false);
    assert.equal(
      shouldDeferWorkForSync({ requires_full_sync: true, phase: "history" }),
      true,
    );
    assert.equal(
      shouldDeferWorkForSync({ requires_full_sync: true, phase: "live" }),
      false,
    );
    assert.equal(
      shouldDeferWorkForSync({ requires_full_sync: false, phase: "history" }),
      false,
    );
    const phase = syncPhaseForThread(
      "feishu:1",
      [member("chat:1", "feishu:1")],
      new Map([["chat:1", state("chat:1", "history")]]),
    );
    assert.equal(phase, "history");
  });

  it("summarizes bootstrap and steady counts", () => {
    const members = [
      member("chat:1", "feishu:1"),
      member("chat:2", "feishu:2"),
      member("chat:3", "feishu:3"),
    ];
    const states = new Map([
      ["chat:1", state("chat:1", "history")],
      ["chat:2", state("chat:2", "unseeded")],
      ["chat:3", state("chat:3", "steady", "2026-08-31T00:05:00.000Z")],
    ]);
    const progress = summarizeSyncLifecycle(members, states);
    assert.equal(progress.discovered, 3);
    assert.equal(progress.bootstrap_pending, 2);
    assert.equal(progress.steady, 1);
    assert.equal(progress.history_backfill, 1);
    assert.equal(progress.unseeded, 1);
  });

  it("derives phase from connector poll hints without cursor parsing", () => {
    assert.equal(
      deriveSyncPhaseFromHint({ live_seeded: false, history_pending: false }),
      "unseeded",
    );
    assert.equal(
      deriveSyncPhaseFromHint({ live_seeded: true, history_pending: true }),
      "history",
    );
    assert.equal(
      deriveSyncPhaseFromHint(
        { live_seeded: true, history_pending: false },
        "2026-08-31T00:05:00.000Z",
        "2026-08-31T00:00:00.000Z",
      ),
      "steady",
    );
    assert.equal(
      deriveSyncPhaseFromHint({ live_seeded: true, history_pending: false }),
      "live",
    );
  });

  it("prefers poll hints when remembering sync outcomes", () => {
    const next = advanceSyncState(null, {
      installation_id: "feishu-1",
      stream_key: "chat:1",
      older: true,
      media: false,
      accepted_count: 1,
      quarantined_count: 0,
      has_more: false,
      poll_hint: { live_seeded: true, history_pending: false },
      idle_ms: 15_000,
      now: "2026-08-31T00:00:00.000Z",
    });
    assert.equal(next.phase, "steady");
  });
});

describe("split sync planner", () => {
  it("schedules history only in bootstrap and never in steady", () => {
    const members = [
      member("chat:boot", "feishu:boot"),
      member("chat:live", "feishu:live"),
    ];
    const states = new Map([
      ["chat:boot", state("chat:boot", "history")],
      ["chat:live", state("chat:live", "live")],
    ]);
    const bootstrap = planBootstrapSyncWork({
      members,
      states,
      catalogIncomplete: false,
      now: "2026-08-31T00:00:00.000Z",
    });
    const steady = planSteadySyncWork({
      members,
      states,
      catalogIncomplete: false,
      now: "2026-08-31T00:00:00.000Z",
    });
    assert.ok(bootstrap.some((item) => item.lane === "history"));
    assert.equal(
      steady.some((item) => item.lane === "history"),
      false,
    );
  });

  it("merges bootstrap and steady plans without double-booking streams", () => {
    const members = [
      member("chat:boot", "feishu:boot"),
      member("chat:live", "feishu:live"),
    ];
    const states = new Map([
      ["chat:boot", state("chat:boot", "history")],
      ["chat:live", state("chat:live", "live")],
    ]);
    const plan = planSyncTick({
      members,
      states,
      humanIdle: true,
      catalogIncomplete: false,
      now: "2026-08-31T00:00:00.000Z",
    });
    const keys = plan.all.map((item) => item.stream_key);
    assert.equal(new Set(keys).size, keys.length);
    assert.ok(plan.bootstrap.length > 0);
    assert.ok(plan.steady.length > 0);
  });

  it("preempts the open thread and keeps one leftover history stream while the human is present", () => {
    const members = [
      member("chat:boot", "feishu:boot"),
      member("chat:hist", "feishu:hist"),
      member("chat:other", "feishu:other"),
      member("chat:live", "feishu:live"),
    ];
    const states = new Map([
      ["chat:boot", state("chat:boot", "history")],
      ["chat:hist", state("chat:hist", "history")],
      ["chat:other", state("chat:other", "unseeded")],
      ["chat:live", state("chat:live", "live")],
    ]);
    const plan = planSyncTick({
      members,
      states,
      preferredThreadId: "feishu:boot",
      humanIdle: false,
      catalogIncomplete: true,
      now: "2026-08-31T00:00:00.000Z",
    });
    assert.deepEqual(
      plan.bootstrap.map(
        (item) => `${item.lane}:${item.stream_key}:${item.older ? "older" : "head"}`,
      ),
      ["interactive:chat:boot:head", "history:chat:hist:older"],
    );
    assert.equal(
      plan.all.some(
        (item) =>
          (item.lane === "history" || item.older === true) &&
          item.thread_id === "feishu:boot",
      ),
      false,
    );
    assert.equal(
      plan.steady.filter((item) => item.lane === "live").length,
      1,
    );
    assert.equal(
      plan.steady.some((item) => item.lane === "catalog"),
      false,
    );
  });

  it("does not cap steady live fan-out while the human is present", () => {
    const members = [
      member("chat:1", "feishu:1"),
      member("chat:2", "feishu:2"),
      member("chat:3", "feishu:3"),
      member("chat:4", "feishu:4"),
    ];
    const states = new Map([
      ["chat:1", state("chat:1", "live")],
      ["chat:2", state("chat:2", "live")],
      ["chat:3", state("chat:3", "live")],
      ["chat:4", state("chat:4", "live")],
    ]);
    const plan = planSyncTick({
      members,
      states,
      humanIdle: false,
      catalogIncomplete: false,
      now: "2026-08-31T00:00:00.000Z",
      steadyLimits: { live: 4 },
    });
    assert.equal(plan.steady.filter((item) => item.lane === "live").length, 4);
  });

  it("rotates steady live polls through a ring", () => {
    const members = [
      member("chat:1", "feishu:1"),
      member("chat:2", "feishu:2"),
      member("chat:3", "feishu:3"),
    ];
    const states = new Map([
      ["chat:1", state("chat:1", "live")],
      ["chat:2", state("chat:2", "live")],
      ["chat:3", state("chat:3", "live")],
    ]);
    const ring = new SyncLiveRing();
    const first = ring.nextDue(members, states, "2026-08-31T00:00:00.000Z", 1);
    const second = ring.nextDue(members, states, "2026-08-31T00:00:00.000Z", 1);
    assert.notEqual(first[0]?.stream_key, second[0]?.stream_key);
  });

  it("prefers nudged and overdue steady streams", () => {
    const members = [
      member("chat:1", "feishu:1"),
      member("chat:2", "feishu:2"),
      member("chat:3", "feishu:3"),
    ];
    const states = new Map([
      [
        "chat:1",
        {
          ...state("chat:1", "steady"),
          idle_until: "2026-08-31T00:00:10.000Z",
        },
      ],
      [
        "chat:2",
        {
          ...state("chat:2", "steady"),
          idle_until: "2026-08-31T00:00:30.000Z",
        },
      ],
      [
        "chat:3",
        {
          ...state("chat:3", "steady"),
          idle_until: "2026-08-31T00:00:05.000Z",
        },
      ],
    ]);
    const ring = new SyncLiveRing();
    ring.nudge("chat:2");
    const picked = ring.nextDue(
      members,
      states,
      "2026-08-31T00:00:20.000Z",
      2,
    );
    assert.deepEqual(
      picked.map((item) => item.stream_key),
      ["chat:2", "chat:3"],
    );
  });
});
