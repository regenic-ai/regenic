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
    can_write_back: true, hide_on_success: false, include_context: false, enabled: true,
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
          assert.equal(saved.hide_on_success, false);
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
  for (const driver of drivers.filter((entry) => entry.name.startsWith("sqlite"))) {
    for (const schema of [58, 77, "pre-merge-77"]) {
      it(`${driver.name} repairs ${schema} active retries without guessing ambiguous runs or delivery obligations`, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "regenic-lifecycle-upgrade-"));
        const path = join(root, "authority.db");
        let store;
        t.after(async () => {
          try { await store?.close(); }
          finally { await rm(root, { recursive: true, force: true }); }
        });
        const db = new Database(path);
        const preMerge = schema === "pre-merge-77";
        const cases = [
          { id: "retry", status: "running", runs: ["failed", "running"], expected: "retry-1" },
          { id: "waiting", status: "waiting_human", runs: ["failed", "waiting_human"], expected: "waiting-1" },
          { id: "ambiguous", status: "running", runs: ["running", "running"] },
          { id: "terminal", status: "done", runs: ["failed", "completed"] },
        ];
        try {
          db.function("conversation_id", (source, externalId, fallbackId) =>
            conversationId(source, externalId, fallbackId));
          for (const migration of MIGRATIONS.filter(({ version }) =>
            version <= (schema === 58 ? 58 : 77) && (!preMerge || ![59, 60].includes(version)))) {
            db.exec(migration.sql);
          }
          db.prepare(`INSERT INTO recipes (
            id, org_id, name, match_json, executor_type, executor_config_json,
            can_write_back, hide_on_success, created_at, updated_at
          ) VALUES ('rule', ?, 'Historical rule', '{}', 'test', '{}', 0, 0, ?, ?)`).run(ORG, NOW, NOW);
          const item = db.prepare(`INSERT INTO work_items (
            id, org_id, thread_id, unit_key, record_class, thread_facet, status, recipe_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'task', 'ticket', ?, 'rule', ?, ?)`);
          const run = db.prepare(`INSERT INTO work_runs (
            id, org_id, work_item_id, recipe_id, executor_type, status, start_state, external_run_id, created_at, updated_at
          ) VALUES (?, ?, ?, 'rule', 'test', ?, 'submitted', ?, ?, ?)`);
          for (const entry of cases) {
            item.run(entry.id, ORG, `source:${entry.id}`, entry.id, entry.status, NOW, NOW);
            entry.runs.forEach((status, index) =>
              run.run(`${entry.id}-${index}`, ORG, entry.id, status, `external-${entry.id}-${index}`, NOW, NOW));
          }
          if (schema === 77) {
            item.run("bound", ORG, "source:bound", "bound", "running", NOW, NOW);
            run.run("bound-run", ORG, "bound", "running", "external-bound", NOW, NOW);
            db.prepare("UPDATE work_items SET current_run_id = 'bound-run', version = 4 WHERE id = 'bound'").run();
            item.run("changed", ORG, "source:changed", "changed", "running", NOW, NOW);
            run.run("changed-run", ORG, "changed", "running", "external-changed", NOW, NOW);
            db.prepare("UPDATE work_items SET version = 4 WHERE id = 'changed'").run();
          }
          db.prepare(`INSERT INTO work_deliveries (
            id, org_id, work_item_id, recipe_id, kind, unit_key, status, write_back,
            attempts, payload_json, idempotency_key, created_at, updated_at
          ) VALUES ('delivery', ?, 'retry', 'rule', 'result', 'retry', 'queued', 'pending',
            2, '{"text":"Preserve payload"}', 'stable-delivery', ?, ?)`).run(ORG, NOW, NOW);
          if (schema !== 58) {
            db.prepare(`UPDATE work_deliveries SET version = 3, lease_owner = 'existing-owner',
              claim_token = 'existing-token', lease_expires_at = '2026-11-10T00:00:00.000Z',
              cancel_requested_at = ? WHERE id = 'delivery'`).run(NOW);
          }
          db.pragma(`user_version = ${schema === 58 ? 58 : 77}`);
        } finally { db.close(); }
        if (preMerge) {
          const blocked = new Database(path);
          try { blocked.exec("CREATE TABLE work_deliveries_repaired (id TEXT)"); }
          finally { blocked.close(); }
          await assert.rejects(async () => { store = await driver.open(t, path); }, /already exists/);
          const rolledBack = new Database(path);
          try {
            assert.equal(rolledBack.pragma("user_version", { simple: true }), 77);
            assert.equal(rolledBack.pragma("table_info(work_items)")
              .some((column) => column.name === "current_run_id"), false);
            assert.equal(rolledBack.prepare("SELECT COUNT(*) AS count FROM work_deliveries").get().count, 1);
            rolledBack.exec("DROP TABLE work_deliveries_repaired");
          } finally { rolledBack.close(); }
        }
        store = await driver.open(t, path);
        for (const entry of cases) {
          assert.equal((await store.getWorkItem(ORG, entry.id)).current_run_id, entry.expected);
          assert.equal((await store.getActiveWorkRun(ORG, entry.id))?.id, entry.expected);
          for (const run of await store.listWorkRuns(ORG, entry.id)) {
            assert.equal(run.completion_policy_version, undefined);
            assert.equal(run.hide_on_success, undefined);
            assert.equal(run.write_back_required, undefined);
            assert.equal(run.trigger_kind, undefined);
          }
        }
        await store.summarizeInbox(ORG);
        await store.listInbox(ORG, { heads: true });
        const inspect = new Database(path, { readonly: true });
        try {
          assert.equal(inspect.pragma("user_version", { simple: true }), LATEST_SCHEMA_VERSION);
          assert.deepEqual(inspect.pragma("foreign_key_check"), []);
          const delivery = inspect.prepare("SELECT * FROM work_deliveries WHERE id = 'delivery'").get();
          assert.equal(delivery.payload_json, '{"text":"Preserve payload"}');
          assert.equal(delivery.idempotency_key, "stable-delivery");
          assert.equal(delivery.attempts, 2);
          assert.equal(delivery.run_id, null);
          assert.equal(delivery.target_json, null);
          assert.equal(delivery.version, schema === 58 ? 0 : 3);
          if (schema !== 58) {
            assert.equal(delivery.lease_owner, "existing-owner");
            assert.equal(delivery.claim_token, "existing-token");
            assert.equal(delivery.cancel_requested_at, NOW);
          }
          if (schema === 77) {
            assert.equal((await store.getWorkItem(ORG, "bound")).current_run_id, "bound-run");
            assert.equal((await store.getWorkItem(ORG, "changed")).current_run_id, undefined);
          }
        } finally { inspect.close(); }
        await store.close();
        store = await driver.open(t, path);
        assert.equal((await store.getActiveWorkRun(ORG, "retry")).id, "retry-1");
        await store.summarizeInbox(ORG);
      });
    }
  }

  it("rejects unrecognized partial lifecycle schemas without stamping a successful upgrade", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "regenic-partial-lifecycle-"));
    const path = join(root, "authority.db");
    t.after(() => rm(root, { recursive: true, force: true }));
    const db = new Database(path);
    try {
      db.function("conversation_id", (source, externalId, fallbackId) =>
        conversationId(source, externalId, fallbackId));
      for (const migration of MIGRATIONS.filter(({ version }) => version <= 77)) db.exec(migration.sql);
      db.exec("ALTER TABLE work_items DROP COLUMN current_run_id");
      db.pragma("user_version = 77");
    } finally { db.close(); }
    assert.throws(() => new SqliteAuthorityStore(path), /Unrecognized lifecycle schema/);
    const inspect = new Database(path, { readonly: true });
    try {
      assert.equal(inspect.pragma("user_version", { simple: true }), 77);
      assert.equal(inspect.pragma("table_info(work_items)").some((column) => column.name === "current_run_id"), false);
    } finally { inspect.close(); }
  });

  it("upgrades shipped SQLite schema 58 without losing its hide setting or active run", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "regenic-shipped-schema-"));
    const path = join(root, "authority.db");
    let store;
    t.after(async () => {
      try { await store?.close(); }
      finally { await rm(root, { recursive: true, force: true }); }
    });
    const db = new Database(path);
    try {
      db.function("conversation_id", (source, externalId, fallbackId) =>
        conversationId(source, externalId, fallbackId));
      for (const migration of MIGRATIONS.filter(({ version }) => version <= 58)) db.exec(migration.sql);
      db.prepare(`INSERT INTO recipes (
        id, org_id, name, match_json, executor_type, executor_config_json,
        can_write_back, hide_on_success, created_at, updated_at
      ) VALUES ('shipped-rule', ?, 'Keep visible', '{}', 'test', '{}', 0, 0, ?, ?)`).run(ORG, NOW, NOW);
      db.prepare(`INSERT INTO work_items (
        id, org_id, thread_id, unit_key, record_class, thread_facet, status, recipe_id, created_at, updated_at
      ) VALUES ('shipped-work', ?, 'source:shipped', 'unit', 'task', 'ticket', 'running', 'shipped-rule', ?, ?)`)
        .run(ORG, NOW, NOW);
      db.prepare(`INSERT INTO work_runs (
        id, org_id, work_item_id, recipe_id, executor_type, status, start_state, external_run_id, created_at, updated_at
      ) VALUES ('shipped-run', ?, 'shipped-work', 'shipped-rule', 'test', 'running', 'submitted', 'external-shipped', ?, ?)`)
        .run(ORG, NOW, NOW);
      db.pragma("user_version = 58");
    } finally { db.close(); }
    store = new SqliteAuthorityStore(path);
    assert.equal(store.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.equal((await store.getRecipe(ORG, "shipped-rule")).hide_on_success, false);
    assert.equal((await store.getWorkItem(ORG, "shipped-work")).current_run_id, "shipped-run");
    const run = await store.getWorkRun(ORG, "shipped-run");
    assert.equal(run.external_run_id, "external-shipped");
    assert.equal(run.start_state, "submitted");
    assert.equal(run.completion_policy_version, undefined);
    assert.equal(run.hide_on_success, undefined);
    assert.deepEqual(await store.listWorkDeliveries(ORG), []);
  });

  it("adds the same nullable column to both schemas without backfilling guessed targets", () => {
    assert.ok(LATEST_SCHEMA_VERSION >= 56);
    assert.ok(PG_SCHEMA_VERSION >= 56);
    const sql = "ALTER TABLE recipes ADD COLUMN write_back_thread_id TEXT;";
    assert.match(MIGRATIONS.find(({ version }) => version === 57).sql, /ADD COLUMN write_back_thread_id TEXT/);
    assert.match(PG_MIGRATIONS.find(({ version }) => version === 57).sql, /ADD COLUMN IF NOT EXISTS write_back_thread_id TEXT/);
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
        .replace(/CREATE TABLE conversation_lifecycle_events \([\s\S]*?CREATE UNIQUE INDEX conversation_lifecycle_events_command_unique_idx[\s\S]*?;\n/, "")
        .replace(/CREATE TABLE conversation_lifecycle_jobs \([\s\S]*?CREATE INDEX conversation_lifecycle_jobs_org_idx[\s\S]*?;\n/, "")
        .replace(
          "  state TEXT NOT NULL DEFAULT 'protected'\n    CHECK (state IN ('reserved', 'available', 'deleting', 'protected')),\n  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),\n  write_lease_owner TEXT,\n  write_claim_token TEXT,\n  write_lease_expires_at TIMESTAMPTZ,\n  unreferenced_at TIMESTAMPTZ,\n  gc_claim_token TEXT,\n  gc_started_at TIMESTAMPTZ\n",
          "",
        )
        .replace(
          "  created_at TIMESTAMPTZ NOT NULL,\n);\n\nCREATE INDEX blobs_gc_candidate_idx",
          "  created_at TIMESTAMPTZ NOT NULL\n);\n\nCREATE INDEX blobs_gc_candidate_idx",
        )
        .replace("CREATE INDEX blobs_gc_candidate_idx\n  ON blobs (state, unreferenced_at, content_hash);\n", "")
        .replace(/CREATE TABLE blob_references \([\s\S]*?CREATE INDEX blob_references_owner_idx[\s\S]*?;\n/, "")
        .replace("  write_back_thread_id TEXT,\n", "")
        .replace("  write_back_required BOOLEAN,\n", "")
        .replace("  trigger_kind TEXT CHECK (trigger_kind IN ('push', 'pull', 'manual')),\n", "")
        .replace("  write_back_target_json JSONB,\n", "")
        .replace("  executor_config_json JSONB,\n  include_context BOOLEAN,\n", "")
        .replace("CREATE UNIQUE INDEX work_runs_org_id_idx ON work_runs (org_id, id);\n", "")
        .replace("  lease_claim_token TEXT,\n", "")
        .replace(
          "  hidden_reason TEXT,\n  visibility_version INTEGER NOT NULL DEFAULT 0 CHECK (visibility_version >= 0),\n",
          "  hidden_reason TEXT,\n",
        )
        .replace(
          "  event_id TEXT PRIMARY KEY REFERENCES events(id),\n  org_id TEXT NOT NULL,\n  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),\n",
          "  event_id TEXT PRIMARY KEY REFERENCES events(id),\n  org_id TEXT NOT NULL,\n",
        )
        .replace(
          "  work_item_id TEXT NOT NULL REFERENCES work_items(id),\n  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),\n  recipe_id TEXT NOT NULL,\n",
          "  work_item_id TEXT NOT NULL REFERENCES work_items(id),\n  recipe_id TEXT NOT NULL,\n",
        )
        .replace("  run_id TEXT,\n  target_json JSONB,\n", "")
        .replace("  lease_owner TEXT,\n  claim_token TEXT,\n  cancel_requested_at TIMESTAMPTZ,\n", "")
        .replace("  FOREIGN KEY (org_id, run_id) REFERENCES work_runs(org_id, id)", "  UNIQUE (org_id, work_item_id)")
        .replace("CREATE UNIQUE INDEX work_deliveries_run_idx ON work_deliveries (org_id, run_id) WHERE run_id IS NOT NULL;\n", "")
        .replace("CREATE UNIQUE INDEX work_deliveries_legacy_item_idx ON work_deliveries (org_id, work_item_id) WHERE run_id IS NULL;\n", "")
        .replace("CREATE INDEX work_deliveries_item_idx ON work_deliveries (org_id, work_item_id, created_at, id);\n", "")
        .replace("ALTER TABLE work_items ADD COLUMN current_run_id TEXT REFERENCES work_runs(id) DEFERRABLE INITIALLY DEFERRED;\n", "")
        .replace("ALTER TABLE work_items ADD COLUMN acknowledged_run_id TEXT REFERENCES work_runs(id) DEFERRABLE INITIALLY DEFERRED;\n", "")
        .replace("ALTER TABLE work_items ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0);\n", "")
        .replace("ALTER TABLE work_items ADD COLUMN visibility_intent_version INTEGER NOT NULL DEFAULT 0 CHECK (visibility_intent_version >= 0);\n", "")
        .replace("ALTER TABLE work_runs ADD COLUMN version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0);\n", "");
      assert.doesNotMatch(historicalSchema, /CREATE TABLE conversation_lifecycle_(events|jobs)/);
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
