const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  MemorySyncStore,
  SyncEngine,
  SyncSlotPool,
  applySyncCatalogMembers,
  currentSyncLane,
  deriveSyncPhase,
  emptySyncCatalog,
  lastHistoryWorkKey,
  planSyncWork,
  publishedSyncProgress,
  runInSyncLane,
  streamCursorUnseeded,
  summarizeSyncProgress,
  aggregateSyncProgress,
  syncLaneLimits,
  syncStateFromCursor,
} = require("../dist");

function member(streamKey, threadId, generation = 1) {
  return {
    installation_id: "feishu-1",
    stream_key: streamKey,
    thread_id: threadId,
    generation,
    discovered_at: "2026-08-31T00:00:00.000Z",
    last_seen_at: "2026-08-31T00:00:00.000Z",
  };
}

function stateMap(entries) {
  return new Map(
    entries.map(([key, phase]) => [
      key,
      {
        installation_id: "feishu-1",
        stream_key: key,
        phase,
        media_pending: false,
        generation: 1,
        updated_at: "2026-08-31T00:00:00.000Z",
        live_cursor: phase === "unseeded" ? undefined : JSON.stringify({ recent_seeded: true }),
        history_cursor:
          phase === "history"
            ? JSON.stringify({ recent_seeded: true, history_token: "h1" })
            : JSON.stringify({ recent_seeded: true }),
      },
    ]),
  );
}

describe("sync catalog apply", () => {
  it("does not prune the previous generation until a census completes", () => {
    const first = applySyncCatalogMembers(emptySyncCatalog("feishu-1"), {
      installation_id: "feishu-1",
      members: [{ stream_key: "chat:old", thread_id: "feishu:old" }],
      now: "2026-08-31T00:00:00.000Z",
      next_cursor: "p2",
      complete: false,
    });
    assert.equal(first.members.length, 1);
    assert.equal(first.catalog.complete, false);
    assert.equal(first.catalog.generation, 1);

    const second = applySyncCatalogMembers(first, {
      installation_id: "feishu-1",
      members: [{ stream_key: "chat:new", thread_id: "feishu:new" }],
      now: "2026-08-31T00:01:00.000Z",
      complete: true,
    });
    assert.deepEqual(
      second.members.map((item) => item.stream_key).sort(),
      ["chat:new", "chat:old"],
    );

    const recensus = applySyncCatalogMembers(second, {
      installation_id: "feishu-1",
      members: [{ stream_key: "chat:hot", thread_id: "feishu:hot" }],
      now: "2026-08-31T00:06:00.000Z",
      next_cursor: "p2",
      complete: false,
    });
    assert.equal(recensus.catalog.generation, 2);
    assert.equal(recensus.members.length, 3);

    const done = applySyncCatalogMembers(recensus, {
      installation_id: "feishu-1",
      members: [{ stream_key: "chat:hot", thread_id: "feishu:hot" }],
      now: "2026-08-31T00:07:00.000Z",
      complete: true,
    });
    assert.deepEqual(
      done.members.map((item) => item.stream_key),
      ["chat:hot"],
    );
    assert.equal(done.catalog.complete, true);
  });
});

describe("sync phase", () => {
  it("treats a missing or unseeded Feishu cursor as unseeded", () => {
    assert.equal(streamCursorUnseeded(undefined), true);
    assert.equal(streamCursorUnseeded(""), true);
    assert.equal(streamCursorUnseeded("{}"), false);
    assert.equal(streamCursorUnseeded(JSON.stringify({ recent_seeded: true })), false);
    assert.equal(
      deriveSyncPhase({
        live_cursor: JSON.stringify({ recent_seeded: true, history_token: "h" }),
      }),
      "history",
    );
    assert.equal(
      syncStateFromCursor({
        installation_id: "feishu-1",
        stream_key: "chat:1",
        now: "2026-08-31T00:00:00.000Z",
      }).phase,
      "unseeded",
    );
  });
});

