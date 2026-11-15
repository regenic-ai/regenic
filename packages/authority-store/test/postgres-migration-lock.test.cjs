const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { migratePostgresAuthority } = require("../dist/postgres/migrate");
const { PG_BASELINE_SQL, PG_SCHEMA_VERSION } = require("../dist/postgres/schema");

describe("PostgreSQL projection migration", () => {
  it("includes the blob reference catalog in the fresh-install baseline", () => {
    assert.match(PG_BASELINE_SQL, /CREATE TABLE blobs \([\s\S]*state TEXT NOT NULL DEFAULT 'protected'/);
    assert.match(PG_BASELINE_SQL, /CREATE TABLE blob_references \(/);
    assert.match(PG_BASELINE_SQL, /reference_kind IN \('body', 'attachment', 'artifact_body', 'evidence', 'reply_recovery'\)/);
  });

  it("applies the blob reference migration after schema version 71", async () => {
    let version = 71;
    const statements = [];
    const client = {
      async query(sql, params) {
        statements.push(sql.trim());
        if (sql.includes("SELECT COALESCE(MAX(version)")) return { rows: [{ version }] };
        if (sql.includes("INSERT INTO schema_migrations")) version = params[0];
        return { rows: [] };
      },
      release() {},
    };
    await migratePostgresAuthority({ async connect() { return client; } });
    assert.equal(version, PG_SCHEMA_VERSION);
    assert.ok(statements.some((sql) => sql.includes("ALTER TABLE blobs ADD COLUMN state")));
    assert.ok(statements.some((sql) => sql.includes("CREATE TABLE blob_references")));
    assert.ok(statements.some((sql) => sql.includes("'reply_recovery'")));
    assert.ok(statements.some((sql) => sql.includes("FROM outbound_attempts WHERE recovery_hash IS NOT NULL")));
    assert.ok(statements.some((sql) => sql.includes("LOCK TABLE events, blob_references, blobs")));
    assert.ok(statements.some((sql) => sql.includes("SELECT org_id, 'event', id, 'body', content_hash, ingested_at")));
    assert.ok(statements.some((sql) => sql.includes("LOCK TABLE context_artifacts, blobs, blob_references")));
    assert.ok(statements.some((sql) => sql.includes("'artifact_body'")));
    assert.ok(statements.some((sql) => sql.includes("'evidence'")));
  });

  it("serializes concurrent startup before reading the schema version", async () => {
    let version = 69;
    let held = false;
    let unblock;
    let updates = 0;
    const makeClient = () => ({
      async query(sql, params) {
        if (sql.includes("regenic-authority-migration")) {
          if (held) await new Promise((resolve) => { unblock = resolve; });
          held = true;
        } else if (sql.includes("SELECT COALESCE(MAX(version)")) {
          return { rows: [{ version }] };
        } else if (sql.startsWith("UPDATE thread_heads")) {
          updates += 1;
        } else if (sql.includes("INSERT INTO schema_migrations")) {
          version = params[0];
        } else if (sql === "COMMIT" || sql === "ROLLBACK") {
          held = false;
          unblock?.();
        }
        return { rows: [] };
      },
      release() {},
    });
    const pool = { async connect() { return makeClient(); } };
    await Promise.all([migratePostgresAuthority(pool), migratePostgresAuthority(pool)]);
    assert.equal(version, PG_SCHEMA_VERSION);
    assert.equal(updates, 1);
  });

  for (const fail of [null, "migration lock", "lock", "update"]) {
    it(fail ? `rolls back if the ${fail} fails` : "locks projection inputs before repairing them", async () => {
      const queries = [];
      const error = new Error("lock failed");
      let released = false;
      const client = {
        async query(sql) {
          queries.push(sql.trim());
          if (sql.includes("SELECT COALESCE(MAX(version)")) return { rows: [{ version: 69 }] };
          if (fail === "migration lock" && sql.includes("regenic-authority-migration")) throw error;
          if (fail === "lock" && sql.startsWith("LOCK TABLE")) throw error;
          if (fail === "update" && sql.startsWith("UPDATE thread_heads")) throw error;
          return { rows: [] };
        },
        release() { released = true; },
      };
      const run = migratePostgresAuthority({ async connect() { return client; } });
      if (fail) {
        await assert.rejects(run, (actual) => actual === error);
        assert.ok(queries.includes("ROLLBACK"));
        assert.ok(!queries.some((sql) => sql.startsWith("INSERT INTO schema_migrations")));
        if (fail === "lock" || fail === "migration lock") {
          assert.ok(!queries.some((sql) => sql.startsWith("UPDATE thread_heads")));
        }
      } else {
        await run;
        const migrationLock = queries.findIndex((sql) => sql.includes("regenic-authority-migration"));
        const versionRead = queries.findIndex((sql) => sql.includes("SELECT COALESCE(MAX(version)"));
        const lock = queries.findIndex((sql) => sql.startsWith("LOCK TABLE"));
        const update = queries.findIndex((sql) => sql.startsWith("UPDATE thread_heads"));
        const version = queries.findIndex((sql) => sql.startsWith("INSERT INTO schema_migrations"));
        assert.ok(migrationLock >= 0 && migrationLock < versionRead);
        assert.ok(lock >= 0 && lock < update && update < version);
        assert.match(queries[lock], /events, source_heads, message_dispositions, thread_heads IN SHARE ROW EXCLUSIVE MODE/);
        assert.equal(queries.at(-1), "COMMIT");
      }
      assert.equal(released, true);
    });
  }
});
