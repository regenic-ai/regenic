const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  contentCompactFailureOutcome,
  shouldFinishContentCompact,
  shouldRetryContentCompact,
} = require("../dist/personal-runtime.service");

describe("content compact outcomes", () => {
  it("retries after a transient compact failure instead of finishing", () => {
    assert.equal(
      contentCompactFailureOutcome(new Error("blob read failed"), false),
      "failed",
    );
    assert.equal(shouldRetryContentCompact("failed"), true);
    assert.equal(shouldFinishContentCompact("failed"), false);
    assert.equal(shouldRetryContentCompact("paused"), true);
    assert.equal(shouldFinishContentCompact("done"), true);
  });

  it("stops compact when the write worker closed or the run was aborted", () => {
    assert.equal(
      contentCompactFailureOutcome(
        new Error("Authority write worker closed"),
        false,
      ),
      "aborted",
    );
    assert.equal(
      contentCompactFailureOutcome(new Error("blob read failed"), true),
      "aborted",
    );
    assert.equal(shouldRetryContentCompact("aborted"), false);
    assert.equal(shouldFinishContentCompact("aborted"), false);
  });
});
