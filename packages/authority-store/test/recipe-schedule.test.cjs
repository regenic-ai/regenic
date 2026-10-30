const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { after, describe, it } = require("node:test");
const Database = require("better-sqlite3");
const { conversationId } = require("@regenic/domain");
const { SqliteAuthorityStore } = require("../dist/sqlite");
const { LATEST_SCHEMA_VERSION, MIGRATIONS } = require("../dist/sqlite/migrations");
const { PG_SCHEMA_VERSION, PG_MIGRATIONS } = require("../dist/postgres/schema");

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
  it("appends the PostgreSQL schedule migration after main's existing migrations", () => {
    assert.equal(PG_SCHEMA_VERSION, 55);
    assert.deepEqual(PG_MIGRATIONS.filter(({ version }) => version > 54), [
      {
        version: 55,
        sql: `
ALTER TABLE recipes ADD COLUMN trigger_at_minute INTEGER;
ALTER TABLE recipes ADD COLUMN trigger_weekdays TEXT;
ALTER TABLE recipes ADD COLUMN trigger_timezone TEXT;
`,
      },
    ]);
  });

  it("upgrades main's SQLite schema without losing existing recipes or tables", async () => {
    const root = await mkdtemp(join(tmpdir(), "regenic-recipe-upgrade-"));
    roots.push(root);
    const path = join(root, "authority.db");
    const legacy = new Database(path);
    try {
      legacy.function("conversation_id", (source, externalId, fallbackId) =>
        conversationId(source, externalId, fallbackId));
      for (const migration of MIGRATIONS.filter(({ version }) => version <= 53)) {
        legacy.exec(migration.sql);
        legacy.pragma(`user_version = ${migration.version}`);
      }
      legacy.prepare(`
        INSERT INTO recipes (
          id, org_id, name, match_json, executor_type, executor_config_json,
          trigger_kind, trigger_interval_ms, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("weekly", "local-owner", "Morning", "{}", "dsh", "{}",
        "pull", 30 * 60_000, "2026-08-27T00:00:00.000Z", "2026-08-27T00:00:00.000Z");
    } finally {
      legacy.close();
    }

    const store = new SqliteAuthorityStore(path);
    try {
      assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
      const saved = await store.getRecipe("local-owner", "weekly");
      assert.equal(saved.trigger.interval_ms, 30 * 60_000);
      assert.equal(saved.trigger.at_minute, undefined);
      await store.putRecipe(recipe({
        kind: "pull",
        interval_ms: 24 * 60 * 60_000,
        at_minute: 540,
        timezone: "Asia/Shanghai",
      }));
      assert.equal((await store.getRecipe("local-owner", "weekly")).trigger.at_minute, 540);
    } finally {
      store.close();
    }
    const inspect = new Database(path);
    try {
      for (const name of ["customer_service_tasks", "context_artifact_segments", "search_answers"]) {
        assert.ok(inspect.prepare("SELECT name FROM sqlite_master WHERE name = ?").get(name));
      }
      assert.deepEqual(inspect.pragma("foreign_key_check"), []);
    } finally {
      inspect.close();
    }
  });

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
