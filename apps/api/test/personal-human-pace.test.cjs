const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const {
  HUMAN_IDLE_MS,
  isHumanIdle,
  markKernelReady,
  noteHumanActivity,
  resetHumanPace,
  streamDiscover,
} = require("../dist/personal-human-pace");

afterEach(() => {
  resetHumanPace();
});

describe("human pace", () => {
  it("stays busy until the kernel has been quiet since listen", () => {
    assert.equal(isHumanIdle(1_000), false);
    markKernelReady(1_000);
    assert.equal(isHumanIdle(1_000 + HUMAN_IDLE_MS - 1), false);
    assert.equal(isHumanIdle(1_000 + HUMAN_IDLE_MS), true);
  });

  it("treats opening a thread as activity that defers background work", () => {
    markKernelReady(1_000);
    noteHumanActivity(5_000);
    assert.equal(isHumanIdle(5_000 + HUMAN_IDLE_MS - 1), false);
    assert.equal(isHumanIdle(5_000 + HUMAN_IDLE_MS), true);
  });

  it("refreshes the Feishu directory only when idle or nothing is mounted", () => {
    markKernelReady(1_000);
    noteHumanActivity(1_000);
    assert.equal(streamDiscover({ capCatchUp: true }, 3, 1_000), "known");
    assert.equal(streamDiscover({ capCatchUp: true }, 0, 1_000), "recent");
    assert.equal(
      streamDiscover({ capCatchUp: true }, 3, 1_000 + HUMAN_IDLE_MS),
      "recent",
    );
    assert.equal(streamDiscover({}, 3, 1_000), "recent");
  });
});
