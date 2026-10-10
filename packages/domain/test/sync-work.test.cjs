const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryConnectorRuntimeStore } = require("../dist");

async function createStore() {
  const store = new MemoryConnectorRuntimeStore();
  await store.createInstallation({
    id: "install-1",
    org_id: "org-1",
    connector_type: "fake",
    status: "enabled",
    config: {},
    created_at: "2026-09-21T00:00:00.000Z",
  });
  return store;
}

describe("durable sync work", () => {
  it("claims by priority and completes a run", async () => {
    const store = await createStore();
    await store.createSyncRun({
      id: "run-1",
      org_id: "org-1",
      installation_id: "install-1",
      mode: "quick_start",
      now: "2026-09-21T00:00:00.000Z",
    });
    await store.enqueueSyncWork({
      id: "history-1",
      run_id: "run-1",
      installation_id: "install-1",
      stream_key: "s-history",
      lane: "history",
      next_due_at: "2026-09-21T00:00:00.000Z",
      generation: 1,
      now: "2026-09-21T00:00:00.000Z",
    });
    await store.enqueueSyncWork({
      id: "live-1",
      run_id: "run-1",
      installation_id: "install-1",
      stream_key: "s-live",
      lane: "live",
      next_due_at: "2026-09-21T00:00:00.000Z",
      generation: 1,
      now: "2026-09-21T00:00:00.000Z",
    });

    const claimed = await store.claimSyncWork({
      owner: "worker-a",
      now: "2026-09-21T00:00:01.000Z",
      lease_ms: 30_000,
      limit: 2,
    });
    assert.deepEqual(
      claimed.map((work) => work.lane),
      ["live", "history"],
    );
    for (const work of claimed) {
      await store.settleSyncWork({
        id: work.id,
        owner: "worker-a",
        now: "2026-09-21T00:00:02.000Z",
        outcome: "succeeded",
        accepted_count: 2,
      });
    }

    const run = await store.getSyncRun("run-1", "org-1");
    assert.equal(run.status, "succeeded");
    assert.equal(run.total_work, 2);
    assert.equal(run.completed_work, 2);
    assert.equal(run.accepted_count, 4);
  });

  it("recovers expired work and respects pause/cancel", async () => {
    const store = await createStore();
    await store.createSyncRun({
      id: "run-1",
      org_id: "org-1",
      installation_id: "install-1",
      mode: "archive",
      now: "2026-09-21T00:00:00.000Z",
    });
    await store.enqueueSyncWork({
      id: "work-1",
      run_id: "run-1",
      installation_id: "install-1",
      stream_key: "s1",
      lane: "history",
      next_due_at: "2026-09-21T00:00:00.000Z",
      generation: 1,
      now: "2026-09-21T00:00:00.000Z",
    });
    await store.claimSyncWork({
      owner: "worker-a",
      now: "2026-09-21T00:00:01.000Z",
      lease_ms: 1_000,
      limit: 1,
    });
    await store.commandSyncRun({
      id: "run-1",
      org_id: "org-1",
      command: "pause",
      now: "2026-09-21T00:00:02.000Z",
    });
    assert.deepEqual(
      await store.claimSyncWork({
        owner: "worker-b",
        now: "2026-09-21T00:00:03.000Z",
        lease_ms: 1_000,
        limit: 1,
      }),
      [],
    );
    await store.commandSyncRun({
      id: "run-1",
      org_id: "org-1",
      command: "resume",
      now: "2026-09-21T00:00:04.000Z",
    });
    const reclaimed = await store.claimSyncWork({
      owner: "worker-b",
      now: "2026-09-21T00:00:04.000Z",
      lease_ms: 1_000,
      limit: 1,
    });
    assert.equal(reclaimed.length, 1);
    assert.equal(reclaimed[0].attempts, 2);

    await store.commandSyncRun({
      id: "run-1",
      org_id: "org-1",
      command: "cancel",
      now: "2026-09-21T00:00:05.000Z",
    });
    assert.equal(
      (await store.getSyncRun("run-1", "org-1")).status,
      "cancelled",
    );
  });

  it("claims unassigned background work without taking a user run", async () => {
    const store = await createStore();
    await store.createSyncRun({
      id: "run-1",
      org_id: "org-1",
      installation_id: "install-1",
      mode: "quick_start",
      now: "2026-09-21T00:00:00.000Z",
    });
    await store.enqueueSyncWork({
      id: "run-work",
      run_id: "run-1",
      installation_id: "install-1",
      stream_key: "s-run",
      lane: "live",
      next_due_at: "2026-09-21T00:00:00.000Z",
      generation: 1,
      now: "2026-09-21T00:00:00.000Z",
    });
    await store.enqueueSyncWork({
      id: "due-work",
      installation_id: "install-1",
      stream_key: "s-due",
      lane: "live",
      next_due_at: "2026-09-21T00:00:00.000Z",
      generation: 1,
      now: "2026-09-21T00:00:00.000Z",
    });
    const claimed = await store.claimSyncWork({
      owner: "planner",
      now: "2026-09-21T00:00:01.000Z",
      lease_ms: 1_000,
      limit: 8,
      unassigned: true,
    });
    assert.deepEqual(
      claimed.map((work) => work.id),
      ["due-work"],
    );
  });

  it("finds unassigned work and wakes a pending stream without a catalog scan", async () => {
    const store = await createStore();
    await store.enqueueSyncWork({
      id: "due-work",
      installation_id: "install-1",
      stream_key: "channel:C123",
      lane: "live",
      next_due_at: "2026-09-21T00:05:00.000Z",
      generation: 1,
      now: "2026-09-21T00:00:00.000Z",
    });
    assert.equal(
      await store.hasUnassignedSyncWork({
        installation_id: "install-1",
        lanes: ["live"],
      }),
      true,
    );
    assert.equal(
      await store.hasUnassignedSyncWork({
        installation_id: "install-1",
        lanes: ["history"],
      }),
      false,
    );
    assert.deepEqual(await store.listUnassignedSyncWorkIdentities({
      installation_id: "install-1",
    }), [
      { stream_key: "channel:C123", lane: "live", generation: 1 },
    ]);
    const woken = await store.wakeUnassignedSyncWork({
      installation_id: "install-1",
      stream_keys: ["channel:C123", "chat:C123"],
      now: "2026-09-21T00:00:02.000Z",
    });
    assert.equal(woken, 1);
    const claimed = await store.claimSyncWork({
      owner: "planner",
      now: "2026-09-21T00:00:02.000Z",
      lease_ms: 1_000,
      limit: 8,
      unassigned: true,
    });
    assert.equal(claimed.length, 1);
    assert.equal(claimed[0].next_due_at, "2026-09-21T00:00:02.000Z");
  });

  it("batches enqueue upserts without duplicating identity rows", async () => {
    const store = await createStore();
    const now = "2026-09-21T00:00:00.000Z";
    const later = "2026-09-21T00:05:00.000Z";
    const items = [
      {
        id: "due-a",
        installation_id: "install-1",
        stream_key: "s-a",
        lane: "live",
        next_due_at: later,
        generation: 1,
        now,
      },
      {
        id: "due-b",
        installation_id: "install-1",
        stream_key: "s-b",
        lane: "live",
        next_due_at: later,
        generation: 1,
        now,
      },
    ];
    assert.equal(await store.enqueueSyncWorkMany(items), 2);
    assert.equal(
      await store.enqueueSyncWorkMany(
        items.map((item) => ({
          ...item,
          id: `${item.id}-again`,
          next_due_at: now,
        })),
      ),
      2,
    );
    const identities = await store.listUnassignedSyncWorkIdentities({
      installation_id: "install-1",
    });
    assert.equal(identities.length, 2);
    const claimed = await store.claimSyncWork({
      owner: "planner",
      now: "2026-09-21T00:00:01.000Z",
      lease_ms: 1_000,
      limit: 8,
      unassigned: true,
    });
    assert.equal(claimed.length, 2);
    assert.ok(claimed.every((work) => work.next_due_at === now));
  });

  it("claims 32 highest-priority due rows from 10_000 pending work", async () => {
    const store = await createStore();
    const now = "2026-09-21T00:00:00.000Z";
    const started = Date.now();
    const enqueued = await store.enqueueSyncWorkMany(
      Array.from({ length: 10_000 }, (_, index) => ({
        id: `due-${index}`,
        installation_id: "install-1",
        stream_key: `s${index}`,
        lane: index === 0 ? "interactive" : index < 100 ? "live" : "history",
        next_due_at: index < 9_000 ? now : "2026-09-21T01:00:00.000Z",
        generation: 1,
        now,
      })),
    );
    const enqueueMs = Date.now() - started;
    assert.equal(enqueued, 10_000);
    assert.ok(
      enqueueMs < 1_000,
      `enqueueSyncWorkMany(10k) took ${enqueueMs}ms`,
    );
    const claimStarted = Date.now();
    const claimed = await store.claimSyncWork({
      owner: "planner",
      now: "2026-09-21T00:00:01.000Z",
      lease_ms: 30_000,
      limit: 32,
      unassigned: true,
    });
    const elapsed = Date.now() - claimStarted;
    assert.equal(claimed.length, 32);
    assert.equal(claimed[0].id, "due-0");
    assert.equal(claimed[0].lane, "interactive");
    assert.ok(claimed.slice(1).every((work) => work.lane === "live"));
    assert.ok(
      claimed.every((work) => work.next_due_at <= "2026-09-21T00:00:01.000Z"),
    );
    assert.ok(elapsed < 1_000, `claimSyncWork(10k) took ${elapsed}ms`);
  });

  it("writes owed lanes with the phase and leaves a pending due time", async () => {
    const store = await createStore();
    const first = "2026-09-21T00:00:00.000Z";
    await store.putSyncState({
      installation_id: "install-1",
      stream_key: "chat:1",
      phase: "history",
      media_pending: true,
      generation: 1,
      live_cursor: "{\"page\":1}",
      history_cursor: "{\"token\":\"abc\"}",
      updated_at: first,
    });
    assert.deepEqual(await store.listSyncWorkGaps("install-1"), []);
    const history = await store.claimSyncWork({
      owner: "history",
      now: first,
      lease_ms: 60_000,
      limit: 1,
      lanes: ["history"],
      unassigned: true,
    });
    assert.equal(history.length, 1);
    const later = "2026-09-21T00:00:10.000Z";
    await store.putSyncState({
      installation_id: "install-1",
      stream_key: "chat:1",
      phase: "history",
      media_pending: true,
      generation: 1,
      updated_at: later,
    });
    const live = await store.claimSyncWork({
      owner: "live",
      now: later,
      lease_ms: 60_000,
      limit: 4,
      lanes: ["live"],
      unassigned: true,
    });
    assert.equal(live.length, 1);
    assert.equal(live[0].next_due_at, first);
    await store.settleSyncWork({
      id: live[0].id,
      owner: "live",
      now: later,
      outcome: "succeeded",
    });
    const gaps = await store.listSyncWorkGaps("install-1");
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].missing_lane, "live");
    assert.equal("live_cursor" in gaps[0], false);
    assert.equal("history_cursor" in gaps[0], false);
    await store.putSyncState({
      installation_id: "install-1",
      stream_key: "chat:1",
      phase: "steady",
      media_pending: false,
      generation: 1,
      updated_at: "2026-09-21T00:00:20.000Z",
    });
    const identities = await store.listUnassignedSyncWorkIdentities({
      installation_id: "install-1",
    });
    assert.deepEqual(
      identities.map((item) => item.lane).sort(),
      ["history", "live"],
    );
  });
});
