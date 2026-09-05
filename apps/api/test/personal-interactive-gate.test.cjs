const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const {
  FIRST_INTERACTIVE_GRACE_MS,
  backgroundSyncReleased,
  markBackgroundListen,
  noteInteractiveReadFinished,
  resetInteractiveGate,
} = require("../dist/personal-interactive-gate");

afterEach(() => {
  resetInteractiveGate();
});

describe("interactive gate", () => {
  it("holds background sync until the first UI read finishes", () => {
    markBackgroundListen(1_000);
    assert.equal(backgroundSyncReleased(1_000), false);
    assert.equal(backgroundSyncReleased(1_000 + FIRST_INTERACTIVE_GRACE_MS - 1), false);
    noteInteractiveReadFinished();
    assert.equal(backgroundSyncReleased(1_100), true);
  });

  it("releases after the startup grace if no UI read arrives", () => {
    markBackgroundListen(1_000);
    assert.equal(backgroundSyncReleased(1_000 + FIRST_INTERACTIVE_GRACE_MS), true);
  });
});
