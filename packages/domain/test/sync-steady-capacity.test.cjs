const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  steadyCapacityFromEnv,
  steadyLaneLimitsForCount,
  steadyLiveLimit,
  steadyTargetIdleMs,
} = require("../dist");

function member(streamKey, threadId) {
  return {
    installation_id: "feishu-1",
    stream_key: streamKey,
    thread_id: threadId,
    generation: 1,
    discovered_at: "2026-08-31T00:00:00.000Z",
    last_seen_at: "2026-08-31T00:00:00.000Z",
  };
}

function state(streamKey, phase, idleUntil) {
  return {
    installation_id: "feishu-1",
    stream_key: streamKey,
    phase,
    live_cursor: "{}",
    history_cursor: "{}",
    media_pending: false,
    idle_until: idleUntil,
    generation: 1,
    updated_at: "2026-08-31T00:00:00.000Z",
  };
}

describe("sync steady capacity", () => {
  it("scales live limit with steady fan-out", () => {
    assert.equal(
      steadyLiveLimit({ steadyCount: 913, tickIntervalMs: 10_000, targetIdleMs: 180_000 }),
      48,
    );
    assert.equal(
      steadyLiveLimit({ steadyCount: 64, tickIntervalMs: 10_000, targetIdleMs: 180_000 }),
      8,
    );
    assert.equal(
      steadyLiveLimit({ steadyCount: 913, tickIntervalMs: 10_000, targetIdleMs: 360_000 }),
      26,
    );
  });

  it("stretches target idle for large steady pools", () => {
    assert.equal(steadyTargetIdleMs(32), 180_000);
    assert.equal(steadyTargetIdleMs(128), 270_000);
    assert.equal(steadyTargetIdleMs(913), 360_000);
  });

  it("derives steady lane limits from lifecycle partition", () => {
    const members = Array.from({ length: 200 }, (_, index) =>
      member(`chat:${index}`, `feishu:${index}`),
    );
    const states = new Map(
      members.map((item) => [item.stream_key, state(item.stream_key, "steady", null)]),
    );
    const limits = steadyLaneLimitsForCount({
      members,
      states,
      tickIntervalMs: 10_000,
      catalogIncomplete: false,
    });
    assert.ok(limits.live >= 8);
    assert.ok(limits.live <= 48);
    assert.equal(limits.history, 0);
  });

  it("reads steady capacity overrides from env", () => {
    const parsed = steadyCapacityFromEnv({
      REGENIC_STEADY_TARGET_IDLE_MS: "45000",
      REGENIC_STEADY_LIVE_MAX: "40",
    });
    assert.equal(parsed.targetIdleMs, 45_000);
    assert.equal(parsed.maxLive, 40);
  });
});
