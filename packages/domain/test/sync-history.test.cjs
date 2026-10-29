const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { readFileSync, readdirSync, statSync } = require("node:fs");
const { join } = require("node:path");
const {
  advanceSyncState,
  cursorKindFromPoll,
  cursorWriteFor,
  historyPolicyFromConfig,
  historySyncClaimLanes,
  messageDuty,
  owedSyncLanes,
  pollCursorValue,
  releaseHistoryPhase,
  sameLaneContinues,
  shouldRunHistoryTick,
  shouldSeedHistoryCursor,
  steadySyncClaimLanes,
  syncOutcomeForPoll,
  syncPageOutcomeFromPollRuns,
  syncWorkEnsurePlan,
} = require("../dist");

describe("history policy", () => {
  it("defaults missing and unknown installs to backfill and ignores sync_mode", () => {
    assert.equal(historyPolicyFromConfig(undefined), "backfill");
    assert.equal(historyPolicyFromConfig(null), "backfill");
    assert.equal(historyPolicyFromConfig({}), "backfill");
    assert.equal(historyPolicyFromConfig({ sync_mode: "context" }), "backfill");
    assert.equal(historyPolicyFromConfig({ history_policy: "nope" }), "backfill");
    assert.equal(
      historyPolicyFromConfig({ history_policy: " Incremental " }),
      "incremental",
    );
    assert.equal(historyPolicyFromConfig({ history_policy: "backfill" }), "backfill");
  });

  it("is not read by connector packages", () => {
    const roots = ["feishu-connector", "dsh-connector", "cursor-connector"].map(
      (name) => join(__dirname, "..", "..", name, "src"),
    );
    const hits = [];
    for (const root of roots) {
      for (const file of sourceFiles(root)) {
        const text = readFileSync(file, "utf8");
        if (text.includes("history_policy") || text.includes("historyPolicyFromConfig")) {
          hits.push(file);
        }
      }
    }
    assert.deepEqual(hits, []);
  });
});

describe("one message duty", () => {
  it("owes only history while backfill is unfinished", () => {
    assert.equal(messageDuty("history", "backfill"), "history");
    assert.deepEqual(
      owedSyncLanes({ phase: "history", media_pending: true }, "backfill"),
      ["history", "media"],
    );
    assert.deepEqual(owedSyncLanes({ phase: "unseeded", media_pending: false }), [
      "live",
    ]);
    assert.deepEqual(owedSyncLanes({ phase: "live", media_pending: false }), ["live"]);
    assert.deepEqual(owedSyncLanes({ phase: "steady", media_pending: false }), [
      "live",
    ]);
  });

  it("never owes history for an incremental install", () => {
    assert.equal(messageDuty("history", "incremental"), "live");
    assert.deepEqual(
      owedSyncLanes({ phase: "history", media_pending: false }, "incremental"),
      ["live"],
    );
    assert.deepEqual(
      syncWorkEnsurePlan({
        state: { phase: "history", media_pending: false },
        existing: [{ lane: "history", status: "pending", run_id: null }],
        policy: "incremental",
      }),
      { enqueue: ["live"], cancel: ["history"] },
    );
  });

  it("cancels a pending live row while history is the duty", () => {
    assert.deepEqual(
      syncWorkEnsurePlan({
        state: { phase: "history", media_pending: false },
        existing: [
          { lane: "live", status: "pending", run_id: null },
          { lane: "interactive", status: "pending", run_id: null },
        ],
      }),
      { enqueue: ["history"], cancel: ["live", "interactive"] },
    );
  });

  it("claims live and history on separate ticks and leaves catalog out", () => {
    assert.deepEqual(steadySyncClaimLanes(), ["interactive", "live", "media"]);
    assert.deepEqual(historySyncClaimLanes(), ["history"]);
    assert.equal(steadySyncClaimLanes().includes("history"), false);
    assert.equal(steadySyncClaimLanes().includes("catalog"), false);
    assert.equal(historySyncClaimLanes().includes("live"), false);
    assert.equal(historySyncClaimLanes().includes("catalog"), false);
  });

  it("does not stop history because a person is reading", () => {
    assert.equal(
      shouldRunHistoryTick({
        backgroundReleased: true,
        deferHistory: false,
        throttleHistory: false,
      }),
      true,
    );
    assert.equal(
      shouldRunHistoryTick({
        backgroundReleased: true,
        deferHistory: true,
        throttleHistory: false,
      }),
      false,
    );
    assert.equal(
      shouldRunHistoryTick({
        backgroundReleased: true,
        deferHistory: false,
        throttleHistory: true,
      }),
      false,
    );
  });
});

