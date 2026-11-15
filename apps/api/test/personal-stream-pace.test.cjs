const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  capSelectedStreams,
  catalogRefreshPages,
  lastCatchUpKey,
  lastHistoryKey,
  prependUnseenStreams,
  streamCursorUnseeded,
  rotateFromKey,
  selectHumanPacedStreams,
  selectStreamsForTick,
  shouldKeepCatchingUp,
  syncExecutionBudget,
} = require("../dist/personal-stream-pace");
const { defaultSyncSettings } = require("../dist/personal-sync-settings");
const {
  dueWorkBatchTimeoutMs,
  dueWorkClaimLimitFor,
  dueWorkClaimLeaseMs,
  dueWorkConcurrency,
  observeDueWorkPressure,
} = require("../dist/personal-connector-rhythm");
const { DueWorkClaimLimiter, connectorPollTimeoutMs, connectorSyncTimeoutMs } = require("@regenic/domain");

function planned(key, catchingUp, threadId) {
  return { key, catchingUp, threadId, item: key };
}

describe("user sync budgets", () => {
  it("uses configured concurrency in each pulling lane while preserving one-page history and media", () => {
    const settings = {
      ...defaultSyncSettings(),
      live_concurrency: 17,
      history_concurrency: 7,
      media_concurrency: 3,
    };
    for (const humanIdle of [true, false]) {
      for (const lane of ["interactive", "live", "history", "media"]) {
        assert.deepEqual(syncExecutionBudget({ humanIdle, lane, pages: 5, settings }), {
          pages: lane === "history" || lane === "media" ? 1 : 5,
          concurrency: lane === "history" ? 7 : lane === "media" ? 3 : 17,
        });
      }
    }
  });

  it("extends batch deadlines for the configured number of waves", () => {
    const settings = { ...defaultSyncSettings(), live_concurrency: 1 };
    const work = Array.from({ length: 8 }, () => ({ lane: "live" }));
    assert.ok(dueWorkBatchTimeoutMs(work, settings) > dueWorkBatchTimeoutMs(work));
    assert.ok(dueWorkClaimLeaseMs(work.length, settings) > dueWorkBatchTimeoutMs(work, settings));
    assert.ok(
      dueWorkBatchTimeoutMs([...work, { lane: "media" }], settings) >
        dueWorkBatchTimeoutMs(work, settings),
    );
  });

  it("covers the actual serial history waves when pressure reduces configured concurrency", () => {
    const settings = { ...defaultSyncSettings(), live_concurrency: 64, history_concurrency: 64, media_concurrency: 64 };
    const work = Array.from({ length: 16 }, () => ({ lane: "history" }));
    const concurrency = dueWorkConcurrency(settings, "elevated");
    assert.equal(concurrency.history, 1);
    const deadline = dueWorkBatchTimeoutMs(work, settings, concurrency);
    assert.ok(deadline >= 16 * connectorPollTimeoutMs());
    assert.ok(deadline > dueWorkBatchTimeoutMs(work, settings));
    const critical = dueWorkConcurrency(settings, "critical");
    assert.equal(critical.media, 0);
    assert.equal(
      dueWorkBatchTimeoutMs([...work, { lane: "media" }], settings, critical),
      dueWorkBatchTimeoutMs(work, settings, critical),
      "deferred media must not count as a polling wave",
    );
  });

  it("keeps queued installation and catalog claims leased through their worst-case execution", () => {
    const settings = {
      ...defaultSyncSettings(), installation_concurrency: 1,
      live_concurrency: 64, history_concurrency: 64, media_concurrency: 64,
    };
    const limit = 8;
    const lease = dueWorkClaimLeaseMs(limit, settings);
    assert.ok(lease > limit * connectorPollTimeoutMs(), "all installations may poll serially");
    assert.ok(lease > limit * connectorSyncTimeoutMs(), "catalog work can take longer than a stream poll");
    const concurrency = dueWorkConcurrency(settings, "critical");
    const mixed = [
      ...Array.from({ length: 4 }, () => ({ lane: "live" })),
      ...Array.from({ length: 4 }, () => ({ lane: "history" })),
    ];
    assert.ok(lease > dueWorkBatchTimeoutMs(mixed, settings, concurrency));
    assert.equal(dueWorkClaimLeaseMs(limit), Math.max(60000, connectorSyncTimeoutMs() * 2));
  });

  it("keeps adaptive pressure reduction below user-configured batch caps", () => {
    const settings = { ...defaultSyncSettings(), steady_claim_limit: 64, bootstrap_claim_limit: 8 };
    const limiters = {
      steady: new DueWorkClaimLimiter(1, 128, 64),
      bootstrap: new DueWorkClaimLimiter(1, 128, 16),
    };
    assert.equal(dueWorkClaimLimitFor(limiters, "steady", settings), 64);
    assert.equal(dueWorkClaimLimitFor(limiters, "bootstrap", settings), 8);
    observeDueWorkPressure(limiters, "steady", true, settings);
    assert.equal(dueWorkClaimLimitFor(limiters, "steady", settings), 32);
  });
});

