const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  lastCatchUpKey,
  lastHistoryKey,
  prependUnseenStreams,
  streamCursorUnseeded,
  rotateFromKey,
  selectHumanPacedStreams,
  selectStreamsForTick,
  shouldKeepCatchingUp,
} = require("../dist/personal-stream-pace");

function planned(key, catchingUp, threadId) {
  return { key, catchingUp, threadId, item: key };
}

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
  it("treats a missing cursor or a Feishu cursor before recent seed as unseen", () => {
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
});
