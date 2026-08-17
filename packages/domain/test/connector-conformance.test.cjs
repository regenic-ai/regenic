const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ConnectorConformanceError,
  INGEST_SCHEMA_VERSION,
  verifyPollConnectorConformance,
} = require("../dist");

function batch(overrides = {}) {
  return {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "fixture-connector",
    org_id: "local-owner",
    delivery_id: "page-1",
    received_at: new Date().toISOString(),
    next_cursor: "cursor-2",
    records: [{
      operation: "create",
      source: "fixture",
      external_id: "message-1",
      occurred_at: "2026-08-17T00:00:00.000Z",
      actor: { id: "user-1" },
      scope: { id: "scope-1" },
      type: "message",
      content: [{ role: "body", media_type: "text/plain", text: "Body" }],
    }],
    ...overrides,
  };
}

function connector(results) {
  let index = 0;
  return {
    async poll() {
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return result;
    },
  };
}

const input = {
  cursor: null,
  connector_id: "fixture-connector",
  source: "fixture",
};

describe("verifyPollConnectorConformance", () => {
  it("accepts a canonical stable page while ignoring received_at", async () => {
    const first = batch();
    const replay = { ...batch(), received_at: "2026-08-17T00:01:00.000Z" };
    const report = await verifyPollConnectorConformance({
      ...input,
      connector: connector([
        { batch: first, next_cursor: "cursor-2" },
        { batch: replay, next_cursor: "cursor-2" },
      ]),
    });

    assert.deepEqual(report, { delivery_id: "page-1", record_count: 1, next_cursor: "cursor-2" });
  });

  it("rejects mismatched batch/result cursors", async () => {
    await assert.rejects(
      () => verifyPollConnectorConformance({
        ...input,
        connector: connector([{ batch: batch(), next_cursor: "different" }]),
      }),
      ConnectorConformanceError,
    );
  });

  it("rejects duplicate source identities in one page", async () => {
    const duplicate = batch();
    duplicate.records.push({ ...duplicate.records[0] });
    await assert.rejects(
      () => verifyPollConnectorConformance({
        ...input,
        connector: connector([{ batch: duplicate, next_cursor: "cursor-2" }]),
      }),
      ConnectorConformanceError,
    );
  });
});