describe("selectStreamsForTick", () => {
  it("keeps the open conversation first and rotates the rest", () => {
    const selected = selectStreamsForTick(
      [
        planned("a", true, "feishu:a"),
        planned("b", true, "feishu:b"),
        planned("c", true, "feishu:c"),
        planned("d", true, "feishu:d"),
        planned("live", false, "feishu:live"),
      ],
      { limit: 3, rotateFrom: "a", preferredThreadId: "feishu:c" },
    );
    assert.deepEqual(
      selected.map((item) => item.key),
      ["c", "b", "d", "live"],
    );
    assert.equal(lastCatchUpKey(selected), "d");
  });

  it("rotates from the previous catch-up key", () => {
    assert.deepEqual(
      rotateFromKey([{ key: "a" }, { key: "b" }, { key: "c" }], "b").map(
        (item) => item.key,
      ),
      ["c", "a", "b"],
    );
  });
});

describe("selectHumanPacedStreams", () => {
  it("keeps a few live streams while the human is busy and skips history", () => {
    const selected = selectHumanPacedStreams(
      [
        planned("a", true, "feishu:a"),
        planned("b", true, "feishu:b"),
        planned("c", true, "feishu:c"),
        planned("live", false, "feishu:live"),
      ],
      { liveLimit: 2, historyLimit: 0, preferredThreadId: "feishu:c" },
    );
    assert.deepEqual(
      selected.map((item) => `${item.key}:${item.older ? "older" : "live"}`),
      ["c:live", "a:live"],
    );
  });

  it("adds one rotated history page only when idle", () => {
    const selected = selectHumanPacedStreams(
      [
        planned("a", true, "feishu:a"),
        planned("b", true, "feishu:b"),
        planned("live", false, "feishu:live"),
      ],
      { liveLimit: 1, historyLimit: 1, rotateFrom: "a", preferredThreadId: "feishu:live" },
    );
    assert.deepEqual(
      selected.map((item) => `${item.key}:${item.older ? "older" : "live"}`),
      ["live:live", "b:older"],
    );
    assert.equal(lastHistoryKey(selected), "b");
  });

  it("gives catching-up streams the live slots after the open conversation", () => {
    const selected = selectHumanPacedStreams(
      [
        planned("live1", false, "feishu:live1"),
        planned("live2", false, "feishu:live2"),
        planned("a", true, "feishu:a"),
      ],
      { liveLimit: 2, historyLimit: 0, preferredThreadId: "feishu:live1" },
    );
    assert.deepEqual(
      selected.map((item) => `${item.key}:${item.older ? "older" : "live"}`),
      ["live1:live", "a:live"],
    );
  });

  it("does not poll the same catching-up stream as both live and history", () => {
    const selected = selectHumanPacedStreams(
      [planned("only", true, "feishu:only")],
      { liveLimit: 1, historyLimit: 1, preferredThreadId: "feishu:only" },
    );
    assert.deepEqual(
      selected.map((item) => `${item.key}:${item.older ? "older" : "live"}`),
      ["only:live"],
    );
    const mixed = selectHumanPacedStreams(
      [
        planned("open", true, "feishu:open"),
        planned("other", true, "feishu:other"),
      ],
      { liveLimit: 1, historyLimit: 1, preferredThreadId: "feishu:open" },
    );
    assert.deepEqual(
      mixed.map((item) => `${item.key}:${item.older ? "older" : "live"}`),
      ["open:live", "other:older"],
    );
  });

  it("never backfills history on the open conversation", () => {
    const selected = selectHumanPacedStreams(
      [
        planned("open", true, "feishu:open"),
        planned("other", true, "feishu:other"),
      ],
      { liveLimit: 0, historyLimit: 1, preferredThreadId: "feishu:open" },
    );
    assert.deepEqual(
      selected.map((item) => `${item.key}:${item.older ? "older" : "live"}`),
      ["other:older"],
    );
  });
});

