import type { PersonalSyncSettings, PersonalSyncSettingsView } from "./types.ts";

export type SyncMode = "balanced" | "faster" | "custom";
export type SyncSettingsDraft = Record<keyof PersonalSyncSettings, string>;

const keys: Array<keyof PersonalSyncSettings> = [
  "quota_tokens", "quota_window_ms", "installation_concurrency",
  "live_concurrency", "history_concurrency", "media_concurrency",
  "first_seed_limit", "steady_claim_limit", "bootstrap_claim_limit",
];

export function syncDisplayValue(key: keyof PersonalSyncSettings, value: number): number {
  return key === "quota_window_ms" ? value / 1000 : value;
}

export function syncSettingsDraft(settings: PersonalSyncSettings): SyncSettingsDraft {
  return Object.fromEntries(
    keys.map((key) => [key, String(syncDisplayValue(key, settings[key]))]),
  ) as SyncSettingsDraft;
}

export function syncSettingsFromDraft(draft: SyncSettingsDraft): PersonalSyncSettings {
  return {
    quota_tokens: Number(draft.quota_tokens),
    quota_window_ms: Math.round(Number(draft.quota_window_ms) * 1000),
    installation_concurrency: Number(draft.installation_concurrency),
    live_concurrency: Number(draft.live_concurrency),
    history_concurrency: Number(draft.history_concurrency),
    media_concurrency: Number(draft.media_concurrency),
    first_seed_limit: Number(draft.first_seed_limit),
    steady_claim_limit: Number(draft.steady_claim_limit),
    bootstrap_claim_limit: Number(draft.bootstrap_claim_limit),
  };
}

export function sameSyncSettings(left: PersonalSyncSettings, right: PersonalSyncSettings): boolean {
  return keys.every((key) => left[key] === right[key]);
}

export function fasterSyncSettings(view: Pick<PersonalSyncSettingsView, "defaults" | "ranges">): PersonalSyncSettings {
  const settings = { ...view.defaults };
  // Favor first pulls and fresh messages; do not make history or attachment work compete harder.
  for (const key of ["quota_tokens", "live_concurrency", "first_seed_limit", "steady_claim_limit"] as const) {
    if (key === "quota_tokens" && settings[key] === 0) continue;
    const [min, max] = view.ranges[key];
    settings[key] = Math.min(max, Math.max(min, 1, settings[key] * 2));
  }
  return settings;
}

export function syncModeFor(view: PersonalSyncSettingsView): SyncMode {
  if (!view.customized) return "balanced";
  const faster = fasterSyncSettings(view);
  return !sameSyncSettings(faster, view.defaults) && sameSyncSettings(view.settings, faster)
    ? "faster"
    : "custom";
}
