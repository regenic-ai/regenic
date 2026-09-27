const assert = require("node:assert/strict");
const { it } = require("node:test");
const {
  DEFAULT_PERSONAL_FOLLOW_UP_POLICY,
  validatePersonalFollowUpPolicy,
} = require("../dist");

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