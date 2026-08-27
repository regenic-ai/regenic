const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  lastCatchUpKey,
  lastHistoryKey,
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
