const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  searchAnswerCitations,
} = require("../dist/personal-search-answer.service");

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
