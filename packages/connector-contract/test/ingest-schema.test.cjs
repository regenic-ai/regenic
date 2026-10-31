const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { z } = require("zod");
const {
  INGEST_SCHEMA_VERSION,
  IngestRecordSchema,
  JsonValueSchema,
  SendNotAcceptedError,
  validateIngestBatch,
} = require("../dist");

function batch() {
  return {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "test",
    org_id: "org",
    delivery_id: "delivery",
    received_at: "2026-10-31T10:00:00+08:00",
    records: [{
      operation: "create",
      source: "test",
      external_id: "event",
      occurred_at: "2026-10-31T02:00:00Z",
      actor: { id: "actor" },
      scope: { id: "scope" },
      type: "message",
      content: [{ role: "body", media_type: "text/plain", text: "" }],
      attrs: { nested: [null, true, 1.5, "text", { child: [false] }] },
    }],
  };
}

describe("Zod 4 ingest compatibility", () => {
  it("preserves recursive JSON, offset dates, identifiers and content variants", () => {
    const input = batch();
    input.delivery_id = " delivery ";
    input.records[0].content.push(
      {
        role: "attachment",
        media_type: "application/octet-stream",
        bytes: new Uint8Array([1, 2, 3]),
        external_locator: "source://bytes",
      },
      { role: "transcript", media_type: "text/plain", text: "transcript" },
      { role: "metadata", media_type: "application/pdf", external_locator: "source://pdf" },
    );
    assert.deepEqual(validateIngestBatch(input), { success: true, data: input });
    assert.equal(JsonValueSchema.safeParse({ nested: [Infinity] }).success, false);
  });

  it("keeps envelope and record classification with serializable issue paths", () => {
    const input = batch();
    input.records[0].actor.id = " ";
    assert.deepEqual(validateIngestBatch(input), {
      success: false,
      error_code: "invalid_record",
      issues: [{ path: ["records", 0, "actor", "id"], message: "String cannot be blank" }],
    });
    assert.equal(validateIngestBatch({ ...batch(), records: [] }).error_code, "invalid_envelope");
    assert.equal(validateIngestBatch({ ...batch(), schema_version: "2.0" }).error_code, "invalid_envelope");
  });

  it("rejects invalid dates, strict unknown fields and mixed content sources", () => {
    for (const timestamp of ["2026-02-30T00:00:00Z", "2026-10-31T02:00:00", "invalid"]) {
      const input = batch();
      input.records[0].occurred_at = timestamp;
      const result = validateIngestBatch(input);
      assert.equal(result.error_code, "invalid_record");
      assert.deepEqual(result.issues[0].path, ["records", 0, "occurred_at"]);
    }
    for (const mutate of [
      (input) => { input.records[0].unknown = true; },
      (input) => { input.records[0].content[0].bytes = new Uint8Array([1]); },
      (input) => { input.records[0].attrs.nested.push(undefined); },
    ]) {
      const input = batch();
      mutate(input);
      assert.equal(validateIngestBatch(input).error_code, "invalid_record");
    }
    assert.equal(validateIngestBatch({ ...batch(), unknown: true }).error_code, "invalid_envelope");
  });

  it("rejects oversized bounded collections before parsing their elements", () => {
    let visits = 0;
    const bounded = z.array(IngestRecordSchema.refine(() => {
      visits += 1;
      return true;
    })).max(2);
    const input = batch().records[0];
    assert.equal(bounded.safeParse([input, input]).success, true);
    assert.equal(visits, 2);
    visits = 0;
    const result = bounded.safeParse([input, input, input]);
    assert.equal(result.success, false);
    assert.equal(result.error.issues.length, 1);
    assert.equal(visits, 0);
  });

  it("re-exports the same contract error class", () => {
    assert.equal(SendNotAcceptedError, require("../dist/driver").SendNotAcceptedError);
  });
});
