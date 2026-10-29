const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  WORK_EVIDENCE_AFTER_CURRENT,
  WORK_EVIDENCE_GAP,
  WORK_EVIDENCE_OMITTED,
  composeWorkConversation,
  packThreadEvidence,
  rankThreadEvidenceLines,
  selectContextIndexes,
} = require("../dist");

function candidate(index, speaker, text, extra = {}) {
  return {
    event_id: `e${index}`,
    source: "chat",
    external_id: `customer-a:${index}`,
    speaker,
    text,
    ...extra,
  };
}

function thread() {
  return [
    candidate(0, "owner", "上次确认小王和小李，共 2 位。"),
    ...Array.from({ length: 30 }, (_, index) => candidate(index + 1, "customer", `f${index}`)),
    candidate(31, "customer", "上次选中的 2 位都还没回复吗？", {
      parent_external_id: "customer-a:0",
      occurred_at: "2026-10-22T04:01:00.000Z",
    }),
    ...Array.from({ length: 8 }, (_, index) => candidate(index + 32, "owner", `l${index}`)),
  ];
}

describe("work context selection", () => {
  it("ranks seeds, reply chains, then neighbors by distance", () => {
    const events = thread().map((item) => ({
      id: item.event_id, source: item.source, external_id: item.external_id,
      parent_external_id: item.parent_external_id,
    }));
    const selection = selectContextIndexes(events, ["e31"], {
      before: 2, after: 1, replyDepth: 8, maxMessages: 4,
    });
    assert.deepEqual(selection.ranked, [31, 0, 30, 32, 29]);
    assert.deepEqual(selection.indexes, [0, 30, 31, 32]);
    assert.equal(selection.reasons.get(0), "reply_target");
    assert.equal(selection.truncated, true);
  });

  it("keeps the trigger's neighborhood and reply target instead of only the newest lines", () => {
    const lines = rankThreadEvidenceLines(thread(), "e31");
    assert.equal(lines.find((line) => line.event_id === "e31").rank, 0);
    assert.equal(lines.find((line) => line.event_id === "e0").rank, 1);
    const composed = composeWorkConversation({
      include_context: true,
      trigger_text: "上次选中的 2 位都还没回复吗？",
      current_event_id: "e31",
      thread_lines: lines,
      file_line_limit: 5,
    });
    assert.equal(
      composed.current_line,
      "customer [2026-10-22 04:01 UTC, reply to owner]: 上次选中的 2 位都还没回复吗？",
    );
    assert.equal(composed.background, [
      "owner: 上次确认小王和小李，共 2 位。",
      WORK_EVIDENCE_GAP,
      "customer: f28",
      "customer: f29",
      WORK_EVIDENCE_AFTER_CURRENT,
      "owner: l0",
      "owner: l1",
      WORK_EVIDENCE_GAP,
    ].join("\n\n"));
    assert.equal(composed.omitted, true);
  });

  it("finds the current message by event id when its text repeats", () => {
    const lines = rankThreadEvidenceLines([
      candidate(0, "A", "好的"),
      candidate(1, "B", "那就周一"),
      candidate(2, "A", "好的"),
    ], "e0");
    const composed = composeWorkConversation({
      include_context: true,
      trigger_text: "好的",
      current_event_id: "e0",
      thread_lines: lines,
    });
    assert.equal(composed.background, [
      WORK_EVIDENCE_AFTER_CURRENT,
      "B: 那就周一",
      "A: 好的",
    ].join("\n\n"));
  });

  it("marks unloaded spans and carries them across hidden rows", () => {
    const lines = rankThreadEvidenceLines([
      candidate(0, "A", "old reply target"),
      candidate(1, "status", "working", { status: true, gap_before: true }),
      candidate(2, "B", "recent"),
    ]);
    assert.deepEqual(lines.map((line) => Boolean(line.gap_before)), [false, true]);
    const packed = packThreadEvidence({ lines, overflow: true });
    assert.equal(packed.text, [
      WORK_EVIDENCE_OMITTED,
      "A: old reply target",
      WORK_EVIDENCE_GAP,
      "B: recent",
    ].join("\n\n"));
    assert.equal(packed.omitted, true);
  });

  it("keeps the old newest-first behavior for unranked lines", () => {
    const packed = packThreadEvidence({
      lines: [{ speaker: "A", text: "one" }, { speaker: "B", text: "two" }, { speaker: "C", text: "three" }],
      lineLimit: 2,
    });
    assert.equal(packed.text, `${WORK_EVIDENCE_OMITTED}\n\nB: two\n\nC: three`);
  });
});
