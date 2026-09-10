const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DEFAULT_ACTIVE_STREAM_IDLE_MS,
  DEFAULT_INACTIVE_STREAM_IDLE_MS,
  pacedStreamIdleMs,
  streamIdleTiersFromEnv,
} = require("../dist");

describe("sync idle tiers", () => {
  it("keeps active streams on the short tier", () => {
    assert.equal(
      pacedStreamIdleMs({ active: true }),
      DEFAULT_ACTIVE_STREAM_IDLE_MS,
    );
    assert.equal(
      pacedStreamIdleMs({ active: true, hintMs: 15_000 }),
      15_000,
    );
  });

  it("stretches inactive streams without connector knowledge of tiers", () => {
    assert.equal(
      pacedStreamIdleMs({ active: false, hintMs: 15_000 }),
      DEFAULT_INACTIVE_STREAM_IDLE_MS,
    );
    assert.equal(
      pacedStreamIdleMs({ active: false, hintMs: 50_000 }),
      200_000,
    );
  });

  it("still computes a floor when callers pass no hint (Core gate omits idle instead)", () => {
    assert.equal(
      pacedStreamIdleMs({ active: false }),
      DEFAULT_INACTIVE_STREAM_IDLE_MS,
    );
  });

  it("reads idle tier overrides from env", () => {
    const tiers = streamIdleTiersFromEnv({
      REGENIC_ACTIVE_STREAM_IDLE_MS: "12000",
      REGENIC_INACTIVE_STREAM_IDLE_MS: "120000",
    });
    assert.equal(tiers.activeIdleMs, 12_000);
    assert.equal(tiers.inactiveIdleMs, 120_000);
  });
});
