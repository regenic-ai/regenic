/**
 * Core-owned sync intent presets. Connectors may persist `config.sync_mode`
 * and optionally hint via `pace.idle_ms`; they must not encode active/inactive.
 */

import {
  DEFAULT_SYNC_MODE,
  parseSyncMode,
  type SyncMode,
} from "@regenic/connector-contract";

export { DEFAULT_SYNC_MODE, parseSyncMode };
export type { SyncMode };

export interface SyncModePreset {
  activeIdleMs: number;
  inactiveIdleMs: number;
}

/** Open thread stays hot; background quiet. Default for new paced installs. */
export const SYNC_MODE_CONVERSATION: SyncModePreset = {
  activeIdleMs: 10_000,
  inactiveIdleMs: 300_000,
};

/** Aligns with default env floors after personal sync tiers (#161). */
export const SYNC_MODE_BALANCED: SyncModePreset = {
  activeIdleMs: 15_000,
  inactiveIdleMs: 180_000,
};

/** Slower overall — Agent / long-term context extraction. */
export const SYNC_MODE_CONTEXT: SyncModePreset = {
  activeIdleMs: 30_000,
  inactiveIdleMs: 600_000,
};

export function syncModePreset(mode: SyncMode): SyncModePreset {
  switch (mode) {
    case "conversation":
      return { ...SYNC_MODE_CONVERSATION };
    case "balanced":
      return { ...SYNC_MODE_BALANCED };
    case "context":
      return { ...SYNC_MODE_CONTEXT };
  }
}

/** Reads generic `config.sync_mode` only — no connector names. */
export function syncModeFromConfig(
  config: Record<string, unknown> | null | undefined,
): SyncMode | null {
  if (!config || typeof config !== "object") {
    return null;
  }
  return parseSyncMode(config.sync_mode);
}
