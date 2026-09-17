const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { validateReview } = require("../dist");

function review(overrides = {}) {
  return {
    schema_version: "1.0",
    id: "review-1",
    org_id: "example-org",
    subject_kind: "decision",
    subject_id: "decision-1",
    result: "validated",
    severity: "normal",
    evidence: [{ kind: "document", uri_or_ref: "event:event-1" }],
    context_snapshot_id: "snapshot-1",
    recommended_action: "solidify",
    author: { actor_type: "human", actor_id: "person-1" },
    created_at: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("Review contract", () => {
  it("requires evidence and a compatible recommendation", () => {
    assert.equal(validateReview(review()).subject_kind, "decision");
    assert.throws(() => validateReview(review({ context_snapshot_id: undefined })), /Invalid Review/);
    assert.throws(() => validateReview(review({ evidence: undefined })), /Invalid Review evidence/);
    assert.throws(() => validateReview(review({ evidence: [] })), /Invalid Review evidence/);
    assert.throws(() => validateReview(review({ evidence: [{ kind: "other", uri_or_ref: "note:1" }] })), /non-other evidence/);
    assert.throws(() => validateReview(review({ result: "falsified" })), /cannot recommend solidify/);
    assert.equal(validateReview(review({
      result: "falsified",
      severity: "bad_news",
      recommended_action: "revise_standard",
    })).severity, "bad_news");
  });
});
