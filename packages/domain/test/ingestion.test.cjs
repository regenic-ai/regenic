const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  INGEST_SCHEMA_VERSION,
  validateIngestBatch,
} = require("../dist");

function createBatch(overrides = {}) {
  return {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "native-local",
    org_id: "local-owner",
    delivery_id: "delivery-1",
    received_at: "2026-08-08T00:00:00.000Z",
    records: [
      {
        operation: "create",
        source: "regenic",
        external_id: "event-1",
        occurred_at: "2026-08-07T23:59:00.000Z",
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "text",
        content: [
          {
            role: "body",
            media_type: "text/plain",
            text: "A canonical ingest fixture.",
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe("validateIngestBatch", () => {
  it("accepts a canonical create batch", () => {
    const batch = createBatch();
    const result = validateIngestBatch(batch);

    assert.equal(result.success, true);
    assert.deepEqual(result.success && result.data, batch);
  });

  it("accepts bytes, text, and external locator content variants", () => {
    const batch = createBatch();
    batch.records[0].content = [
      { role: "body", media_type: "text/plain", text: "body" },
      {
        role: "attachment",
        media_type: "application/octet-stream",
        bytes: new Uint8Array([1, 2, 3]),
      },
      {
        role: "attachment",
        media_type: "application/pdf",
        external_locator: "source://document/1",
      },
    ];

    assert.equal(validateIngestBatch(batch).success, true);
  });

  it("accepts revision and tombstone operations", () => {
    const batch = createBatch();
    batch.records = [
      {
        ...batch.records[0],
        operation: "revise",
        revision_id: "revision-2",
      },
      {
        ...batch.records[0],
        operation: "tombstone",
        external_id: "event-2",
        content: undefined,
      },
    ];

    assert.equal(validateIngestBatch(batch).success, true);
  });

  it("does not normalize source identifiers while validating", () => {
    const batch = createBatch({ delivery_id: " delivery-1 " });
    const result = validateIngestBatch(batch);

    assert.equal(result.success, true);
    assert.equal(result.success && result.data.delivery_id, " delivery-1 ");
  });

  it("rejects unsupported envelope versions with a stable error code", () => {
    const result = validateIngestBatch(createBatch({ schema_version: "2.0" }));

    assert.equal(result.success, false);
    assert.equal(result.error_code, "invalid_envelope");
  });

  it("rejects malformed records with a stable error code", () => {
    const batch = createBatch();
    batch.records[0].occurred_at = "not-a-timestamp";
    const result = validateIngestBatch(batch);

    assert.equal(result.success, false);
    assert.equal(result.error_code, "invalid_record");
    assert.deepEqual(result.issues[0].path, ["records", 0, "occurred_at"]);
  });

  it("rejects content parts with more than one content source", () => {
    const batch = createBatch();
    batch.records[0].content[0].bytes = new Uint8Array([1]);
    const result = validateIngestBatch(batch);

    assert.equal(result.success, false);
    assert.equal(result.error_code, "invalid_record");
  });

  it("rejects unknown fields instead of silently accepting source payload", () => {
    const batch = createBatch();
    batch.records[0].raw_payload = "must not cross the canonical boundary";
    const result = validateIngestBatch(batch);

    assert.equal(result.success, false);
    assert.equal(result.error_code, "invalid_record");
  });
});