const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { afterEach, describe, it } = require("node:test");
const Database = require("better-sqlite3");
const { conversationId, MemoryWorkStore } = require("@regenic/domain");
const { SqliteAuthorityStore, SqliteSplitAuthorityStore } = require("../dist/sqlite");
const { LATEST_SCHEMA_VERSION, MIGRATIONS } = require("../dist/sqlite/migrations");

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function databasePath() {
  const root = await mkdtemp(join(tmpdir(), "regenic-recipe-destination-"));
  roots.push(root);
  return join(root, "authority.db");
}

function recipe() {
  return {
    id: "destination-rule", org_id: "local-owner", name: "Result delivery",
    match: { thread_id: "test:source" }, trigger: { kind: "manual" },
    executor_type: "test", executor_config: { prompt: "Summarize updates." },
    can_write_back: true, write_back_thread_id: "test:results",
    include_context: false, enabled: true,
    created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-01T00:00:00.000Z",
  };
}

function rawDestination(path) {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare("SELECT write_back_thread_id FROM recipes WHERE id = ?")
      .get("destination-rule").write_back_thread_id;
  } finally {
    db.close();
  }
}

describe("recipe send-back destination", () => {
  for (const [name, open] of [
    ["SQLite", (path) => new SqliteAuthorityStore(path)],
    ["split SQLite worker", (path) => SqliteSplitAuthorityStore.open(path)],
  ]) {
    it(`${name} persists insert, update, unrelated edit and clear across reopen`, async () => {
      const path = await databasePath();
      let store = await open(path);
      const input = recipe();
      try {
        assert.equal((await store.putRecipe(input)).write_back_thread_id, "test:results");
        assert.equal((await store.getRecipe(input.org_id, input.id)).write_back_thread_id, "test:results");
        assert.equal(rawDestination(path), "test:results");
      } finally {
        await store.close();
      }
      for (const [patch, expected] of [
        [{}, "test:results"],
        [{ write_back_thread_id: "test:other" }, "test:other"],
        [{ name: "Renamed" }, "test:other"],
        [{ write_back_thread_id: undefined }, undefined],
      ]) {
        store = await open(path);
        try {
          const current = await store.getRecipe(input.org_id, input.id);
          await store.putRecipe({ ...current, ...patch });
          assert.equal((await store.getRecipe(input.org_id, input.id)).write_back_thread_id, expected);
          assert.equal((await store.listRecipes(input.org_id))[0].write_back_thread_id, expected);
          assert.equal(rawDestination(path), expected ?? null);
          assert.deepEqual(await store.listRecipes("another-org"), []);
        } finally {
          await store.close();
        }
      }
      store = await open(path);
      try {
        assert.equal((await store.getRecipe(input.org_id, input.id)).write_back_thread_id, undefined);
      } finally {
        await store.close();
      }
    });
  }

  for (const existingColumn of [false, true]) {
    it(`upgrades v56 with ${existingColumn ? "an existing destination column and value" : "legacy rows without a destination"}`, async () => {
      const path = await databasePath();
      const legacy = new Database(path);
      try {
        legacy.function("conversation_id", (source, externalId, fallbackId) =>
          conversationId(source, externalId, fallbackId));
        for (const migration of MIGRATIONS.filter(({ version }) => version <= 56)) {
          legacy.exec(migration.sql);
        }
        legacy.pragma("user_version = 56");
        if (existingColumn) legacy.exec("ALTER TABLE recipes ADD COLUMN write_back_thread_id TEXT");
        const input = recipe();
        legacy.prepare(`INSERT INTO recipes (
          id, org_id, name, match_json, executor_type, executor_config_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          input.id, input.org_id, input.name, JSON.stringify(input.match),
          input.executor_type, JSON.stringify(input.executor_config), input.created_at, input.updated_at,
        );
        if (existingColumn) {
          legacy.prepare("UPDATE recipes SET write_back_thread_id = ?").run("test:preserved");
        }
      } finally {
        legacy.close();
      }
      for (let reopen = 0; reopen < 2; reopen += 1) {
        const store = new SqliteAuthorityStore(path);
        try {
          assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
          const saved = await store.getRecipe("local-owner", "destination-rule");
          assert.equal(saved.write_back_thread_id, existingColumn ? "test:preserved" : undefined);
          assert.equal(saved.name, recipe().name);
          assert.deepEqual(saved.match, recipe().match);
          assert.equal(rawDestination(path), existingColumn ? "test:preserved" : null);
        } finally {
          store.close();
        }
      }
      const inspect = new Database(path);
      try {
        assert.deepEqual(inspect.pragma("foreign_key_check"), []);
      } finally {
        inspect.close();
      }
    });
  }

  it("memory store preserves and clears the optional destination", async () => {
    const store = new MemoryWorkStore();
    const input = recipe();
    await store.putRecipe(input);
    assert.equal((await store.getRecipe(input.org_id, input.id)).write_back_thread_id, input.write_back_thread_id);
    await store.putRecipe({ ...input, write_back_thread_id: undefined });
    assert.equal((await store.listRecipes(input.org_id))[0].write_back_thread_id, undefined);
  });
});