describe("sync scheduler", () => {
  it("keeps catalog moving while the human is present and never history-polls the open thread", () => {
    const selected = planSyncWork({
      members: [
        member("chat:open", "feishu:open"),
        member("chat:a", "feishu:a"),
        member("chat:b", "feishu:b"),
      ],
      states: stateMap([
        ["chat:open", "history"],
        ["chat:a", "history"],
        ["chat:b", "live"],
      ]),
      preferredThreadId: "feishu:open",
      humanIdle: false,
      catalogIncomplete: true,
      now: "2026-08-31T00:00:00.000Z",
    });
    assert.deepEqual(
      selected.map((item) => `${item.lane}:${item.stream_key}:${item.older ? "older" : "live"}`),
      ["interactive:chat:open:live", "live:chat:a:live", "live:chat:b:live", "catalog:__catalog__:live"],
    );
    assert.equal(syncLaneLimits(false, true).history, 0);
  });

  it("backfills other threads when idle and rotates history", () => {
    const selected = planSyncWork({
      members: [
        member("chat:open", "feishu:open"),
        member("chat:a", "feishu:a"),
        member("chat:b", "feishu:b"),
      ],
      states: stateMap([
        ["chat:open", "live"],
        ["chat:a", "history"],
        ["chat:b", "history"],
      ]),
      preferredThreadId: "feishu:open",
      humanIdle: true,
      catalogIncomplete: false,
      rotateFrom: "chat:a",
      now: "2026-08-31T00:00:00.000Z",
    });
    assert.deepEqual(
      selected.map((item) => `${item.lane}:${item.stream_key}:${item.older ? "older" : "live"}`),
      ["interactive:chat:open:live", "live:chat:a:live", "history:chat:b:older"],
    );
    assert.equal(lastHistoryWorkKey(selected), "chat:b");
  });

  it("seeds unseen streams on the live lane before history", () => {
    const selected = planSyncWork({
      members: [member("chat:new", "feishu:new"), member("chat:old", "feishu:old")],
      states: stateMap([
        ["chat:new", "unseeded"],
        ["chat:old", "history"],
      ]),
      humanIdle: true,
      catalogIncomplete: false,
      now: "2026-08-31T00:00:00.000Z",
    });
    assert.equal(selected[0].lane, "live");
    assert.equal(selected[0].stream_key, "chat:new");
    assert.equal(selected[0].older, false);
    assert.equal(selected[0].media, false);
  });

  it("schedules media on its own lane after text pages", () => {
    const states = stateMap([
      ["chat:open", "live"],
      ["chat:other", "live"],
      ["chat:pic", "live"],
    ]);
    states.get("chat:pic").media_pending = true;
    const selected = planSyncWork({
      members: [
        member("chat:open", "feishu:open"),
        member("chat:other", "feishu:other"),
        member("chat:pic", "feishu:pic"),
      ],
      states,
      preferredThreadId: "feishu:open",
      humanIdle: true,
      catalogIncomplete: false,
      now: "2026-08-31T00:00:00.000Z",
    });
    assert.deepEqual(
      selected.map((item) => `${item.lane}:${item.stream_key}:${item.media ? "media" : "text"}`),
      ["interactive:chat:open:text", "live:chat:other:text", "media:chat:pic:media"],
    );
  });

  it("drains media for the open thread after its text page", () => {
    const states = stateMap([
      ["chat:open", "live"],
      ["chat:other", "live"],
    ]);
    states.get("chat:open").media_pending = true;
    states.get("chat:other").media_pending = true;
    const selected = planSyncWork({
      members: [
        member("chat:open", "feishu:open"),
        member("chat:other", "feishu:other"),
      ],
      states,
      preferredThreadId: "feishu:open",
      humanIdle: false,
      catalogIncomplete: false,
      now: "2026-08-31T00:00:00.000Z",
      limits: { media: 2 },
    });
    assert.deepEqual(
      selected.map((item) => `${item.lane}:${item.stream_key}:${item.media ? "media" : "text"}`),
      [
        "interactive:chat:open:text",
        "live:chat:other:text",
        "media:chat:open:media",
        "media:chat:other:media",
      ],
    );
  });
});

