const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { processSyncMetrics } = require("@regenic/domain");
const { HealthController } = require("../dist/health.controller");
const { sqliteWalBytes } = require("../dist/process-memory");

function controller() {
  return new HealthController(
    {
      isReady: () => true,
      probeAuthority: async () => true,
    },
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

describe("GET /metrics", () => {
  it("exposes process sync metrics and memory", () => {
    processSyncMetrics.clear();
    processSyncMetrics.record({
      name: "work_queue_lag_ms",
      value: 12,
      labels: { lane: "live" },
    });
    const body = controller().metrics();
    assert.equal(typeof body.generated_at, "string");
    assert.ok(body.memory.rss_bytes > 0);
    assert.equal(body.metrics[0].name, "work_queue_lag_ms");
    assert.equal(body.metrics[0].last, 12);
    assert.equal(body.readiness.freshness_source, "none");
    assert.equal(body.readiness.eta, null);
    processSyncMetrics.clear();
  });

  it("omits sqlite wal bytes on postgres", () => {
    assert.equal(
      sqliteWalBytes({
        REGENIC_AUTHORITY_DRIVER: "postgres",
        REGENIC_DATABASE: "./regenic.db",
      }),
      null,
    );
  });
});
