const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { HealthController } = require("../dist/health.controller");

function controller(runtime) {
  return new HealthController(
    runtime,
    {
      expectedKey: () => null,
      keySource: () => "none",
      pairingState: () => ({ reason: "closed" }),
    },
    {
      snapshot: () => ({ open: false, code: null, expires_at: null }),
    },
    {
      pressureView: () => ({
        level: "ok",
        interactive_ready: true,
        throttle_history: false,
        throttle_media: false,
      }),
    },
  );
}

describe("postgres /health probe", () => {
  it("reports postgres down when the live authority ping fails", async () => {
    const previous = { ...process.env };
    process.env.REGENIC_AUTHORITY_DRIVER = "postgres";
    process.env.DATABASE_URL = "postgres://regenic:regenic@127.0.0.1:5432/regenic";
    process.env.REGENIC_BLOB_ROOT = "/tmp/regenic-health-probe";
    delete process.env.REGENIC_DATABASE;
    delete process.env.REGENIC_PERSONAL_API;
    try {
      const health = await controller({
        isReady: () => true,
        probeAuthority: async () => false,
      }).health();
      assert.equal(health.postgres, "down");
      assert.equal(health.authority, "authority-postgres");
      assert.equal(health.status, "degraded");
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, previous);
    }
  });

  it("reports postgres up only when ready and the live probe succeeds", async () => {
    const previous = { ...process.env };
    process.env.REGENIC_AUTHORITY_DRIVER = "postgres";
    process.env.DATABASE_URL = "postgres://regenic:regenic@127.0.0.1:5432/regenic";
    process.env.REGENIC_BLOB_ROOT = "/tmp/regenic-health-probe";
    delete process.env.REGENIC_DATABASE;
    delete process.env.REGENIC_PERSONAL_API;
    try {
      const health = await controller({
        isReady: () => true,
        probeAuthority: async () => true,
      }).health();
      assert.equal(health.postgres, "up");
      assert.equal(health.authority, "authority-postgres");
      assert.equal(health.status, "ok");
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, previous);
    }
  });
});
