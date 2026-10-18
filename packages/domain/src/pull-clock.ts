import {
  PULL_INTERVAL_MAX_MS,
  PULL_INTERVAL_MIN_MS,
  type RecipeTrigger,
} from "./work";

export function isPullIntervalMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= PULL_INTERVAL_MIN_MS &&
    value <= PULL_INTERVAL_MAX_MS &&
    value % PULL_INTERVAL_MIN_MS === 0
  );
}

export function isAtMinute(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 1439
  );
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const zone = value.trim();
  if (!zone || zone.length > 100) {
    return false;
  }
  try {
    Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Sorted unique ISO weekdays. Empty input is omitted (every day). */
export function normalizeWeekdays(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const days = [
    ...new Set(
      value.filter(
        (day): day is number =>
          typeof day === "number" && Number.isInteger(day) && day >= 1 && day <= 7,
      ),
    ),
  ].sort((left, right) => left - right);
  return days.length > 0 ? days : undefined;
}

export interface PullClock {
  at_minute: number;
  timezone: string;
  weekdays?: number[];
}

export function readPullClock(trigger: {
  at_minute?: number;
  timezone?: string;
  weekdays?: number[];
}): PullClock | undefined {
  if (!isAtMinute(trigger.at_minute) || !isTimeZone(trigger.timezone)) {
    return undefined;
  }
  const weekdays = normalizeWeekdays(trigger.weekdays);
  return {
    at_minute: trigger.at_minute,
    timezone: trigger.timezone.trim(),
    ...(weekdays ? { weekdays } : {}),
  };
}

export function pullScheduleColumns(trigger: RecipeTrigger): {
  interval_ms: number | null;
  at_minute: number | null;
  weekdays: string | null;
  timezone: string | null;
} {
  if (trigger.kind !== "pull") {
    return {
      interval_ms: null,
      at_minute: null,
      weekdays: null,
      timezone: null,
    };
  }
  const clock = readPullClock(trigger);
  return {
    interval_ms: isPullIntervalMs(trigger.interval_ms) ? trigger.interval_ms : null,
    at_minute: clock ? clock.at_minute : null,
    weekdays: clock?.weekdays?.length ? clock.weekdays.join(",") : null,
    timezone: clock ? clock.timezone : null,
  };
}

export function pullScheduleFromColumns(row: {
  trigger_interval_ms: number | null;
  trigger_at_minute?: number | null;
  trigger_weekdays?: string | null;
  trigger_timezone?: string | null;
}): Pick<RecipeTrigger, "interval_ms" | "at_minute" | "weekdays" | "timezone"> {
  const interval_ms = isPullIntervalMs(row.trigger_interval_ms)
    ? row.trigger_interval_ms
    : undefined;
  const clock = readPullClock({
    at_minute: row.trigger_at_minute ?? undefined,
    timezone: row.trigger_timezone ?? undefined,
    weekdays: parseWeekdayColumn(row.trigger_weekdays),
  });
  return {
    ...(interval_ms !== undefined ? { interval_ms } : {}),
    ...(clock
      ? {
          at_minute: clock.at_minute,
          timezone: clock.timezone,
          ...(clock.weekdays ? { weekdays: clock.weekdays } : {}),
        }
      : {}),
  };
}

/**
 * First UTC instant at or after `earliestMs` whose wall clock in `timezone`
 * matches `at_minute` and, when set, `weekdays`.
 * A daylight-saving gap (the local time does not exist) skips to the next day.
 */
export function nextClockAtOrAfter(spec: PullClock, earliestMs: number): number {
  const hour = Math.floor(spec.at_minute / 60);
  const minute = spec.at_minute % 60;
  const allowed = spec.weekdays?.length ? new Set(spec.weekdays) : null;
  const start = zonedParts(earliestMs, spec.timezone);
  for (let offset = 0; offset <= 21; offset += 1) {
    const date = addCalendarDays(start.year, start.month, start.day, offset);
    if (allowed && !allowed.has(calendarWeekday(date.year, date.month, date.day))) {
      continue;
    }
    const utc = zonedTimeToUtc(
      date.year,
      date.month,
      date.day,
      hour,
      minute,
      spec.timezone,
    );
    if (utc !== null && utc >= earliestMs) {
      return utc;
    }
  }
  throw new Error(`No clock occurrence for ${spec.timezone}`);
}

function parseWeekdayColumn(value: string | null | undefined): number[] | undefined {
  if (!value) {
    return undefined;
  }
  return value.split(",").map((part) => Number(part));
}

interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

interface ZonedParts extends CalendarDate {
  hour: number;
  minute: number;
  second: number;
}

function zonedParts(utcMs: number, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const bag: Record<string, string> = {};
  for (const part of fmt.formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") {
      bag[part.type] = part.value;
    }
  }
  let hour = Number(bag.hour);
  let year = Number(bag.year);
  let month = Number(bag.month);
  let day = Number(bag.day);
  if (hour === 24) {
    hour = 0;
    const next = addCalendarDays(year, month, day, 1);
    year = next.year;
    month = next.month;
    day = next.day;
  }
  return {
    year,
    month,
    day,
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = zonedParts(utcMs, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - utcMs;
}

/** Null when that local time does not exist (daylight-saving gap). */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number | null {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offset = tzOffsetMs(guess, timeZone);
  let utc = guess - offset;
  const offset2 = tzOffsetMs(utc, timeZone);
  if (offset2 !== offset) {
    utc = guess - offset2;
  }
  const parts = zonedParts(utc, timeZone);
  if (
    parts.year !== year ||
    parts.month !== month ||
    parts.day !== day ||
    parts.hour !== hour ||
    parts.minute !== minute
  ) {
    return null;
  }
  return utc;
}

function addCalendarDays(year: number, month: number, day: number, days: number): CalendarDate {
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

function calendarWeekday(year: number, month: number, day: number): number {
  const sun0 = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return sun0 === 0 ? 7 : sun0;
}
