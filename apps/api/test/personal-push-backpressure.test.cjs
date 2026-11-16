const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  PUSH_BACKPRESSURE_PREF_KEY,
  persistPushBackpressure,
  pushBackpressureIsActive,
} = require("../dist/personal-push-backpressure");

describe("durable push backpressure visibility", () => {
  it("persists an expiring cross-replica signal without writing every rejection", async () => {
    const writes = [];
    const store = {
      async putUiPref(...args) {
        writes.push(args);
      },
    };
    const now = Date.parse("2026-11-16T00:00:00.000Z");
    persistPushBackpressure(store, "org-backpressure-test", 5_000, now);
    persistPushBackpressure(store, "org-backpressure-test", 5_000, now + 1_000);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(writes.length, 1);
    assert.equal(writes[0][1], PUSH_BACKPRESSURE_PREF_KEY);
    assert.equal(
      pushBackpressureIsActive(writes[0][2], now + 30_000),
      true,
    );
    assert.equal(
      pushBackpressureIsActive(writes[0][2], now + 61_000),
      false,
    );
  });
});