describe("streamCursorUnseeded", () => {
  it("treats only missing/blank cursors as unseen", () => {
    assert.equal(streamCursorUnseeded(undefined), true);
    assert.equal(streamCursorUnseeded(""), true);
    assert.equal(streamCursorUnseeded("{}"), false);
    assert.equal(streamCursorUnseeded(JSON.stringify({ recent_seeded: true })), false);
    assert.equal(streamCursorUnseeded("plain-dsh-cursor"), false);
  });
});

describe("prependUnseenStreams", () => {
  it("seeds unseen streams before the paced live set", () => {
    assert.deepEqual(
      prependUnseenStreams(
        [{ key: "a" }, { key: "b" }, { key: "c" }, { key: "d" }],
        [{ key: "open" }, { key: "a" }],
      ).map((item) => item.key),
      ["a", "b", "c", "d", "open"],
    );
  });
});

describe("shouldKeepCatchingUp", () => {
  it("keeps paging when the source still has more, even if this page was all duplicates", () => {
    assert.equal(
      shouldKeepCatchingUp({
        pages: [{ status: "completed", has_more: true }],
        pagesBudget: 1,
        acceptedCount: 0,
        quarantinedCount: 0,
      }),
      true,
    );
  });

  it("keeps paging after a transport drop", () => {
    assert.equal(
      shouldKeepCatchingUp({
        pages: [],
        pagesBudget: 5,
        acceptedCount: 0,
        quarantinedCount: 0,
        error: new Error("lark-cli timed out after 60000ms"),
      }),
      true,
    );
  });

  it("stops once a short page lands without has_more", () => {
    assert.equal(
      shouldKeepCatchingUp({
        pages: [{ status: "completed", has_more: false }],
        pagesBudget: 5,
        acceptedCount: 12,
        quarantinedCount: 0,
      }),
      false,
    );
  });

  it("stops when a full budget page explicitly reports no more", () => {
    assert.equal(
      shouldKeepCatchingUp({
        pages: [{ status: "completed", has_more: false }],
        pagesBudget: 1,
        acceptedCount: 20,
        quarantinedCount: 0,
      }),
      false,
    );
  });

  it("keeps going when has_more is omitted and the budget filled", () => {
    assert.equal(
      shouldKeepCatchingUp({
        pages: [{ status: "completed" }],
        pagesBudget: 1,
        acceptedCount: 20,
        quarantinedCount: 0,
      }),
      true,
    );
  });
});

describe("syncExecutionBudget", () => {
  it("uses catch_up_pages and higher concurrency only when idle", () => {
    assert.deepEqual(
      syncExecutionBudget({
        humanIdle: true,
        capCatchUp: true,
        lane: "history",
        pages: 1,
        catchUpPages: 5,
      }),
      { pages: 1, concurrency: 4 },
    );
    assert.deepEqual(
      syncExecutionBudget({
        humanIdle: false,
        capCatchUp: true,
        lane: "history",
        pages: 1,
        catchUpPages: 5,
      }),
      { pages: 1, concurrency: 4 },
    );
    assert.deepEqual(
      syncExecutionBudget({
        humanIdle: false,
        capCatchUp: true,
        lane: "live",
        pages: 1,
      }),
      { pages: 1, concurrency: 8 },
    );
  });

  it("keeps media on a small dedicated concurrency budget", () => {
    assert.deepEqual(
      syncExecutionBudget({
        humanIdle: true,
        lane: "media",
        pages: 3,
      }),
      { pages: 1, concurrency: 1 },
    );
    assert.deepEqual(
      syncExecutionBudget({
        humanIdle: false,
        capCatchUp: true,
        lane: "media",
        pages: 3,
      }),
      { pages: 1, concurrency: 1 },
    );
  });
});

describe("catalogRefreshPages", () => {
  it("only pages the directory on discover or the dedicated catalog tick", () => {
    assert.equal(catalogRefreshPages({ humanIdle: false }), 0);
    assert.equal(catalogRefreshPages({ humanIdle: true }), 0);
    assert.equal(catalogRefreshPages({ discover: true, humanIdle: false }), 1);
    assert.equal(catalogRefreshPages({ catalogTick: true }), 1);
  });
});

describe("capSelectedStreams", () => {
  it("keeps one history stream and a small live set", () => {
    const selected = capSelectedStreams(
      [
        { key: "live-a", lane: "live" },
        { key: "live-b", lane: "live" },
        { key: "live-c", lane: "live" },
        { key: "hist-a", lane: "history", older: true },
        { key: "hist-b", lane: "history", older: true },
        { key: "media-a", media: true },
      ],
      { liveLimit: 2, historyLimit: 1, mediaLimit: 0 },
    );
    assert.deepEqual(
      selected.map((item) => item.key),
      ["live-a", "live-b", "hist-a"],
    );
  });
});
