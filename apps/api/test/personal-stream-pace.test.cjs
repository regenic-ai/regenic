const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  lastCatchUpKey,
  rotateFromKey,
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
