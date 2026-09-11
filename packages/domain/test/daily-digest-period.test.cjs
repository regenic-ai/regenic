const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { dailyDigestPeriod, localDateAt } = require("../dist");

describe("daily digest local periods", () => {
  it("maps UTC timestamps into the configured local calendar date", () => {
    assert.equal(localDateAt("2026-09-07T16:30:00.000Z", "Asia/Shanghai"), "2026-09-08");
    assert.equal(localDateAt("2026-09-07T02:30:00.000Z", "America/New_York"), "2026-09-06");
  });

  it("uses DST-safe UTC bounds for a local day", () => {
    const spring = dailyDigestPeriod("2026-03-08", "America/New_York");
    const fall = dailyDigestPeriod("2026-11-01", "America/New_York");
    assert.deepEqual(spring, {
      local_date: "2026-03-08", time_zone: "America/New_York",
      utc_start: "2026-03-08T05:00:00.000Z", utc_end: "2026-03-09T04:00:00.000Z",
    });
    assert.deepEqual(fall, {
      local_date: "2026-11-01", time_zone: "America/New_York",
      utc_start: "2026-11-01T04:00:00.000Z", utc_end: "2026-11-02T05:00:00.000Z",
    });
  });
});
