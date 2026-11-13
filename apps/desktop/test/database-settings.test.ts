import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  databaseEnvironment,
  postgresConnection,
  storedDatabasePreference,
  switchDatabase,
  testPostgresConnection,
} from "../src/main/database-settings.ts";
import {
  loadDesktopPreference,
  saveDesktopPreference,
  saveLocalePreference,
} from "../src/main/kernel-settings.ts";

describe("database settings", () => {
  it("keeps SQLite as the legacy default and removes conflicting PostgreSQL configuration", () => {
    const env = databaseEnvironment(
      { DATABASE_URL: "postgresql://localhost/other", REGENIC_AUTHORITY_DRIVER: "postgres" },
      "/store/regenic.db", "/store/blobs", "/store",
    );
    assert.equal(env.REGENIC_AUTHORITY_DRIVER, "sqlite");
    assert.equal(env.REGENIC_DATABASE, "/store/regenic.db");
    assert.equal(env.REGENIC_BLOB_ROOT, "/store/blobs");
    assert.equal(env.DATABASE_URL, undefined);
  });

  it("uses the chosen PostgreSQL database, isolates attachments, and runs local background jobs", () => {
    const connection = postgresConnection("postgresql://user:test@localhost:5432/work");
    const env = databaseEnvironment(
      { REGENIC_DATABASE: "/store/regenic.db", REGENIC_EMBEDDING_DRIVER: "local_http" },
      "/store/regenic.db", "/store/blobs", "/store",
      { driver: "postgres", blobKey: connection.blobKey }, connection.connectionString,
    );
    assert.equal(env.REGENIC_AUTHORITY_DRIVER, "postgres");
    assert.equal(env.DATABASE_URL, connection.connectionString);
    assert.equal(env.REGENIC_DATABASE, undefined);
    assert.equal(env.REGENIC_EMBEDDING_DRIVER, "none");
    assert.equal(env.REGENIC_START_BACKGROUND, "all");
    assert.equal(env.REGENIC_BLOB_ROOT, join("/store", "postgres", connection.blobKey, "blobs"));
    assert.notEqual(env.REGENIC_BLOB_ROOT, "/store/blobs");
    assert.throws(() => databaseEnvironment({}, "", "", "/store", { driver: "postgres" }),
      /database.connectionRequired/);
  });

  it("keeps the attachment identity stable when credentials or TLS parameters change", () => {
    const first = postgresConnection("postgresql://first:test@localhost/work?sslmode=require");
    const second = postgresConnection("postgres://second:updated@localhost:5432/work");
    assert.equal(first.blobKey, second.blobKey);
    assert.equal(first.blobKey, postgresConnection("postgres://localhost/%77ork").blobKey);
    assert.notEqual(first.blobKey, postgresConnection("postgres://localhost/other").blobKey);
    assert.equal(first.label, "localhost:5432/work");
    assert.doesNotMatch(first.label, /first|test|sslmode/);
    for (const raw of [
      null, "", "file:///store/db", "https://example.com/work", "postgres://localhost",
      "postgres://localhost/work?database=other", "postgres://localhost/work?host=other",
      "postgres://user:%bad@localhost/work",
    ]) {
      assert.throws(() => postgresConnection(raw), /database.invalidConnection/);
    }
  });

  it("retains the encrypted connection and semantic preferences across other settings writes", () => {
    const root = mkdtempSync(join(tmpdir(), "regenic-database-settings-"));
    const file = join(root, "settings.json");
    try {
      const preference = {
        driver: "postgres" as const,
        encryptedConnection: "encrypted-test-value",
        connectionLabel: "localhost:5432/work",
        blobKey: postgresConnection("postgres://localhost/work").blobKey,
      };
      saveDesktopPreference(file, {
        mode: "local", locale: "en", semanticEnabled: true, database: preference,
      });
      saveLocalePreference(file, "zh");
      assert.deepEqual(loadDesktopPreference(file).database, preference);
      assert.equal(loadDesktopPreference(file).semanticEnabled, true);
      assert.doesNotMatch(readFileSync(file, "utf8"), /postgres:\/\//);
      writeFileSync(file, JSON.stringify({ database: { driver: "postgres" } }));
      assert.throws(() => loadDesktopPreference(file), /database.invalidConnection/);
      assert.throws(() => storedDatabasePreference({ driver: "unexpected" }), /database.invalidDriver/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("restores the previous selection if the new engine fails, without hiding restore errors", async () => {
    let active = "sqlite";
    const events: string[] = [];
    await assert.rejects(switchDatabase("sqlite", "postgres", {
      stop: async () => { events.push("stop"); },
      save: (value) => { active = value; events.push(`save:${value}`); },
      start: async () => {
        events.push(`start:${active}`);
        if (active === "postgres") throw new Error("startup failed");
      },
    }), /database.applyFailed/);
    assert.equal(active, "sqlite");
    assert.deepEqual(events, ["stop", "save:postgres", "start:postgres", "stop", "save:sqlite", "start:sqlite"]);

    await assert.rejects(switchDatabase("sqlite", "postgres", {
      stop: async () => {},
      save: () => {},
      start: async () => { throw new Error("unavailable"); },
    }), /database.restoreFailed/);
  });

  it("reports a connection failure without exposing connection credentials", async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    try {
      await assert.rejects(
        testPostgresConnection(`postgresql://user:test-password@127.0.0.1:${address.port}/work`),
        { message: "database.connectionFailed" },
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
