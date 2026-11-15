const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  searchAnswerCitations,
  searchAnswerMapBatchRefs,
} = require("../dist/personal-search-answer.service");
const {
  adaptiveMapBatchOffsets,
  mapBatchMessageLine,
} = require("../dist/personal-conversation-context.service");

describe("search answer citations", () => {
  it("prefers structured executor evidence and uses bracket refs as fallback", () => {
    assert.deepEqual(
      searchAnswerCitations(
        "Alice replied [1], Bob is unknown [2], and [9] is invalid.",
        ["event-1", "event-2", "event-3"],
        ["event-3", "event-outside", "event-1"],
      ),
      [
        { ref: 3, event_id: "event-3" },
        { ref: 1, event_id: "event-1" },
        { ref: 2, event_id: "event-2" },
      ],
    );
  });
});

describe("adaptive aggregate map batches", () => {
  it("splits on rendered evidence characters before 100 messages", () => {
    const messages = Array.from({ length: 70 }, (_, index) => ({
      occurred_at: "2026-08-30T00:00:00.000Z",
      source: "synthetic-chat",
      text: `${index}-${"x".repeat(3_995)}`,
      ...(index === 0
        ? { attachments: [{ media_type: "application/pdf", filename: "brief.pdf" }] }
        : {}),
    }));
    const offsets = adaptiveMapBatchOffsets(messages);
    assert.ok(offsets[1] < 100);
    assert.ok(offsets.length > 2);
    for (let batch = 0; batch < offsets.length - 1; batch += 1) {
      const evidence = messages
        .slice(offsets[batch], offsets[batch + 1])
        .map((message, index) => mapBatchMessageLine(message, index))
        .join("\n");
      assert.ok(evidence.length <= 120_000);
      assert.ok(offsets[batch + 1] - offsets[batch] <= 100);
    }
    assert.match(mapBatchMessageLine(messages[0], 0), /\[attachment: brief\.pdf\]/);
  });

  it("uses persisted offsets when slicing a resumed batch", () => {
    const eventIds = Array.from({ length: 150 }, (_, index) => `event-${index}`);
    const map = {
      strategy: "map_reduce",
      phase: "mapping",
      snapshot_id: "snapshot-1",
      batch_offsets: [0, 37, 91, 150],
      total_batches: 3,
      completed_batches: 1,
      facts: [],
    };
    assert.deepEqual(
      searchAnswerMapBatchRefs(eventIds, map, map.completed_batches),
      eventIds.slice(37, 91),
    );
  });
});