describe("sync slot pool", () => {
  it("reserves an interactive slot that backfill cannot take", async () => {
    const pool = new SyncSlotPool({ total: 2, reserved: { interactive: 1 } });
    assert.equal(pool.tryAcquire("live"), true);
    assert.equal(pool.tryAcquire("history"), false);
    assert.equal(pool.tryAcquire("interactive"), true);
    pool.release("interactive");
    assert.equal(pool.tryAcquire("history"), false);
    pool.release("live");
    assert.equal(pool.tryAcquire("history"), true);
    pool.reset();
  });

  it("propagates the current lane through async context", async () => {
    assert.equal(currentSyncLane(), "live");
    await runInSyncLane("interactive", async () => {
      assert.equal(currentSyncLane(), "interactive");
    });
    assert.equal(currentSyncLane(), "live");
  });
});

describe("sync engine", () => {
  it("pages a directory without dropping known members mid-census", async () => {
    const store = new MemorySyncStore();
    const engine = new SyncEngine(store, {
      now: () => "2026-08-31T00:00:00.000Z",
    });
    const pages = [
      {
        members: [{ stream_key: "chat:1", thread_id: "feishu:1" }],
        next_cursor: "p2",
        complete: false,
      },
      {
        members: [{ stream_key: "chat:2", thread_id: "feishu:2" }],
        complete: true,
      },
    ];
    let index = 0;
    const source = {
      async listDirectory() {
        return pages[index++] ?? pages[pages.length - 1];
      },
    };
    const first = await engine.refreshCatalog({
      installation_id: "feishu-1",
      source,
      pages: 1,
    });
    assert.equal(first.members.length, 1);
    assert.equal(first.catalog.complete, false);
    const second = await engine.refreshCatalog({
      installation_id: "feishu-1",
      source,
      pages: 1,
    });
    assert.deepEqual(
      second.members.map((item) => item.stream_key),
      ["chat:1", "chat:2"],
    );
    assert.equal(second.catalog.complete, true);

    const planned = await engine.plan({
      installation_id: "feishu-1",
      humanIdle: false,
      preferredThreadId: "feishu:2",
    });
    assert.equal(
      planned.some((item) => item.lane === "catalog"),
      false,
    );
    assert.equal(planned[0].lane, "interactive");
    assert.equal(planned[0].stream_key, "chat:2");
  });
});

describe("sync progress", () => {
  it("counts catalog members and does not treat missing state as seeded", () => {
    const progress = summarizeSyncProgress(
      {
        members: [
          member("chat:1", "feishu:1"),
          member("chat:2", "feishu:2"),
          member("chat:3", "feishu:3"),
        ],
        catalog: {
          installation_id: "feishu-1",
          complete: false,
          generation: 1,
          updated_at: "2026-08-31T00:00:00.000Z",
        },
      },
      [
        {
          installation_id: "feishu-1",
          stream_key: "chat:1",
          phase: "live",
          media_pending: false,
          generation: 1,
          updated_at: "2026-08-31T00:00:00.000Z",
        },
        {
          installation_id: "feishu-1",
          stream_key: "chat:2",
          phase: "history",
          media_pending: true,
          generation: 1,
          updated_at: "2026-08-31T00:00:00.000Z",
        },
      ],
    );
    assert.deepEqual(progress, {
      discovered: 3,
      seeded: 2,
      unseeded: 1,
      backfilling: 1,
      media_pending: 1,
      catalog_complete: false,
    });
  });

  it("hides coverage until a catalog page has been stored", () => {
    assert.equal(
      publishedSyncProgress(emptySyncCatalog("feishu-1"), []),
      null,
    );
  });

  it("aggregates only installs that have started discovering", () => {
    const total = aggregateSyncProgress([
      {
        discovered: 0,
        seeded: 0,
        unseeded: 0,
        backfilling: 0,
        media_pending: 0,
        catalog_complete: false,
      },
      {
        discovered: 10,
        seeded: 8,
        unseeded: 2,
        backfilling: 1,
        media_pending: 0,
        catalog_complete: true,
      },
      {
        discovered: 5,
        seeded: 5,
        unseeded: 0,
        backfilling: 0,
        media_pending: 2,
        catalog_complete: true,
      },
    ]);
    assert.equal(total.discovered, 15);
    assert.equal(total.seeded, 13);
    assert.equal(total.backfilling, 1);
    assert.equal(total.catalog_complete, true);
  });
});
