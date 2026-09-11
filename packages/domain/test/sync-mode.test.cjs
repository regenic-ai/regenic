const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  DEFAULT_SYNC_MODE,
  SYNC_MODE_BALANCED,
  SYNC_MODE_CONTEXT,
  SYNC_MODE_CONVERSATION,
  parseSyncMode,
  syncModeFromConfig,
  syncModePreset,
} = require("../dist");

describe("sync mode presets", () => {
  it("parses known modes and rejects unknown", () => {
    assert.equal(parseSyncMode("conversation"), "conversation");
    assert.equal(parseSyncMode(" Balanced "), "balanced");
    assert.equal(parseSyncMode("CONTEXT"), "context");
    assert.equal(parseSyncMode(""), null);
    assert.equal(parseSyncMode("fast"), null);
    assert.equal(parseSyncMode(1), null);
  });

  it("maps modes to idle floors", () => {
    assert.deepEqual(syncModePreset("conversation"), SYNC_MODE_CONVERSATION);
    assert.deepEqual(syncModePreset("balanced"), SYNC_MODE_BALANCED);
    assert.deepEqual(syncModePreset("context"), SYNC_MODE_CONTEXT);
    assert.equal(DEFAULT_SYNC_MODE, "conversation");
  });

  it("reads only the generic sync_mode config key", () => {
    assert.equal(syncModeFromConfig({ sync_mode: "context" }), "context");
    assert.equal(syncModeFromConfig({ selection: "recent" }), null);
    assert.equal(syncModeFromConfig(null), null);
    assert.equal(syncModeFromConfig(undefined), null);
  });
});
