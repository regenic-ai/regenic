const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  assertCloudWorkerBackend,
  assertSqliteSingleReplica,
  loadEnv,
  replicaCount,
  requiresBackgroundLeader,
  shouldRunInProcessContextJobs,
  shouldStartBackgroundWork,
} = require("../dist");

function sqliteEnv(extra = {}) {
  return loadEnv({
    REGENIC_AUTHORITY_DRIVER: "sqlite",
    REGENIC_DATABASE: "./regenic.db",
    REGENIC_BLOB_ROOT: "./blobs",
    ...extra,
  });
}

function postgresEnv(extra = {}) {
  return loadEnv({
    REGENIC_AUTHORITY_DRIVER: "postgres",
    DATABASE_URL: "postgres://regenic:regenic@localhost:5432/regenic",
    REGENIC_BLOB_ROOT: "./blobs",
    ...extra,
  });
}

describe("replicaCount", () => {
  it("defaults to one writer", () => {
    assert.equal(replicaCount(loadEnv({})), 1);
  });

  it("rejects a non-integer replica count", () => {
    assert.throws(
      () => replicaCount(loadEnv({ REGENIC_REPLICAS: "1.5" })),
      /positive integer/,
    );
  });
});

describe("assertSqliteSingleReplica", () => {
  it("allows a single sqlite replica", () => {
    assertSqliteSingleReplica(sqliteEnv({ REGENIC_REPLICAS: "1" }));
  });

  it("refuses sqlite scale-out", () => {
    assert.throws(
      () => assertSqliteSingleReplica(sqliteEnv({ REGENIC_REPLICAS: "2" })),
      /refuses REGENIC_REPLICAS=2/,
    );
  });

  it("does not constrain postgres replicas", () => {
    assertSqliteSingleReplica(postgresEnv({ REGENIC_REPLICAS: "3" }));
  });
});

describe("assertCloudWorkerBackend", () => {
  it("accepts postgres with a shared blob root", () => {
    assert.deepEqual(assertCloudWorkerBackend(postgresEnv()), {
      driver: "postgres",
      url: "postgres://regenic:regenic@localhost:5432/regenic",
      blobRoot: "./blobs",
    });
  });

  it("refuses sqlite", () => {
    assert.throws(
      () => assertCloudWorkerBackend(sqliteEnv()),
      /Cloud worker requires REGENIC_AUTHORITY_DRIVER=postgres/,
    );
  });
});

describe("background work flags", () => {
  it("starts personal timers by default on sqlite", () => {
    assert.equal(shouldStartBackgroundWork(sqliteEnv()), true);
    assert.equal(shouldRunInProcessContextJobs(sqliteEnv()), true);
  });

  it("keeps background enabled on postgres and moves projection off the API", () => {
    assert.equal(shouldStartBackgroundWork(postgresEnv()), true);
    assert.equal(shouldRunInProcessContextJobs(postgresEnv()), false);
  });

  it("stops every background timer when START_BACKGROUND is off", () => {
    const env = sqliteEnv({ REGENIC_START_BACKGROUND: "0" });
    assert.equal(shouldStartBackgroundWork(env), false);
    assert.equal(shouldRunInProcessContextJobs(env), false);
  });

  it("can force in-process context jobs on postgres", () => {
    const env = postgresEnv({ REGENIC_START_BACKGROUND: "all" });
    assert.equal(shouldRunInProcessContextJobs(env), true);
  });
});

describe("requiresBackgroundLeader", () => {
  it("keeps sqlite timers local", () => {
    assert.equal(requiresBackgroundLeader(sqliteEnv()), false);
    assert.equal(requiresBackgroundLeader(sqliteEnv({ REGENIC_REPLICAS: "1" })), false);
  });

  it("elects a leader for every postgres API", () => {
    assert.equal(requiresBackgroundLeader(postgresEnv()), true);
    assert.equal(requiresBackgroundLeader(postgresEnv({ REGENIC_REPLICAS: "2" })), true);
  });

  it("does not elect a leader when background work is off", () => {
    assert.equal(
      requiresBackgroundLeader(
        postgresEnv({ REGENIC_REPLICAS: "3", REGENIC_START_BACKGROUND: "0" }),
      ),
      false,
    );
  });
});
