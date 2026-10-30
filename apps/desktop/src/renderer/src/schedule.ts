import type { MessageKey } from "../../shared/i18n.ts";

/** Keep aligned with PULL_INTERVAL_MIN_MS / PULL_INTERVAL_MAX_MS in domain. */
export const INTERVAL_MIN_MS = 60_000;
export const INTERVAL_MAX_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_AT_MINUTE = 9 * 60;
export const DEFAULT_WEEKDAYS = [1, 2, 3, 4, 5] as const;
export const FAST_INTERVAL_MS = 15 * 60_000;

export type ScheduleMode = "interval" | "daily" | "weekly";
export type IntervalUnit = "minutes" | "hours";

export const SCHEDULE_PRESETS = [
  { ms: 5 * 60_000, label: "recipes.preset5m" },
  { ms: 15 * 60_000, label: "recipes.preset15m" },
  { ms: 30 * 60_000, label: "recipes.preset30m" },
  { ms: 60 * 60_000, label: "recipes.preset1h" },
  { ms: 6 * 60 * 60_000, label: "recipes.preset6h" },
  { ms: 12 * 60 * 60_000, label: "recipes.preset12h" },
] as const satisfies ReadonlyArray<{ ms: number; label: MessageKey }>;

const WEEKDAY_KEYS = [
  "recipes.wd1",
  "recipes.wd2",
  "recipes.wd3",
  "recipes.wd4",
  "recipes.wd5",
  "recipes.wd6",
  "recipes.wd7",
] as const satisfies readonly MessageKey[];

export const WEEKDAY_FULL_KEYS = [
  "recipes.wdFull1",
  "recipes.wdFull2",
  "recipes.wdFull3",
  "recipes.wdFull4",
  "recipes.wdFull5",
  "recipes.wdFull6",
  "recipes.wdFull7",
] as const satisfies readonly MessageKey[];

type ScheduleVars = Record<string, string | number>;

export type ScheduleTranslate = (key: MessageKey, vars?: ScheduleVars) => string;

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function intervalMs(count: number, unit: IntervalUnit): number {
  const step = unit === "hours" ? 3_600_000 : INTERVAL_MIN_MS;
  const maxCount = Math.floor(INTERVAL_MAX_MS / step);
  const safe = Math.min(maxCount, Math.max(1, Math.floor(count)));
  return safe * step;
}

export function intervalParts(
  ms: number,
  editingUnit?: IntervalUnit,
): { count: number; unit: IntervalUnit } {
  const safe = clampIntervalMs(ms);
  if (editingUnit === "hours" || (!editingUnit && safe % 3_600_000 === 0)) {
    return { count: safe / 3_600_000, unit: "hours" };
  }
  return { count: safe / INTERVAL_MIN_MS, unit: "minutes" };
}

export function clampIntervalMs(ms: number): number {
  if (!Number.isFinite(ms)) {
    return 3_600_000;
  }
  const minutes = Math.round(ms / INTERVAL_MIN_MS);
  const maxMinutes = INTERVAL_MAX_MS / INTERVAL_MIN_MS;
  return Math.min(maxMinutes, Math.max(1, minutes)) * INTERVAL_MIN_MS;
}

export function formatClock(minute: number): string {
  const safe = Math.min(1439, Math.max(0, Math.floor(minute)));
  const hour = Math.floor(safe / 60);
  const min = safe % 60;
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function parseClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value.trim());
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

export function modeFromTrigger(trigger: {
  at_minute?: number;
  timezone?: string;
  weekdays?: number[];
} | undefined): ScheduleMode {
  if (!trigger || typeof trigger.at_minute !== "number" || !trigger.timezone) {
    return "interval";
  }
  if (trigger.weekdays && trigger.weekdays.length > 0) {
    return "weekly";
  }
  return "daily";
}

export function pullTriggerFromDraft(draft: {
  schedule_mode: ScheduleMode;
  interval_ms: number;
  at_minute: number;
  weekdays: number[];
  timezone: string;
}): {
  kind: "pull";
  interval_ms: number;
  at_minute?: number;
  weekdays?: number[];
  timezone?: string;
} {
  if (draft.schedule_mode === "daily" || draft.schedule_mode === "weekly") {
    const weekdays =
      draft.schedule_mode === "weekly"
        ? [...(draft.weekdays.length ? draft.weekdays : DEFAULT_WEEKDAYS)].sort(
            (left, right) => left - right,
          )
        : undefined;
    return {
      kind: "pull",
      interval_ms: 24 * 60 * 60 * 1000,
      at_minute: Math.min(1439, Math.max(0, Math.floor(draft.at_minute))),
      timezone: draft.timezone || localTimeZone(),
      ...(weekdays ? { weekdays } : {}),
    };
  }
  return { kind: "pull", interval_ms: clampIntervalMs(draft.interval_ms) };
}

export function scheduleCopy(
  trigger: {
    interval_ms?: number;
    at_minute?: number;
    weekdays?: number[];
    timezone?: string;
  } | undefined,
  t: ScheduleTranslate,
): string {
  if (trigger && typeof trigger.at_minute === "number" && trigger.timezone) {
    const time = formatClock(trigger.at_minute);
    const days = trigger.weekdays ?? [];
    if (days.length === 0 || days.length === 7) {
      return t("recipes.scheduleDailyAt", { time });
    }
    if (sameDays(days, [1, 2, 3, 4, 5])) {
      return t("recipes.scheduleWeekdaysAt", { time });
    }
    if (sameDays(days, [6, 7])) {
      return t("recipes.scheduleWeekendsAt", { time });
    }
    const names = [...days]
      .sort((left, right) => left - right)
      .map((day) => t(WEEKDAY_KEYS[day - 1] ?? "recipes.wd1"))
      .join(t("recipes.wdSep"));
    return t("recipes.scheduleWeeklyAt", { days: names, time });
  }
  const ms = trigger?.interval_ms ?? 0;
  if (ms > 0 && ms % 3_600_000 === 0) {
    const hours = ms / 3_600_000;
    if (hours === 1) {
      return t("recipes.interval1h");
    }
    return t("recipes.scheduleEveryHours", { count: hours });
  }
  if (ms > 0 && ms % INTERVAL_MIN_MS === 0) {
    const minutes = ms / INTERVAL_MIN_MS;
    if (minutes === 1) {
      return t("recipes.scheduleEveryMinute");
    }
    return t("recipes.scheduleEveryMinutes", { count: minutes });
  }
  return t("recipes.triggerPull");
}

function sameDays(days: number[], expected: number[]): boolean {
  if (days.length !== expected.length) {
    return false;
  }
  const sorted = [...days].sort((left, right) => left - right);
  return expected.every((day, index) => sorted[index] === day);
}
