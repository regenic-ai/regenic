const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  CONNECTOR_INVOCATION_PROTOCOL,
  assertConnectorRequestEnvelope,
  assertConnectorResponseEnvelope,
  assertConnectorStreamDescriptor,
} = require("../dist");

describe("connector invocation contract", () => {
  it("accepts a serializable poll request and response", () => {
    const request = {
      protocol: CONNECTOR_INVOCATION_PROTOCOL,
      kind: "poll",
      context: {
        request_id: "request-1",
        installation_id: "install-1",
        connector_type: "fake",
        deadline_at: "2026-09-21T00:00:30.000Z",
        cancellation_id: "cancel-1",
        idempotency_key: "install-1:stream-1:1",
      },
      payload: {
        stream: {
          stream_key: "stream-1",
          thread_id: "fake:1",
          binding: { remote_id: "1" },
        },
        cursor: "opaque",
      },
    };
    const response = {
      protocol: CONNECTOR_INVOCATION_PROTOCOL,
      request_id: "request-1",
      ok: true,
      result: {
        batch: { records: [] },
        next_cursor: "next",
        poll_hint: { live_seeded: true },
      },
    };

    assert.doesNotThrow(() => assertConnectorRequestEnvelope(request));
    assert.doesNotThrow(() => assertConnectorResponseEnvelope(response));
    assert.deepEqual(JSON.parse(JSON.stringify(request)), request);
  });

  it("rejects callback-bearing stream descriptors", () => {
    assert.throws(
      () =>
        assertConnectorStreamDescriptor({
          stream_key: "stream-1",
          binding: { poll() {} },
        }),
      /JSON serializable/,
    );
  });

  it("rejects unsupported protocol versions", () => {
    assert.throws(
      () =>
        assertConnectorRequestEnvelope({
          protocol: "2.0",
          kind: "poll",
          context: {},
          payload: {},
        }),
      /Unsupported connector protocol/,
    );
  });
});
