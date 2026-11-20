const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  parseRow,
  statistics,
} = require("./conversation-scale.bench.cjs");

describe("conversation scale benchmark", () => {
  it("accepts privacy-minimized normalized rows", () => {
    assert.deepEqual(
      parseRow(JSON.stringify({
        id: "wildchat1m:000000001:000",
        conversation_index: 1,
        message_index: 0,
        role: "user",
        text: "How do I debug this?",
        language: "English",
      }), 1),
      {
        id: "wildchat1m:000000001:000",
        conversation_index: 1,
        message_index: 0,
        role: "user",
        text: "How do I debug this?",
        language: "English",
      },
    );
  });

  it("rejects source-linkable and fingerprinting metadata", () => {
    for (const field of [
      "conversation_hash",
      "country",
      "hashed_ip",
      "header",
      "state",
      "timestamp",
      "turn_identifier",
    ]) {
      assert.throws(
        () => parseRow(JSON.stringify({
          id: "message",
          conversation_index: 0,
          message_index: 0,
          role: "user",
          text: "private",
          [field]: "forbidden",
        }), 1),
        new RegExp(`forbidden field ${field}`),
      );
    }
  });

  it("reports nearest-rank latency percentiles", () => {
    assert.deepEqual(statistics([5, 1, 4, 2, 3]), {
      samples: 5,
      mean_ms: 3,
      p50_ms: 3,
      p95_ms: 5,
      p99_ms: 5,
      max_ms: 5,
    });
  });
});
