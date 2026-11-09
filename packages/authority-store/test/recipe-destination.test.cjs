const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const Database = require("better-sqlite3");
const { Client } = require("pg");
const { MemoryWorkStore, conversationId } = require("@regenic/domain");
const { SqliteAuthorityStore, SqliteSplitAuthorityStore } = require("../dist/sqlite");
const { PostgresAuthorityStore } = require("../dist/postgres");
const { LATEST_SCHEMA_VERSION, MIGRATIONS } = require("../dist/sqlite/migrations");
const { PG_SCHEMA_VERSION, PG_MIGRATIONS, PG_BASELINE_SQL } = require("../dist/postgres/schema");

const NOW = "2026-11-09T08:00:00.000Z";
const ORG = "owner";

function recipe(overrides = {}) {
  return {
    id: "rule", org_id: ORG, name: "Handle work",
    match: { record_class: "task" }, trigger: { kind: "push" },
    executor_type: "test", executor_config: { prompt: "Handle the task." },
    can_write_back: true, include_context: false, enabled: true,
    created_at: NOW, updated_at: NOW, ...overrides,
  };
}

async function openPostgres(t, beforeOpen) {
  const admin = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  const schema = `s${randomUUID().replaceAll("-", "")}`;
  let store;
  t.after(async () => {
    try {
      await store?.close();
    } finally {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  await beforeOpen?.(admin);
  const url = new URL(process.env.TEST_DATABASE_URL.trim());
  url.searchParams.set("options", `-csearch_path=${schema}`);
  store = await PostgresAuthorityStore.open(url.toString());
  return store;
}

const drivers = [
  { name: "memory", open: async () => new MemoryWorkStore() },
  { name: "sqlite", open: async (_, path) => new SqliteAuthorityStore(path) },
  { name: "sqlite writer RPC", open: async (_, path) => SqliteSplitAuthorityStore.open(path) },
  {
    name: "postgres", skip: !process.env.TEST_DATABASE_URL?.trim(),
    open: (t) => openPostgres(t),
  },
];

for (const driver of drivers) {
  describe(`${driver.name} recipe destination`, { skip: driver.skip }, () => {
    it("preserves, replaces and clears the destination in reads and lists", async (t) => {
      const root = await mkdtemp(join(tmpdir(), "regenic-recipe-target-"));
      let store;
      t.after(async () => {
        try {
          if (driver.name !== "postgres") await store?.close?.();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      });
      store = await driver.open(t, join(root, "authority.db"));
      await store.putRecipe(recipe());
      assert.equal((await store.getRecipe(ORG, "rule")).write_back_thread_id, undefined);
      for (const can_write_back of [true, false]) {
        for (const destination of ["source:results", "removed:previous-target"]) {
          await store.putRecipe(recipe({ can_write_back, write_back_thread_id: destination }));
          const saved = await store.getRecipe(ORG, "rule");
          assert.equal(saved.write_back_thread_id, destination);
          assert.equal(saved.can_write_back, can_write_back);
          assert.equal((await store.listRecipes(ORG))[0].write_back_thread_id, destination);
          await store.putRecipe({ ...saved, name: "Renamed" });
          assert.equal((await store.getRecipe(ORG, "rule")).write_back_thread_id, destination);
          assert.equal(await store.getRecipe("other-owner", "rule"), null);
          assert.deepEqual(await store.listRecipes("other-owner"), []);
        }
      }
      await store.putRecipe(recipe());
      assert.equal((await store.getRecipe(ORG, "rule")).write_back_thread_id, undefined);
      assert.equal((await store.listRecipes(ORG))[0].write_back_thread_id, undefined);
    });
  });
}

describe("recipe destination migrations", () => {
  it("adds the same nullable column to both schemas without backfilling guessed targets", () => {
    assert.ok(LATEST_SCHEMA_VERSION >= 56);
    assert.ok(PG_SCHEMA_VERSION >= 56);
    const sql = "ALTER TABLE recipes ADD COLUMN write_back_thread_id TEXT;";
    assert.equal(MIGRATIONS.find(({ version }) => version === 56).sql, sql);
    assert.equal(PG_MIGRATIONS.find(({ version }) => version === 56).sql, sql);
    assert.match(PG_BASELINE_SQL, /write_back_thread_id TEXT/);
  });

  it("upgrades SQLite v55 and preserves destinations across direct and writer restarts", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "regenic-recipe-target-upgrade-"));
    const path = join(root, "authority.db");
    let store;
    t.after(async () => {
      try {
        await store?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
    const legacy = new Database(path);
    try {
      legacy.function("conversation_id", (source, externalId, fallbackId) =>
        conversationId(source, externalId, fallbackId));
      for (const migration of MIGRATIONS.filter(({ version }) => version <= 55)) {
        legacy.exec(migration.sql);
      }
      legacy.pragma("user_version = 55");
      legacy.prepare(`
        INSERT INTO recipes (
          id, org_id, name, match_json, executor_type, executor_config_json,
          can_write_back, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("rule", ORG, "Handle work", "{}", "test", "{}", 1, NOW, NOW);
    } finally {
      legacy.close();
    }
    store = new SqliteAuthorityStore(path);
    assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
    const historical = await store.getRecipe(ORG, "rule");
    assert.equal(historical.write_back_thread_id, undefined);
    assert.equal(historical.can_write_back, true);
    assert.equal(historical.created_at, NOW);
    await store.putRecipe(recipe({ write_back_thread_id: "source:results" }));
    await store.close();
    store = undefined;
    store = await SqliteSplitAuthorityStore.open(path);
    assert.equal((await store.getRecipe(ORG, "rule")).write_back_thread_id, "source:results");
    await store.putRecipe(recipe({ can_write_back: false, write_back_thread_id: "removed:old-room" }));
    await store.close();
    store = undefined;
    store = new SqliteAuthorityStore(path);
    assert.equal((await store.getRecipe(ORG, "rule")).write_back_thread_id, "removed:old-room");
    assert.equal((await store.getRecipe(ORG, "rule")).can_write_back, false);
    await store.putRecipe(recipe());
    await store.close();
    store = undefined;
    store = new SqliteAuthorityStore(path);
    assert.equal((await store.getRecipe(ORG, "rule")).write_back_thread_id, undefined);
    const inspect = new Database(path, { readonly: true });
    try {
      assert.deepEqual(inspect.pragma("foreign_key_check"), []);
      assert.equal(inspect.prepare("SELECT write_back_thread_id FROM recipes").get().write_back_thread_id, null);
    } finally {
      inspect.close();
    }
  });

  it("upgrades PostgreSQL v55 without inventing a historical destination", {
    skip: !process.env.TEST_DATABASE_URL?.trim(),
  }, async (t) => {
    const store = await openPostgres(t, async (db) => {
      const historicalSchema = PG_BASELINE_SQL
        .replace("  write_back_thread_id TEXT,\n", "")
        .replace("  write_back_required BOOLEAN,\n", "")
        .replace("  trigger_kind TEXT CHECK (trigger_kind IN ('push', 'pull', 'manual')),\n", "")
        .replace("  write_back_target_json JSONB,\n", "")
        .replace("CREATE UNIQUE INDEX work_runs_org_id_idx ON work_runs (org_id, id);\n", "")
        .replace("  run_id TEXT,\n  target_json JSONB,\n", "")
        .replace("  lease_owner TEXT,\n  claim_token TEXT,\n  cancel_requested_at TIMESTAMPTZ,\n", "")
        .replace("  FOREIGN KEY (org_id, run_id) REFERENCES work_runs(org_id, id)", "  UNIQUE (org_id, work_item_id)")
        .replace("CREATE UNIQUE INDEX work_deliveries_run_idx ON work_deliveries (org_id, run_id) WHERE run_id IS NOT NULL;\n", "")
        .replace("CREATE UNIQUE INDEX work_deliveries_legacy_item_idx ON work_deliveries (org_id, work_item_id) WHERE run_id IS NULL;\n", "")
        .replace("CREATE INDEX work_deliveries_item_idx ON work_deliveries (org_id, work_item_id, created_at, id);\n", "")
        .replace("ALTER TABLE work_items ADD COLUMN current_run_id TEXT REFERENCES work_runs(id) DEFERRABLE INITIALLY DEFERRED;\n", "")
        .replace("ALTER TABLE work_items ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0);\n", "")
        .replace("ALTER TABLE work_runs ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0);\n", "");
      await db.query(historicalSchema);
      await db.query("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)");
      await db.query("INSERT INTO schema_migrations VALUES (55, $1)", [NOW]);
      await db.query(`
        INSERT INTO recipes (
          id, org_id, name, match_json, executor_type, executor_config_json,
          can_write_back, created_at, updated_at
        ) VALUES ('rule', $1, 'Handle work', '{}', 'test', '{}', TRUE, $2, $2)
      `, [ORG, NOW]);
    });
    assert.equal((await store.getRecipe(ORG, "rule")).write_back_thread_id, undefined);
    await store.putRecipe(recipe({ write_back_thread_id: "source:results" }));
    assert.equal((await store.getRecipe(ORG, "rule")).write_back_thread_id, "source:results");
  });
});
