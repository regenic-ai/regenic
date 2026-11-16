const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  PUSH_INGEST_MAX_EVENTS,
  sanitizeConnectorLimits,
  validateConnectorLimits,
  validatePushIngestBatch,
} = require("../dist");

const record = {
  operation: "create",
  source: "fake",
  external_id: "m-1",
  occurred_at: "2026-11-16T00:00:00.000Z",
  actor: { id: "user" },
  scope: { id: "personal" },
  type: "message",
  content: [{ role: "body", media_type: "text/plain", text: "hi" }],
};

describe("push ingest envelope", () => {
  it("accepts a stream batch with an opaque watermark", () => {
    const result = validatePushIngestBatch({
      stream_key: "chat-1",
      batch_id: "b-1",
      events: [record],
      watermark: "opaque",
    });
    assert.equal(result.success, true);
    assert.equal(
      validatePushIngestBatch({ ...result.data, media_pending: true }).success,
      true,
    );
    assert.equal(
      validatePushIngestBatch({ stream_key: "s", events: [record], media_pending: "yes" }).success,
      false,
    );
  });

  it("separates envelope issues from record issues", () => {
    const envelope = validatePushIngestBatch({ stream_key: "", events: [record], extra: 1 });
    assert.equal(envelope.success, false);
    assert.equal(envelope.error_code, "invalid_envelope");
    const bad = validatePushIngestBatch({ stream_key: "s", events: [{ ...record, actor: {} }] });
    assert.equal(bad.success, false);
    assert.equal(bad.error_code, "invalid_record");
  });

  it("caps batch size", () => {
    const events = Array.from({ length: PUSH_INGEST_MAX_EVENTS + 1 }, (_, index) => ({
      ...record,
      external_id: `m-${index}`,
    }));
    assert.equal(validatePushIngestBatch({ stream_key: "s", events }).success, false);
  });
});

describe("connector limits", () => {
  it("validates runtime adjustments strictly", () => {
    assert.equal(validateConnectorLimits({ max_concurrency: 2, page_size: 100 }).success, true);
    assert.equal(validateConnectorLimits({}).success, true);
    assert.equal(validateConnectorLimits({ max_concurrency: 0 }).success, false);
    assert.equal(validateConnectorLimits({ rate: { tokens: 1 } }).success, false);
    assert.equal(validateConnectorLimits({ burst: 3 }).success, false);
  });

  it("sanitizes declarations field by field", () => {
    assert.deepEqual(
      sanitizeConnectorLimits({ max_concurrency: 4, page_size: 5_000, rate: { tokens: 10, window_ms: 60_000 } }),
      { max_concurrency: 4, rate: { tokens: 10, window_ms: 60_000 } },
    );
    assert.equal(sanitizeConnectorLimits({ page_size: -1 }), undefined);
    assert.equal(sanitizeConnectorLimits(undefined), undefined);
  });
});
