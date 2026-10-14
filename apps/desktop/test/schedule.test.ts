import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRecipeBundle,
  parseRecipeBundle,
  stringifyRecipeBundle,
} from "../src/renderer/src/recipe-transfer.ts";
import { pullTriggerFromDraft, scheduleCopy } from "../src/renderer/src/schedule.ts";
import { translate } from "../src/shared/messages.ts";
import type { RecipeView } from "../src/renderer/src/types.ts";

const zh = (
  key: Parameters<typeof translate>[1],
  vars?: Record<string, string | number>,
) => translate("zh", key, vars);

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
