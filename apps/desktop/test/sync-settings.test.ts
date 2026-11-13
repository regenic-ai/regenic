import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fasterSyncSettings,
  syncModeFor,
  syncSettingsDraft,
  syncSettingsFromDraft,
} from "../src/renderer/src/sync-settings.ts";
import type { PersonalSyncSettingsView } from "../src/renderer/src/types.ts";

const view: PersonalSyncSettingsView = {
  customized: false,
  settings: {
    quota_tokens: 60, quota_window_ms: 60_000, installation_concurrency: 4,
    live_concurrency: 8, history_concurrency: 4, media_concurrency: 1,
    first_seed_limit: 16, steady_claim_limit: 32, bootstrap_claim_limit: 16,
  },
  defaults: {
    quota_tokens: 60, quota_window_ms: 60_000, installation_concurrency: 4,
    live_concurrency: 8, history_concurrency: 4, media_concurrency: 1,
    first_seed_limit: 16, steady_claim_limit: 32, bootstrap_claim_limit: 16,
  },
  ranges: {
    quota_tokens: [0, 10000], quota_window_ms: [1000, 3600000], installation_concurrency: [1, 16],
    live_concurrency: [1, 64], history_concurrency: [1, 64], media_concurrency: [1, 16],
    first_seed_limit: [0, 64], steady_claim_limit: [1, 128], bootstrap_claim_limit: [1, 128],
  },
};

describe("beginner sync settings", () => {
  it("speeds up new conversation pulls without increasing historical or attachment work", () => {
    const faster = fasterSyncSettings(view);
    assert.deepEqual(faster, {
      ...view.defaults,
      quota_tokens: 120, live_concurrency: 16, first_seed_limit: 32, steady_claim_limit: 64,
    });
    assert.equal(view.defaults.quota_tokens, 60);
    assert.equal(syncModeFor({ ...view, customized: true, settings: faster }), "faster");
  });

  it("respects configured caps, preserves unlimited quotas, and can resume new conversation pulls", () => {
    const nearCaps = fasterSyncSettings({
      ...view,
      defaults: { ...view.defaults, quota_tokens: 8000, live_concurrency: 40, first_seed_limit: 40, steady_claim_limit: 100 },
    });
    assert.equal(nearCaps.quota_tokens, 10000);
    assert.equal(nearCaps.live_concurrency, 64);
    assert.equal(nearCaps.first_seed_limit, 64);
    assert.equal(nearCaps.steady_claim_limit, 128);
    const limited = {
      ...view,
      defaults: { ...view.defaults, quota_tokens: 0, live_concurrency: 64, first_seed_limit: 0, steady_claim_limit: 128 },
    };
    const faster = fasterSyncSettings(limited);
    assert.equal(faster.quota_tokens, 0);
    assert.equal(faster.live_concurrency, 64);
    assert.equal(faster.steady_claim_limit, 128);
    assert.equal(faster.first_seed_limit, 1);
    const capped = { ...view, defaults: { ...faster, first_seed_limit: 64 } };
    assert.equal(syncModeFor({ ...capped, settings: capped.defaults, customized: true }), "custom");
  });

  it("does not mistake existing manual settings or explicit default-valued overrides for the recommended mode", () => {
    assert.equal(syncModeFor(view), "balanced");
    assert.equal(syncModeFor({ ...view, customized: true }), "custom");
    assert.equal(syncModeFor({
      ...view, customized: true, settings: { ...view.settings, history_concurrency: 7 },
    }), "custom");
  });

  it("round-trips seconds without changing stored millisecond precision or other settings", () => {
    const settings = { ...view.settings, quota_window_ms: 120_001 };
    const draft = syncSettingsDraft(settings);
    assert.equal(draft.quota_window_ms, "120.001");
    assert.deepEqual(syncSettingsFromDraft(draft), settings);
  });
});
