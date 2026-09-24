const assert = require("node:assert/strict");
const { it } = require("node:test");
const {
  DEFAULT_PERSONAL_DISPATCH_POLICY,
  validatePersonalDispatchPolicy,
} = require("../dist");

it("validates a versioned personal dispatch policy", () => {
  assert.deepEqual(
    validatePersonalDispatchPolicy(DEFAULT_PERSONAL_DISPATCH_POLICY),
    DEFAULT_PERSONAL_DISPATCH_POLICY,
  );
  assert.throws(
    () => validatePersonalDispatchPolicy({
      ...DEFAULT_PERSONAL_DISPATCH_POLICY,
      actionable_disposition: "defer",
    }),
    /Invalid personal dispatch policy/,
  );
});
