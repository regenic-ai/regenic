const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  API_OLD_SPACE_MB,
  nodeOptionsWithHeap,
  restartDelayMs,
  shouldRecycleWatcher,
} = require("../scripts/api-process.cjs");

describe("API process budget", () => {
  it("pins a heap under the 2Gi cgroup unless one is already set", () => {
    assert.equal(nodeOptionsWithHeap(undefined), `--max-old-space-size=${API_OLD_SPACE_MB}`);
    assert.equal(nodeOptionsWithHeap(""), `--max-old-space-size=${API_OLD_SPACE_MB}`);
    assert.equal(
      nodeOptionsWithHeap("--trace-warnings"),
      `--trace-warnings --max-old-space-size=${API_OLD_SPACE_MB}`,
    );
    assert.equal(
      nodeOptionsWithHeap("--max-old-space-size=4096"),
      "--max-old-space-size=4096",
    );
  });

  it("backs off a crash loop", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 8].map((attempt) => restartDelayMs(attempt)),
      [1_000, 2_000, 4_000, 8_000, 15_000, 15_000],
    );
  });

  it("recycles a live watcher only after the port has been up and then stays down", () => {
    const stuck = {
      everListened: true,
      misses: 2,
      stopping: false,
      childAlive: true,
    };
    assert.equal(shouldRecycleWatcher(stuck), true);
    assert.equal(shouldRecycleWatcher({ ...stuck, misses: 1 }), false);
    assert.equal(shouldRecycleWatcher({ ...stuck, everListened: false }), false);
    assert.equal(shouldRecycleWatcher({ ...stuck, stopping: true }), false);
    assert.equal(shouldRecycleWatcher({ ...stuck, childAlive: false }), false);
  });
});
