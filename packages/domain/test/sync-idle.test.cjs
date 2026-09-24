const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DEFAULT_ACTIVE_STREAM_IDLE_MS,
  DEFAULT_COLD_STREAM_IDLE_MS,
  DEFAULT_HOT_STREAM_IDLE_MS,
  DEFAULT_INACTIVE_STREAM_IDLE_MS,
  MAX_COLD_STREAM_IDLE_MS,
  classifyDueWorkHeat,
  coldIdleMsForCatalogSize,
  dueWorkIdleMs,
  nextDueAtForDueWork,
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

describe("due-work heat", () => {
  it("keeps preferred interactive and first seed hot", () => {
    assert.equal(classifyDueWorkHeat({ preferred: true }), "interactive");
    assert.equal(
      classifyDueWorkHeat({ preferred: false, eager: true }),
      "hot",
    );
    assert.equal(
      classifyDueWorkHeat({ preferred: false, acceptedCount: 2 }),
      "hot",
    );
    assert.equal(classifyDueWorkHeat({ preferred: false }), "cold");
  });

  it("uses short idle for hot polls and hour-scale idle for cold", () => {
    assert.equal(
      dueWorkIdleMs({ heat: "interactive" }),
      DEFAULT_ACTIVE_STREAM_IDLE_MS,
    );
    assert.equal(dueWorkIdleMs({ heat: "hot" }), DEFAULT_HOT_STREAM_IDLE_MS);
    assert.equal(dueWorkIdleMs({ heat: "cold" }), DEFAULT_COLD_STREAM_IDLE_MS);
  });

  it("defers first plan of seeded live streams instead of due-now", () => {
    assert.equal(
      nextDueAtForDueWork({
        now: "2026-09-21T00:00:00.000Z",
        heat: "cold",
      }),
      "2026-09-21T01:00:00.000Z",
    );
    assert.equal(
      nextDueAtForDueWork({
        now: "2026-09-21T00:00:00.000Z",
        idleUntil: "2026-09-21T00:03:00.000Z",
        heat: "cold",
      }),
      "2026-09-21T00:03:00.000Z",
    );
    assert.equal(
      nextDueAtForDueWork({
        now: "2026-09-21T00:00:00.000Z",
        idleUntil: "2026-09-21T00:03:00.000Z",
        heat: "interactive",
      }),
      "2026-09-21T00:00:00.000Z",
    );
  });

  it("stretches cold idle up to four hours at 10k streams", () => {
    assert.equal(coldIdleMsForCatalogSize(200), DEFAULT_COLD_STREAM_IDLE_MS);
    assert.equal(coldIdleMsForCatalogSize(10_000), MAX_COLD_STREAM_IDLE_MS);
  });

  it("reads hot and cold idle overrides from env", () => {
    const tiers = streamIdleTiersFromEnv({
      REGENIC_HOT_STREAM_IDLE_MS: "45000",
      REGENIC_COLD_STREAM_IDLE_MS: "7200000",
    });
    assert.equal(tiers.hotIdleMs, 45_000);
    assert.equal(tiers.coldIdleMs, 7_200_000);
  });
});
