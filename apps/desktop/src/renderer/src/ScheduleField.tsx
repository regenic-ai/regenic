import { useEffect, useRef, useState } from "react";
import type { RecipeDraft, Translate } from "./recipe-draft";
import {
  DEFAULT_MONTHDAY,
  DEFAULT_WEEKDAYS,
  FAST_INTERVAL_MS,
  SCHEDULE_PRESETS,
  WEEKDAY_FULL_KEYS,
  formatClock,
  intervalMs,
  intervalParts,
  parseClock,
  scheduleCopy,
  type IntervalUnit,
  type ScheduleMode,
} from "./schedule";

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
const MONTHDAYS = Array.from({ length: 31 }, (_, index) => index + 1);

const WEEKDAY_KEYS = [
  "recipes.wd1",
  "recipes.wd2",
  "recipes.wd3",
  "recipes.wd4",
  "recipes.wd5",
  "recipes.wd6",
  "recipes.wd7",
] as const;

export function ScheduleField({
  draft,
  t,
  onChange,
}: {
  draft: RecipeDraft;
  t: Translate;
  onChange: (
    patch: Partial<
      Pick<
        RecipeDraft,
        | "schedule_mode"
        | "interval_ms"
        | "at_minute"
        | "weekdays"
        | "monthdays"
        | "timezone"
      >
    >,
  ) => void;
}) {
  const editingUnit = useRef<IntervalUnit | undefined>(undefined);
  const parts = intervalParts(draft.interval_ms, editingUnit.current);
  const [countText, setCountText] = useState(String(parts.count));
  const countFocused = useRef(false);
  const summary = scheduleCopy(
    {
      interval_ms: draft.interval_ms,
      at_minute:
        draft.schedule_mode === "interval" ? undefined : draft.at_minute,
      weekdays: draft.schedule_mode === "weekly" ? draft.weekdays : undefined,
      monthdays: draft.schedule_mode === "monthly" ? draft.monthdays : undefined,
      timezone: draft.schedule_mode === "interval" ? undefined : draft.timezone,
    },
    t,
  );

  useEffect(() => {
    if (!countFocused.current) {
      setCountText(String(parts.count));
    }
  }, [parts.count, parts.unit]);

  const setMode = (mode: ScheduleMode) => {
    if (mode === "weekly") {
      onChange({
        schedule_mode: "weekly",
        weekdays: draft.weekdays.length ? draft.weekdays : [...DEFAULT_WEEKDAYS],
      });
      return;
    }
    if (mode === "monthly") {
      onChange({
        schedule_mode: "monthly",
        monthdays: draft.monthdays.length ? draft.monthdays : [DEFAULT_MONTHDAY],
      });
      return;
    }
    onChange({ schedule_mode: mode });
  };

  const setUnit = (unit: IntervalUnit) => {
    onChange({
      schedule_mode: "interval",
      interval_ms: intervalMs(parts.count, unit),
    });
  };

  const commitCount = (raw: string) => {
    const next = intervalMs(Number(raw), parts.unit);
    onChange({ schedule_mode: "interval", interval_ms: next });
    setCountText(String(intervalParts(next).count));
  };

  const toggleDay = (day: number) => {
    const selected = draft.weekdays.includes(day);
    if (selected && draft.weekdays.length === 1) {
      return;
    }
    const weekdays = selected
      ? draft.weekdays.filter((item) => item !== day)
      : [...draft.weekdays, day].sort((left, right) => left - right);
    onChange({ schedule_mode: "weekly", weekdays });
  };

  const toggleMonthday = (day: number) => {
    const selected = draft.monthdays.includes(day);
    if (selected && draft.monthdays.length === 1) {
      return;
    }
    const monthdays = selected
      ? draft.monthdays.filter((item) => item !== day)
      : [...draft.monthdays, day].sort((left, right) => left - right);
    onChange({ schedule_mode: "monthly", monthdays });
  };

  return (
    <div className="schedule-field">
      <div className="seg" role="group" aria-label={t("recipes.interval")}>
        {(
          [
            ["interval", "recipes.scheduleInterval"],
            ["daily", "recipes.scheduleDaily"],
            ["weekly", "recipes.scheduleWeekly"],
            ["monthly", "recipes.scheduleMonthly"],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            className={draft.schedule_mode === mode ? "active" : undefined}
            aria-pressed={draft.schedule_mode === mode}
            onClick={() => setMode(mode)}
          >
            {t(label)}
          </button>
        ))}
      </div>

      {draft.schedule_mode === "interval" ? (
        <>
          <div className="schedule-every">
            <span className="schedule-every-label">{t("recipes.scheduleEvery")}</span>
            <input
              type="text"
              inputMode="numeric"
              className="schedule-count"
              aria-label={t("recipes.scheduleCount")}
              value={countText}
              onFocus={() => {
                countFocused.current = true;
                editingUnit.current = parts.unit;
              }}
              onBlur={() => {
                countFocused.current = false;
                editingUnit.current = undefined;
                commitCount(countText);
              }}
              onChange={(event) => {
                const raw = event.target.value;
                if (raw !== "" && !/^\d{1,5}$/.test(raw)) {
                  return;
                }
                setCountText(raw);
                if (/^\d+$/.test(raw) && Number(raw) >= 1) {
                  onChange({
                    schedule_mode: "interval",
                    interval_ms: intervalMs(Number(raw), parts.unit),
                  });
                }
              }}
            />
            <div className="schedule-unit-seg" role="group" aria-label={t("recipes.scheduleUnit")}>
              {(
                [
                  ["minutes", "recipes.unitMinutes"],
                  ["hours", "recipes.unitHours"],
                ] as const
              ).map(([unit, label]) => (
                <button
                  key={unit}
                  type="button"
                  className={parts.unit === unit ? "active" : undefined}
                  aria-pressed={parts.unit === unit}
                  onClick={() => setUnit(unit)}
                >
                  {t(label)}
                </button>
              ))}
            </div>
          </div>
          <div className="schedule-presets">
            {SCHEDULE_PRESETS.map((preset) => (
              <button
                key={preset.ms}
                type="button"
                className={draft.interval_ms === preset.ms ? "active" : undefined}
                aria-pressed={draft.interval_ms === preset.ms}
                onClick={() =>
                  onChange({ schedule_mode: "interval", interval_ms: preset.ms })
                }
              >
                {t(preset.label)}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          {draft.schedule_mode === "weekly" ? (
            <div className="schedule-days" role="group" aria-label={t("recipes.scheduleDays")}>
              {WEEKDAYS.map((day) => (
                <button
                  key={day}
                  type="button"
                  className={draft.weekdays.includes(day) ? "active" : undefined}
                  aria-pressed={draft.weekdays.includes(day)}
                  aria-label={t(WEEKDAY_FULL_KEYS[day - 1])}
                  onClick={() => toggleDay(day)}
                >
                  {t(WEEKDAY_KEYS[day - 1])}
                </button>
              ))}
            </div>
          ) : null}
          {draft.schedule_mode === "monthly" ? (
            <div
              className="schedule-days schedule-monthdays"
              role="group"
              aria-label={t("recipes.scheduleMonthDays")}
            >
              {MONTHDAYS.map((day) => (
                <button
                  key={day}
                  type="button"
                  className={draft.monthdays.includes(day) ? "active" : undefined}
                  aria-pressed={draft.monthdays.includes(day)}
                  aria-label={t("recipes.monthDay", { day })}
                  onClick={() => toggleMonthday(day)}
                >
                  {day}
                </button>
              ))}
            </div>
          ) : null}
          <input
            type="time"
            className="schedule-time"
            step={60}
            aria-label={t("recipes.scheduleTime")}
            value={formatClock(draft.at_minute)}
            onChange={(event) => {
              const minute = parseClock(event.target.value);
              if (minute === null) {
                return;
              }
              onChange({ at_minute: minute });
            }}
          />
        </>
      )}

      <p className="recipe-hint">{summary}</p>
      {draft.schedule_mode === "interval" && draft.interval_ms < FAST_INTERVAL_MS ? (
        <p className="recipe-hint">{t("recipes.intervalFastHint")}</p>
      ) : null}
      {draft.schedule_mode !== "interval" ? (
        <p className="recipe-hint">
          {t("recipes.scheduleZone", { zone: draft.timezone })}
        </p>
      ) : null}
      {draft.schedule_mode === "monthly" && draft.monthdays.some((day) => day > 28) ? (
        <p className="recipe-hint">{t("recipes.scheduleMonthSkip")}</p>
      ) : null}
    </div>
  );
}
