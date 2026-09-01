const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  PERSONAL_SSE_INBOX_DIGEST,
  PERSONAL_SSE_THREAD_UPDATED,
} = require("../dist/personal-events");

describe("personal SSE contract", () => {
  it("uses stable event names", () => {
    assert.equal(PERSONAL_SSE_INBOX_DIGEST, "inbox.digest");
    assert.equal(PERSONAL_SSE_THREAD_UPDATED, "thread.updated");
  });
});
