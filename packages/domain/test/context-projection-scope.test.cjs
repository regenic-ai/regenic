const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { threadProjectionGeneration } = require("../dist");

describe("context projection scope", () => {
  it("namespaces checkpoint generations per thread", () => {
    assert.equal(
      threadProjectionGeneration("continuous-v1", "feishu:oc_1"),
      "continuous-v1@thread:feishu:oc_1",
    );
  });

  it("rejects blank generation or thread ids", () => {
    assert.throws(
      () => threadProjectionGeneration("", "feishu:oc_1"),
      /requires base generation/,
    );
    assert.throws(
      () => threadProjectionGeneration("continuous-v1", "  "),
      /requires base generation/,
    );
  });
});
