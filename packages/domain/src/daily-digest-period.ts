export interface DailyDigestPeriod {
  local_date: string;
  time_zone: string;
  utc_start: string;
  utc_end: string;
}

export function localDateAt(timestamp: string | Date, timeZone: string): string {
  const date = typeof timestamp === "string" ? new Date(timestamp) : timestamp;
  if (Number.isNaN(date.getTime())) throw new Error("Invalid daily digest timestamp");
  assertTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function dailyDigestPeriod(localDate: string, timeZone: string): DailyDigestPeriod {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new Error("Invalid daily digest local date");
  assertTimeZone(timeZone);
  const start = zonedMidnight(localDate, timeZone);
  const nextDate = new Date(`${localDate}T00:00:00.000Z`);
  nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const nextLocalDate = nextDate.toISOString().slice(0, 10);
  return {
    local_date: localDate,
    time_zone: timeZone,
    utc_start: start.toISOString(),
    utc_end: zonedMidnight(nextLocalDate, timeZone).toISOString(),
  };
}

export function assertTimeZone(timeZone: string): void {
  if (!timeZone?.trim()) throw new Error("Daily digest time zone is required");
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format();
  } catch {
    throw new Error("Invalid daily digest time zone");
  }
}

function zonedMidnight(localDate: string, timeZone: string): Date {
  const initial = new Date(`${localDate}T00:00:00.000Z`);
  let timestamp = initial.getTime();
  for (let index = 0; index < 2; index += 1) {
    const local = localParts(new Date(timestamp), timeZone);
    const localTimestamp = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
    timestamp = initial.getTime() - (localTimestamp - timestamp);
  }
  return new Date(timestamp);
}

function localParts(date: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
}