describe("cursor commit", () => {
  it("classifies scroll separately from background history", () => {
    assert.equal(cursorKindFromPoll({ before: "2026-10-01T00:00:00.000Z" }), "scroll");
    assert.equal(
      cursorKindFromPoll({ older: true, before: "2026-10-01T00:00:00.000Z" }),
      "scroll",
    );
    assert.equal(cursorKindFromPoll({ older: true }), "history");
    assert.equal(cursorKindFromPoll({}), "live");
  });

  it("writes one cursor per call and does not commit a scroll", () => {
    assert.deepEqual(cursorWriteFor({ kind: "scroll", seedHistory: true }), {
      live: false,
      history: false,
      lease: false,
    });
    assert.deepEqual(cursorWriteFor({ kind: "history", seedHistory: true }), {
      live: false,
      history: true,
      lease: true,
    });
    assert.deepEqual(cursorWriteFor({ kind: "live", seedHistory: false }), {
      live: true,
      history: false,
      lease: true,
    });
    assert.deepEqual(cursorWriteFor({ kind: "live", seedHistory: true }), {
      live: true,
      history: true,
      lease: true,
    });
  });

  it("seeds both cursors only on the first backfill page", () => {
    assert.equal(
      shouldSeedHistoryCursor({
        policy: "backfill",
        phase: "unseeded",
        historyPending: true,
      }),
      true,
    );
    assert.equal(
      shouldSeedHistoryCursor({
        policy: "backfill",
        phase: "history",
        historyCursor: "opaque",
        historyPending: true,
      }),
      false,
    );
    assert.equal(
      shouldSeedHistoryCursor({
        policy: "backfill",
        phase: "live",
        historyPending: true,
      }),
      false,
    );
    assert.equal(
      shouldSeedHistoryCursor({
        policy: "incremental",
        phase: "unseeded",
        historyPending: true,
      }),
      false,
    );
  });

  it("hands the connector the cursor for that call and does not parse it", () => {
    assert.equal(
      pollCursorValue({
        kind: "history",
        liveCursor: "live-blob",
        historyCursor: "history-blob",
        leaseCursor: "lease-blob",
      }),
      "history-blob",
    );
    assert.equal(
      pollCursorValue({
        kind: "live",
        liveCursor: "live-blob",
        historyCursor: "history-blob",
      }),
      "live-blob",
    );
    assert.equal(
      pollCursorValue({
        kind: "scroll",
        liveCursor: "live-blob",
        historyCursor: "history-blob",
      }),
      "live-blob",
    );
    assert.equal(
      pollCursorValue({ kind: "history", leaseCursor: "lease-blob" }),
      "lease-blob",
    );
  });

  it("keeps the other cursor when remembering a page", () => {
    const seeded = syncPageOutcomeFromPollRuns(
      "install-1",
      {
        stream: { stream_key: "chat:1", connector: {} },
        work: { older: false, media: false },
        cursorKind: "live",
        historyPolicy: "backfill",
        phase: "unseeded",
      },
      {
        pages: [
          {
            status: "completed",
            next_cursor: "seed-blob",
            has_more: false,
            poll_hint: { live_seeded: true, history_pending: true },
          },
        ],
      },
      "2026-10-13T00:00:00.000Z",
    );
    assert.equal(seeded.next_live_cursor, "seed-blob");
    assert.equal(seeded.next_history_cursor, "seed-blob");
    assert.equal(seeded.cursor_kind, "live");

    const history = syncPageOutcomeFromPollRuns(
      "install-1",
      {
        stream: { stream_key: "chat:1", connector: {} },
        work: { older: true, media: false },
        cursorKind: "history",
        historyPolicy: "backfill",
        phase: "history",
        historyCursor: "seed-blob",
      },
      {
        pages: [
          {
            status: "completed",
            next_cursor: "older-blob",
            has_more: true,
            poll_hint: { live_seeded: true, history_pending: true },
          },
        ],
      },
      "2026-10-13T00:01:00.000Z",
    );
    assert.equal(history.next_history_cursor, "older-blob");
    assert.equal("next_live_cursor" in history, false);

    const current = {
      installation_id: "install-1",
      stream_key: "chat:1",
      phase: "history",
      live_cursor: "seed-blob",
      history_cursor: "seed-blob",
      media_pending: false,
      generation: 1,
      updated_at: "2026-10-13T00:00:00.000Z",
    };
    const next = advanceSyncState(current, history);
    assert.equal(next.phase, "history");
    assert.equal(next.live_cursor, "seed-blob");
    assert.equal(next.history_cursor, "older-blob");

    const finished = advanceSyncState(next, {
      ...history,
      has_more: false,
      next_history_cursor: "done-blob",
      poll_hint: { live_seeded: true, history_pending: false },
      idle_ms: 15_000,
      now: "2026-10-13T00:02:00.000Z",
    });
    assert.equal(finished.phase, "steady");
    assert.equal(finished.live_cursor, "seed-blob");
    assert.equal(finished.history_cursor, "done-blob");
  });

  it("does not send a caught-up stream back to history", () => {
    const current = {
      installation_id: "install-1",
      stream_key: "chat:1",
      phase: "steady",
      live_cursor: "live-blob",
      history_cursor: "done-blob",
      media_pending: false,
      generation: 1,
      updated_at: "2026-10-13T00:00:00.000Z",
    };
    const next = advanceSyncState(current, {
      installation_id: "install-1",
      stream_key: "chat:1",
      older: false,
      media: false,
      accepted_count: 1,
      quarantined_count: 0,
      has_more: false,
      next_live_cursor: "live-2",
      poll_hint: { live_seeded: true, history_pending: true },
      cursor_kind: "live",
      history_policy: "backfill",
      now: "2026-10-13T00:03:00.000Z",
    });
    assert.equal(next.phase, "steady");
    assert.equal(next.live_cursor, "live-2");
    assert.equal(next.history_cursor, "done-blob");
  });

  it("keeps history phase when the open thread pulls the newest page", () => {
    const current = {
      installation_id: "install-1",
      stream_key: "chat:1",
      phase: "history",
      live_cursor: "live-blob",
      history_cursor: "history-blob",
      media_pending: false,
      generation: 1,
      updated_at: "2026-10-13T00:00:00.000Z",
    };
    const next = advanceSyncState(current, {
      installation_id: "install-1",
      stream_key: "chat:1",
      older: false,
      media: false,
      accepted_count: 1,
      quarantined_count: 0,
      has_more: false,
      next_live_cursor: "live-2",
      poll_hint: { live_seeded: true, history_pending: false },
      cursor_kind: "live",
      history_policy: "backfill",
      now: "2026-10-13T00:03:00.000Z",
    });
    assert.equal(next.phase, "history");
    assert.equal(next.live_cursor, "live-2");
    assert.equal(next.history_cursor, "history-blob");
  });

  it("does not enter history on an incremental install", () => {
    const next = advanceSyncState(null, {
      installation_id: "install-1",
      stream_key: "chat:1",
      older: false,
      media: false,
      accepted_count: 1,
      quarantined_count: 0,
      has_more: false,
      next_live_cursor: "live-blob",
      poll_hint: { live_seeded: true, history_pending: true },
      cursor_kind: "live",
      history_policy: "incremental",
      idle_ms: 15_000,
      now: "2026-10-13T00:00:00.000Z",
    });
    assert.equal(next.phase, "steady");
    assert.equal(next.live_cursor, "live-blob");
    assert.equal(next.history_cursor, undefined);
  });

  it("continues only the lane that owns has_more", () => {
    assert.equal(
      sameLaneContinues({ kind: "live", hasMore: true, historyPending: true }),
      false,
    );
    assert.equal(
      sameLaneContinues({ kind: "history", hasMore: true, historyPending: true }),
      true,
    );
    assert.equal(
      sameLaneContinues({ kind: "scroll", hasMore: true, historyPending: false }),
      false,
    );
    assert.equal(
      sameLaneContinues({ kind: "live", hasMore: true, historyPending: false }),
      true,
    );
    const current = {
      installation_id: "install-1",
      stream_key: "chat:1",
      phase: "live",
      live_cursor: "live-blob",
      history_cursor: "history-blob",
      media_pending: false,
      idle_until: "2026-10-13T00:05:00.000Z",
      generation: 1,
      updated_at: "2026-10-13T00:00:00.000Z",
    };
    const next = advanceSyncState(current, {
      installation_id: "install-1",
      stream_key: "chat:1",
      older: false,
      media: false,
      accepted_count: 1,
      quarantined_count: 0,
      has_more: true,
      next_live_cursor: "live-2",
      poll_hint: { live_seeded: true, history_pending: true },
      cursor_kind: "live",
      history_policy: "backfill",
      idle_ms: 15_000,
      now: "2026-10-13T00:01:00.000Z",
    });
    assert.equal(next.phase, "steady");
    assert.ok(next.idle_until > "2026-10-13T00:01:00.000Z");
    assert.equal(next.history_cursor, "history-blob");
  });

  it("records a poll from the prior state without a caller-chosen cursor column", () => {
    const outcome = syncOutcomeForPoll(
      "install-1",
      {
        stream: { stream_key: "chat:1", connector: {} },
        prior: { phase: "history", history_cursor: "history-blob" },
        policy: "backfill",
        older: true,
      },
      {
        pages: [
          {
            status: "completed",
            next_cursor: "older-blob",
            has_more: true,
            poll_hint: { live_seeded: true, history_pending: true },
          },
        ],
      },
      "2026-10-13T00:00:00.000Z",
    );
    assert.equal(outcome.cursor_kind, "history");
    assert.equal(outcome.next_history_cursor, "older-blob");
    assert.equal("next_live_cursor" in outcome, false);
    assert.equal(outcome.has_more, true);
  });
});

describe("incremental phase release", () => {
  it("leaves history only for backfill", () => {
    const state = { phase: "history", stream_key: "chat:1" };
    assert.equal(releaseHistoryPhase(state, "incremental").phase, "live");
    assert.equal(releaseHistoryPhase(state, "backfill").phase, "history");
    assert.equal(releaseHistoryPhase({ phase: "steady" }, "incremental").phase, "steady");
  });
});

function sourceFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (name.endsWith(".ts")) {
      found.push(path);
    }
  }
  return found;
}
