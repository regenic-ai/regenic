const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { advancePushReconcileCursor, pushReconcileStart, watermarkAgeMs } = require("../dist");

describe("push reconcile rotation", () => {
  it("visits each install once per cycle when a tick checks two", () => {
    const ids = ["a", "b", "c", "d", "e"];
    let cursor = 0;
    const seen = [];
    for (let tick = 0; tick < ids.length; tick += 1) {
      const start = pushReconcileStart(ids.length, cursor);
      const batch = [0, 1].map((offset) => ids[(start + offset) % ids.length]);
      seen.push(...batch);
      cursor = advancePushReconcileCursor(ids.length, cursor, batch.length);
    }
    assert.deepEqual(seen, ["a", "b", "c", "d", "e", "a", "b", "c", "d", "e"]);
    assert.equal(cursor, 0);
  });

  it("resumes at the install a tick did not reach", () => {
    assert.equal(advancePushReconcileCursor(4, 0, 1), 1);
    assert.equal(advancePushReconcileCursor(4, 3, 2), 1);
    assert.equal(advancePushReconcileCursor(0, 3, 2), 0);
    assert.equal(pushReconcileStart(4, -1), 3);
  });
});

describe("watermark age", () => {
  it("measures durable lag and omits a missing watermark", () => {
    assert.equal(
      watermarkAgeMs("2026-11-16T00:00:00.000Z", Date.parse("2026-11-16T00:00:04.000Z")),
      4_000,
    );
    assert.equal(watermarkAgeMs(undefined), undefined);
    assert.equal(watermarkAgeMs("not-a-time"), undefined);
  });
});
