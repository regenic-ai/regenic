import { connectorQuotaFromEnv, firstSeedHeadFromEnv } from "@regenic/domain";
import { PersonalConnectorError } from "./personal-errors";
import { dueWorkClaimLimit, installationConcurrency } from "./personal-connector-rhythm";
import {
  IDLE_HISTORY_STREAM_CONCURRENCY,
  IDLE_MEDIA_CONCURRENCY,
  LIVE_STREAM_CONCURRENCY,
} from "./personal-stream-pace";

export const SYNC_SETTINGS_PREF_KEY = "personal.sync-settings.v1";

export interface PersonalSyncSettings {
  quota_tokens: number;
  quota_window_ms: number;
  installation_concurrency: number;
  live_concurrency: number;
  history_concurrency: number;
  media_concurrency: number;
  steady_claim_limit: number;
  bootstrap_claim_limit: number;
  first_seed_limit: number;
}

export function defaultSyncSettings(): PersonalSyncSettings {
  const quota = connectorQuotaFromEnv();
  return {
    quota_tokens: quota.tokens,
    quota_window_ms: quota.window_ms,
    installation_concurrency: installationConcurrency(),
    live_concurrency: LIVE_STREAM_CONCURRENCY,
    history_concurrency: IDLE_HISTORY_STREAM_CONCURRENCY,
    media_concurrency: IDLE_MEDIA_CONCURRENCY,
    steady_claim_limit: dueWorkClaimLimit("steady"),
    bootstrap_claim_limit: dueWorkClaimLimit("bootstrap"),
    first_seed_limit: firstSeedHeadFromEnv(),
  };
}

export const SYNC_SETTINGS_RANGES = {
  quota_tokens: [0, 10_000],
  quota_window_ms: [1_000, 3_600_000],
  installation_concurrency: [1, 16],
  live_concurrency: [1, 64],
  history_concurrency: [1, 64],
  media_concurrency: [1, 16],
  steady_claim_limit: [1, 128],
  bootstrap_claim_limit: [1, 128],
  first_seed_limit: [0, 64],
} as const satisfies Record<keyof PersonalSyncSettings, readonly [number, number]>;

export function validateSyncSettings(input: unknown): PersonalSyncSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PersonalConnectorError("invalid_config", "Sync settings must be an object", 400);
  }
  const settings = { ...defaultSyncSettings() };
  for (const key of Object.keys(SYNC_SETTINGS_RANGES) as Array<keyof PersonalSyncSettings>) {
    const value = (input as Record<string, unknown>)[key];
    const [min, max] = SYNC_SETTINGS_RANGES[key];
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      throw new PersonalConnectorError(
        "invalid_config", `${key} must be an integer between ${min} and ${max}`, 400,
      );
    }
    settings[key] = value;
  }
  return settings;
}
