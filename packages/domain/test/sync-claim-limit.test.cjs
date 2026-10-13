const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DueWorkClaimLimiter,
  dueWorkHasWritePressure,
  looksLikeSyncPressure,
} = require("../dist");

describe("due-work claim limiter", () => {
  it("halves on pressure and grows by one on a clean tick", () => {
    const limiter = new DueWorkClaimLimiter(1, 32, 32);
    assert.equal(limiter.limit(32), 32);
    limiter.observe(true, 32);
    assert.equal(limiter.limit(32), 16);
    limiter.observe(true, 32);
    assert.equal(limiter.limit(32), 8);
    limiter.observe(false, 32);
    assert.equal(limiter.limit(32), 9);
  });

  it("never exceeds the env cap while recovering", () => {
    const limiter = new DueWorkClaimLimiter(1, 128, 32);
    limiter.observe(false, 16);
    assert.equal(limiter.limit(16), 16);
  });

  it("treats 429, throttle, and write wait as pressure", () => {
    assert.equal(looksLikeSyncPressure({ code: "throttled" }), true);
    assert.equal(looksLikeSyncPressure(new Error("Feishu 429 rate limit")), true);
    assert.equal(looksLikeSyncPressure(new Error("deadline exceeded")), false);
    assert.equal(
      dueWorkHasWritePressure([
        {
          name: "writer_wait_ms",
          labels: {},
          count: 1,
          sum: 400,
          max: 400,
          last: 400,
          recorded_at: "2026-09-21T00:00:00.000Z",
        },
      ]),
      true,
    );
    assert.equal(
      dueWorkHasWritePressure([
        {
          name: "writer_wait_ms",
          labels: {},
          count: 1,
          sum: 20,
          max: 20,
          last: 20,
          recorded_at: "2026-09-21T00:00:00.000Z",
        },
      ]),
      false,
    );
  });
});
