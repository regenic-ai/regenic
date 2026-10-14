const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { after, describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("../dist/sqlite");

const roots = [];

after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function recipe(trigger) {
  return {
    id: "weekly",
    org_id: "local-owner",
    name: "Morning",
    match: { thread_id: "feishu:oc_chat" },
    trigger,
    executor_type: "dsh",
    executor_config: {},
    can_write_back: true,
    include_context: true,
    enabled: true,
    created_at: "2026-08-27T00:00:00.000Z",
    updated_at: "2026-08-27T00:00:00.000Z",
  };
}

describe("recipe pull schedule", () => {
  it("round-trips a weekly clock and clears it when the rule becomes an interval", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-recipe-"));
    roots.push(root);
    const store = new SqliteAuthorityStore(join(root, "authority.db"));
    try {
      await store.putRecipe(
        recipe({
          kind: "pull",
          interval_ms: 24 * 60 * 60 * 1000,
          at_minute: 9 * 60,
          weekdays: [1, 2, 3, 4, 5],
          timezone: "Asia/Shanghai",
        }),
      );
      const weekly = await store.getRecipe("local-owner", "weekly");
      assert.equal(weekly.trigger.kind, "pull");
      assert.equal(weekly.trigger.at_minute, 9 * 60);
      assert.equal(weekly.trigger.timezone, "Asia/Shanghai");
      assert.deepEqual(weekly.trigger.weekdays, [1, 2, 3, 4, 5]);

      await store.putRecipe(
        recipe({
          kind: "pull",
          interval_ms: 30 * 60 * 1000,
        }),
      );
      const interval = await store.getRecipe("local-owner", "weekly");
      assert.equal(interval.trigger.interval_ms, 30 * 60 * 1000);
      assert.equal(interval.trigger.at_minute, undefined);
      assert.equal(interval.trigger.timezone, undefined);
      assert.equal(interval.trigger.weekdays, undefined);
    } finally {
      store.close();
    }
  });
});
