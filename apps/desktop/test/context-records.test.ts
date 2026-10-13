import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  contextRecordPageFromResponse,
  contextSummariesFromResponse,
} from "../src/renderer/src/context-records.ts";

describe("context record views", () => {
  it("lists summaries newest first", () => {
    const records = contextSummariesFromResponse([
      {
        id: "older",
        kind: "thread_summary",
        status: "proposed",
        recorded_at: "2026-10-12T08:00:00.000Z",
        title: "later",
        message_count: 2,
        thread_id: "feishu:oc_a",
      },
      {
        id: "newer",
        kind: "thread_summary",
        status: "accepted",
        recorded_at: "2026-10-12T09:00:00.000Z",
        title: "newest line",
        message_count: 1,
      },
      { id: "" },
      null,
    ]);
    assert.deepEqual(
      records.map((record) => record.id),
      ["newer", "older"],
    );
    assert.equal(records[1]?.thread_id, "feishu:oc_a");
    assert.equal(records[0]?.title, "newest line");
  });

  it("reads a message page and drops blank lines", () => {
    const page = contextRecordPageFromResponse({
      messages: [
        { text: " earlier ", occurred_at: "2026-10-12T07:01:00.000Z" },
        { text: "   ", occurred_at: "2026-10-12T07:02:00.000Z" },
        { text: "later" },
      ],
      message_offset: 4,
      message_total: 9,
    });
    assert.deepEqual(page, {
      messages: [
        { text: "earlier", occurred_at: "2026-10-12T07:01:00.000Z" },
        { text: "later" },
      ],
      message_offset: 4,
      message_total: 9,
    });
    assert.equal(contextRecordPageFromResponse(null), null);
  });
});
