import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import {
  databaseEnvironment,
  postgresConnection,
  startDatabaseRuntime,
  storedDatabasePreference,
  switchDatabase,
  testPostgresConnection,
  type DatabasePreference,
} from "../src/main/database-settings.ts";
import {
  loadDesktopPreference,
  saveDesktopPreference,
  saveLocalePreference,
} from "../src/main/kernel-settings.ts";
import { SemanticRuntime } from "../src/main/semantic-runtime.ts";

async function postgresFixture(
  context: TestContext,
  onQuery: (socket: Socket) => void,
  allowHalfOpen = false,
) {
  const sockets = new Set<Socket>();
  let receivedQuery: () => void;
  let receivedTerminate: () => void;
  const query = new Promise<void>((resolve) => { receivedQuery = resolve; });
  const terminate = new Promise<void>((resolve) => { receivedTerminate = resolve; });
  const server = createServer({ allowHalfOpen }, (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", () => {
      socket.on("data", (message) => {
        if (message[0] === 81) {
          receivedQuery();
          onQuery(socket);
        } else if (message[0] === 88) {
          receivedTerminate();
        }
      });
      socket.write(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73]));
    });
  });
  context.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    connectionString: `postgresql://user:test-password@127.0.0.1:${address.port}/work?sslmode=disable`,
    query,
    terminate,
  };
}

function completeQuery(socket: Socket): void {
  socket.write(Buffer.concat([
    Buffer.from([67, 0, 0, 0, 13]),
    Buffer.from("SELECT 1\0"),
    Buffer.from([90, 0, 0, 0, 5, 73]),
  ]));
}

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

  it("allows switching and rolling back to SQLite when the semantic installation is unavailable", async () => {
    const root = mkdtempSync(join(tmpdir(), "regenic-database-semantic-"));
    try {
      const semantic = new SemanticRuntime({ root, assets: join(root, "assets") });
      let active: DatabasePreference = { driver: "postgres" };
      const starts: string[] = [];
      const errors: unknown[] = [];
      const hooks = {
        stop: () => semantic.stop(),
        save: (database: DatabasePreference) => { active = database; },
        start: () => startDatabaseRuntime({
          database: active,
          semanticEnabled: true,
          startSemantic: () => semantic.start(),
          onSemanticError: (error) => { errors.push(error); },
          startKernel: async () => {
            starts.push(active.driver);
            if (active.driver === "postgres") throw new Error("kernel unavailable");
          },
        }),
      };
      await switchDatabase(active, { driver: "sqlite" }, hooks);
      assert.equal(active.driver, "sqlite");
      await assert.rejects(switchDatabase(active, { driver: "postgres" }, hooks), /database.applyFailed/);
      assert.equal(active.driver, "sqlite");
      assert.deepEqual(starts, ["sqlite", "postgres", "sqlite"]);
      assert.equal(errors.length, 2);
      for (const error of errors) {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "semantic.installFirst");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports disconnects during the query without an unhandled client error", async (context) => {
    const fixture = await postgresFixture(context, (socket) => socket.destroy());
    await assert.rejects(testPostgresConnection(fixture.connectionString),
      { message: "database.connectionFailed" });
  });

  it("bounds stalled queries even when the connection URL overrides both timeouts", { timeout: 10_000 }, async (context) => {
    const fixture = await postgresFixture(context, () => {});
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const result = assert.rejects(testPostgresConnection(
      `${fixture.connectionString}&query_timeout=600000&statement_timeout=0`,
    ), { message: "database.connectionFailed" });
    await fixture.query;
    context.mock.timers.tick(10_000);
    await result;
  });

  it("bounds connection cleanup after a successful query", { timeout: 10_000 }, async (context) => {
    const fixture = await postgresFixture(context, completeQuery, true);
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const result = assert.rejects(testPostgresConnection(fixture.connectionString),
      { message: "database.connectionFailed" });
    await fixture.terminate;
    context.mock.timers.tick(10_000);
    await result;
  });

  it("bounds a stalled TLS handshake without exposing a transport error", { timeout: 10_000 }, async (context) => {
    const sockets = new Set<Socket>();
    let receivedHandshake: () => void;
    const handshake = new Promise<void>((resolve) => { receivedHandshake = resolve; });
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("data", () => {
        socket.once("data", () => receivedHandshake());
        socket.write("S");
      });
    });
    context.after(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const result = assert.rejects(testPostgresConnection(
      `postgresql://user:test-password@127.0.0.1:${address.port}/work?sslmode=require`,
    ), { message: "database.connectionFailed" });
    await handshake;
    context.mock.timers.tick(10_000);
    await result;
  });

  it("accepts a completed query and closes the connection", async (context) => {
    const fixture = await postgresFixture(context, completeQuery);
    await testPostgresConnection(fixture.connectionString);
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
