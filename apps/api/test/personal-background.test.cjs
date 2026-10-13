const assert = require("node:assert/strict");
const { describe, it, afterEach } = require("node:test");
const { startPersonalBackgroundWork } = require("../dist/personal-background");

const ENV_KEYS = [
  "REGENIC_AUTHORITY_DRIVER",
  "REGENIC_DATABASE",
  "REGENIC_BLOB_ROOT",
  "DATABASE_URL",
  "REGENIC_START_BACKGROUND",
  "REGENIC_REPLICAS",
];

const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous[key];
    }
  }
});

function fakeApp() {
  const started = [];
  const stopped = [];
  const services = new Map();
  return {
    started,
    stopped,
    get(token) {
      const name = typeof token === "function" ? token.name : String(token);
      let service = services.get(name);
      if (!service) {
        service = {
          startAfterListen() {
            started.push(name);
          },
          stopBackground() {
            stopped.push(name);
          },
          ensureMounted() {
            started.push(`mount:${name}`);
            return Promise.resolve();
          },
        };
        services.set(name, service);
      }
      return service;
    },
  };
}

function grantedLease() {
  return {
    async tryAcquire() {
      return true;
    },
    async held() {
      return true;
    },
    async release() {},
  };
}

function sharedAdvisoryLock() {
  let holder = null;
  return (name) => ({
    async tryAcquire() {
      if (holder === null || holder === name) {
        holder = name;
        return true;
      }
      return false;
    },
    async held() {
      return holder === name;
    },
    async release() {
      if (holder === name) {
        holder = null;
      }
    },
  });
}

describe("startPersonalBackgroundWork", { concurrency: 1 }, () => {
  it("keeps projection on the sqlite API", () => {
    process.env.REGENIC_AUTHORITY_DRIVER = "sqlite";
    process.env.REGENIC_DATABASE = "./regenic.db";
    process.env.REGENIC_BLOB_ROOT = "./blobs";
    delete process.env.REGENIC_START_BACKGROUND;
    const app = fakeApp();
    startPersonalBackgroundWork(app);
    assert.ok(app.started.includes("PersonalContextProjectionService"));
    assert.ok(app.started.includes("PersonalDailyDigestService"));
    assert.ok(app.started.includes("PersonalConnectorService"));
  });

  it("moves projection and digest off the postgres API", async () => {
    process.env.REGENIC_AUTHORITY_DRIVER = "postgres";
    process.env.DATABASE_URL = "postgres://regenic:regenic@localhost:5432/regenic";
    process.env.REGENIC_BLOB_ROOT = "./blobs";
    delete process.env.REGENIC_START_BACKGROUND;
    const app = fakeApp();
    const leader = startPersonalBackgroundWork(app, {
      lease: grantedLease(),
      leaderRetryMs: 0,
    });
    assert.deepEqual(app.started, ["KernelRuntimeService", "PersonalRuntimeService"]);
    await leader.tick();
    assert.ok(!app.started.includes("PersonalContextProjectionService"));
    assert.ok(!app.started.includes("PersonalDailyDigestService"));
    assert.ok(app.started.includes("PersonalConnectorService"));
    await leader.stop();
  });

  it("stops connector timers when START_BACKGROUND is off", () => {
    process.env.REGENIC_AUTHORITY_DRIVER = "sqlite";
    process.env.REGENIC_DATABASE = "./regenic.db";
    process.env.REGENIC_BLOB_ROOT = "./blobs";
    process.env.REGENIC_START_BACKGROUND = "0";
    const app = fakeApp();
    startPersonalBackgroundWork(app);
    assert.deepEqual(app.started, ["KernelRuntimeService", "PersonalRuntimeService"]);
  });

  it("starts timers on one postgres replica and leaves the other HTTP-only", async () => {
    process.env.REGENIC_AUTHORITY_DRIVER = "postgres";
    process.env.DATABASE_URL = "postgres://regenic:regenic@localhost:5432/regenic";
    process.env.REGENIC_BLOB_ROOT = "./blobs";
    process.env.REGENIC_REPLICAS = "2";
    delete process.env.REGENIC_START_BACKGROUND;
    const open = sharedAdvisoryLock();
    const leaderLease = open("a");
    const leaderApp = fakeApp();
    const followerApp = fakeApp();
    const leader = startPersonalBackgroundWork(leaderApp, {
      lease: leaderLease,
      leaderRetryMs: 0,
    });
    const follower = startPersonalBackgroundWork(followerApp, {
      lease: open("b"),
      leaderRetryMs: 0,
    });
    assert.deepEqual(leaderApp.started, [
      "KernelRuntimeService",
      "PersonalRuntimeService",
    ]);
    assert.deepEqual(followerApp.started, [
      "KernelRuntimeService",
      "PersonalRuntimeService",
    ]);

    await leader.tick();
    await follower.tick();
    assert.ok(leaderApp.started.includes("PersonalConnectorService"));
    assert.ok(leaderApp.started.includes("PersonalWorkService"));
    assert.ok(!leaderApp.started.includes("PersonalContextProjectionService"));
    assert.ok(!followerApp.started.includes("PersonalConnectorService"));

    await leaderLease.release();
    await leader.tick();
    assert.ok(leaderApp.stopped.includes("PersonalConnectorService"));
    assert.ok(leaderApp.stopped.includes("PersonalWorkService"));
    await follower.tick();
    assert.ok(followerApp.started.includes("PersonalConnectorService"));
    assert.ok(followerApp.started.includes("PersonalWorkService"));
    await leader.stop();
    await follower.stop();
  });
});
