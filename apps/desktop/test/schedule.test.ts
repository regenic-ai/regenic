import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRecipeBundle,
  parseRecipeBundle,
  stringifyRecipeBundle,
} from "../src/renderer/src/recipe-transfer.ts";
import {
  intervalMs,
  intervalParts,
  pullTriggerFromDraft,
  scheduleCopy,
} from "../src/renderer/src/schedule.ts";
import { translate } from "../src/shared/messages.ts";
import type { RecipeView } from "../src/renderer/src/types.ts";

const zh = (
  key: Parameters<typeof translate>[1],
  vars?: Record<string, string | number>,
) => translate("zh", key, vars);

describe("interval editing", () => {
  it("keeps minutes through typing, rerenders, and blur at whole-hour boundaries", () => {
    const editingUnit = intervalParts(15 * 60_000).unit;
    let ms = 15 * 60_000;
    for (const raw of ["1", "12", "120", "1200"]) {
      const parts = intervalParts(ms, editingUnit);
      assert.equal(parts.unit, "minutes");
      ms = intervalMs(Number(raw), parts.unit);
      const rerendered = intervalParts(ms, editingUnit);
      assert.equal(rerendered.unit, "minutes");
      assert.equal(rerendered.count, Number(raw));
      const blurred = intervalMs(Number(raw), rerendered.unit);
      assert.equal(blurred, Number(raw) * 60_000);
      assert.equal(ms, blurred);
    }
    assert.deepEqual(intervalParts(120 * 60_000), { count: 2, unit: "hours" });
  });

  it("retains hours and clamps invalid or excessive input on blur", () => {
    const editingUnit = intervalParts(2 * 3_600_000).unit;
    for (const [raw, hours] of [["", 1], ["0", 1], ["3", 3], ["99999", 168]] as const) {
      const ms = intervalMs(Number(raw), editingUnit);
      const parts = intervalParts(ms, editingUnit);
      assert.equal(parts.unit, "hours");
      assert.equal(parts.count, hours);
      assert.equal(intervalMs(Number(raw), parts.unit), hours * 3_600_000);
    }
  });
});

describe("schedule copy", () => {
  it("describes intervals, weekdays, and a daily clock", () => {
    assert.equal(scheduleCopy({ interval_ms: 15 * 60_000 }, zh), "每 15 分钟");
    assert.equal(scheduleCopy({ interval_ms: 60 * 60_000 }, zh), "每小时");
    assert.equal(scheduleCopy({ interval_ms: 90 * 60_000 }, zh), "每 90 分钟");
    assert.equal(scheduleCopy({ interval_ms: 6 * 60 * 60_000 }, zh), "每 6 小时");
    assert.equal(
      scheduleCopy(
        { at_minute: 9 * 60, timezone: "Asia/Shanghai" },
        zh,
      ),
      "每天 09:00",
    );
    assert.equal(
      scheduleCopy(
        {
          at_minute: 9 * 60,
          timezone: "Asia/Shanghai",
          weekdays: [1, 2, 3, 4, 5],
        },
        zh,
      ),
      "工作日 09:00",
    );
    assert.equal(
      scheduleCopy(
        {
          at_minute: 18 * 60 + 30,
          timezone: "Asia/Shanghai",
          weekdays: [1, 3],
        },
        zh,
      ),
      "每周一、三 18:30",
    );
    assert.equal(
      scheduleCopy(
        { at_minute: 9 * 60, timezone: "Asia/Shanghai", weekdays: [1, 3] },
        (key, vars) => translate("en", key, vars),
      ),
      "Weekly Mon, Wed at 09:00",
    );
  });

  it("saves an interval, a daily clock, or selected weekdays", () => {
    assert.deepEqual(
      pullTriggerFromDraft({
        schedule_mode: "interval",
        interval_ms: 90 * 60_000,
        at_minute: 9 * 60,
        weekdays: [1, 2, 3, 4, 5],
        timezone: "Asia/Shanghai",
      }),
      { kind: "pull", interval_ms: 90 * 60_000 },
    );
    assert.deepEqual(
      pullTriggerFromDraft({
        schedule_mode: "daily",
        interval_ms: 60 * 60_000,
        at_minute: 9 * 60,
        weekdays: [1, 2, 3, 4, 5],
        timezone: "Asia/Shanghai",
      }),
      {
        kind: "pull",
        interval_ms: 24 * 60 * 60 * 1000,
        at_minute: 9 * 60,
        timezone: "Asia/Shanghai",
      },
    );
    const weekly = pullTriggerFromDraft({
      schedule_mode: "weekly",
      interval_ms: 60 * 60_000,
      at_minute: 8 * 60,
      timezone: "Asia/Shanghai",
      weekdays: [5, 1],
    });
    assert.deepEqual(weekly.weekdays, [1, 5]);
    assert.equal(weekly.at_minute, 8 * 60);
  });

  it("keeps a weekly clock in an exported rule file", () => {
    const recipe: RecipeView = {
      id: "r1",
      org_id: "local",
      name: "Morning",
      match: { thread_id: "feishu:oc" },
      trigger: {
        kind: "pull",
        interval_ms: 24 * 60 * 60 * 1000,
        at_minute: 9 * 60,
        weekdays: [1, 2, 3, 4, 5],
        timezone: "Asia/Shanghai",
      },
      executor_type: "dsh",
      executor_config: {},
      can_write_back: true,
      include_context: true,
      enabled: true,
      created_at: "2026-08-27T00:00:00.000Z",
      updated_at: "2026-08-27T00:00:00.000Z",
    };
    const parsed = parseRecipeBundle(
      stringifyRecipeBundle(buildRecipeBundle([recipe], "2026-08-27T00:00:00.000Z")),
    );
    assert.equal(parsed.recipes[0]?.trigger.at_minute, 9 * 60);
    assert.deepEqual(parsed.recipes[0]?.trigger.weekdays, [1, 2, 3, 4, 5]);
    assert.equal(parsed.recipes[0]?.trigger.timezone, "Asia/Shanghai");
  });
});
