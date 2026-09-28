const assert = require("node:assert/strict");
const { it } = require("node:test");
const {
  DEFAULT_PERSONAL_FOLLOW_UP_POLICY,
  followUpScanSince,
  validatePersonalFollowUpPolicy,
} = require("../dist");

it("scans one day beyond the follow-up wait", () => {
  assert.equal(
    followUpScanSince({ wait_minutes: 60 }, "2026-09-26T12:00:00.000Z"),
    "2026-09-25T11:00:00.000Z",
  );
  assert.equal(
    followUpScanSince({ wait_minutes: 3 * 24 * 60 }, "2026-09-26T12:00:00.000Z"),
    "2026-09-22T12:00:00.000Z",
  );
});

it("validates a versioned personal follow-up policy", () => {
  assert.deepEqual(
    validatePersonalFollowUpPolicy(DEFAULT_PERSONAL_FOLLOW_UP_POLICY),
    DEFAULT_PERSONAL_FOLLOW_UP_POLICY,
  );
  assert.throws(
    () => validatePersonalFollowUpPolicy({
      ...DEFAULT_PERSONAL_FOLLOW_UP_POLICY,
      wait_minutes: 5,
    }),
    /Invalid personal follow-up policy/,
  );
  assert.throws(
    () => validatePersonalFollowUpPolicy({
      ...DEFAULT_PERSONAL_FOLLOW_UP_POLICY,
      include_initial_outbound: "yes",
    }),
    /Invalid personal follow-up policy/,
  );
});