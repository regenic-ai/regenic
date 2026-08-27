const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const {
  HUMAN_IDLE_MS,
  isHumanIdle,
  markKernelReady,
  noteHumanActivity,
  resetHumanPace,
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
});
