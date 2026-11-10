const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { it } = require("node:test");
const { Client } = require("pg");
const { PostgresAuthorityStore } = require("../dist/postgres");
const { PG_BASELINE_SQL, PG_SCHEMA_VERSION, PG_MIGRATIONS } = require("../dist/postgres/schema");
const { putRecipe, getRecipe, listRecipes } = require("../dist/postgres/work");

const connectionString = process.env.TEST_DATABASE_URL?.trim();
const now = "2026-09-01T00:00:00.000Z";
const input = {
  id: "destination-rule", org_id: "test-org", name: "Result delivery",
  match: { thread_id: "test:source" }, trigger: { kind: "manual" },
  executor_type: "test", executor_config: {}, can_write_back: true,
  write_back_thread_id: "test:results", include_context: false, enabled: true,
  created_at: now, updated_at: now,
};

it("includes the PostgreSQL destination in schema, upsert bindings and read mappings (SQL contract only)", async () => {
  assert.equal(PG_SCHEMA_VERSION, 57);
  assert.match(PG_BASELINE_SQL, /write_back_thread_id TEXT/);
  assert.match(PG_MIGRATIONS.find(({ version }) => version === 57).sql,
    /ADD COLUMN IF NOT EXISTS write_back_thread_id TEXT/);
  for (const destination of ["test:results", undefined]) {
    let statement;
    let args;
    const row = {
      ...input, match_json: input.match, executor_config_json: input.executor_config,
      trigger_kind: "manual", write_back_thread_id: destination ?? null,
    };
    const sql = {
      execute: async (text, values) => { statement = text; args = values; },
      queryOne: async () => row,
      query: async () => [row],
    };
    await putRecipe(sql, { ...input, write_back_thread_id: destination });
    const columns = statement.match(/INSERT INTO recipes \(([\s\S]*?)\)\s*VALUES/)[1]
      .split(",").map((column) => column.trim());
    assert.equal(args[columns.indexOf("write_back_thread_id")], destination ?? null);
    assert.equal(args.length, columns.length);
    assert.match(statement, /write_back_thread_id = EXCLUDED.write_back_thread_id/);
    assert.equal((await getRecipe(sql, input.org_id, input.id)).write_back_thread_id, destination);
    assert.equal((await listRecipes(sql, input.org_id))[0].write_back_thread_id, destination);
  }
});

for (const legacy of [undefined, false, true]) {
  it(`PostgreSQL real database round-trip: ${legacy === undefined ? "fresh schema" : `v56, existing column=${legacy}`}`, {
    skip: !connectionString && "TEST_DATABASE_URL is not set; real PostgreSQL was not verified",
  }, async () => {
    const schema = `recipe_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString });
    let store;
    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      await admin.query(`SET search_path TO ${schema}`);
      if (legacy !== undefined) {
        await admin.query(PG_BASELINE_SQL.replace("  write_back_thread_id TEXT,\n", ""));
        await admin.query("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)");
        await admin.query("INSERT INTO schema_migrations VALUES (56, $1)", [now]);
        await admin.query(`INSERT INTO recipes (
          id, org_id, name, match_json, executor_type, executor_config_json, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [input.id, input.org_id, input.name, input.match, input.executor_type, input.executor_config, now, now]);
        if (legacy) {
          await admin.query("ALTER TABLE recipes ADD COLUMN write_back_thread_id TEXT");
          await admin.query("UPDATE recipes SET write_back_thread_id = 'test:preserved'");
        }
      }
      const url = new URL(connectionString);
      url.searchParams.set("options", `-csearch_path=${schema}`);
      store = await PostgresAuthorityStore.open(url.toString());
      if (legacy !== undefined) {
        const saved = await store.getRecipe(input.org_id, input.id);
        assert.equal(saved.write_back_thread_id, legacy ? "test:preserved" : undefined);
        assert.equal(saved.name, input.name);
        assert.deepEqual(saved.match, input.match);
      }
      await store.putRecipe(input);
      for (const [patch, expected] of [
        [{}, "test:results"],
        [{ write_back_thread_id: "test:other" }, "test:other"],
        [{ name: "Unrelated edit" }, "test:other"],
        [{ write_back_thread_id: undefined }, undefined],
      ]) {
        const saved = await store.getRecipe(input.org_id, input.id);
        await store.putRecipe({ ...saved, ...patch });
        await store.close();
        store = await PostgresAuthorityStore.open(url.toString());
        assert.equal((await store.getRecipe(input.org_id, input.id)).write_back_thread_id, expected);
        assert.equal((await store.listRecipes(input.org_id))[0].write_back_thread_id, expected);
        assert.equal((await admin.query("SELECT write_back_thread_id FROM recipes WHERE id = $1", [input.id]))
          .rows[0].write_back_thread_id, expected ?? null);
      }
    } finally {
      if (store) await store.close();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
}
