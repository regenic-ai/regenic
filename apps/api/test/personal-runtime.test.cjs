const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  contentCompactFailureOutcome,
  contentCompactScanOutcome,
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

  it("retries a finished-looking scan when embedded envelopes were skipped", () => {
    assert.equal(contentCompactScanOutcome({ rewritten: 0, failed: 2 }), "failed");
    assert.equal(contentCompactScanOutcome({ rewritten: 1, failed: 1 }), "failed");
    assert.equal(contentCompactScanOutcome({ rewritten: 0, failed: 0 }), "done");
    assert.equal(contentCompactScanOutcome({ rewritten: 3, failed: 0 }), "done");
    assert.equal(shouldRetryContentCompact(contentCompactScanOutcome({ rewritten: 0, failed: 1 })), true);
    assert.equal(shouldFinishContentCompact(contentCompactScanOutcome({ rewritten: 0, failed: 1 })), false);
  });
});
