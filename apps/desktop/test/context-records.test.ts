import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextRecordsFromArtifacts } from "../src/renderer/src/context-records.ts";

describe("contextRecordsFromArtifacts", () => {
  it("lists summaries newest first and reads messages in time order", () => {
    const records = contextRecordsFromArtifacts([
      {
        id: "older",
        kind: "thread_summary",
        status: "proposed",
        recorded_at: "2026-10-12T08:00:00.000Z",
        attrs: {
          thread_id: "feishu:oc_a",
          message_count: 2,
          messages: [
            { text: "  later  ", occurred_at: "2026-10-12T07:02:00.000Z" },
            { text: "earlier", occurred_at: "2026-10-12T07:01:00.000Z" },
          ],
        },
      },
      {
        id: "newer",
        kind: "thread_summary",
        status: "accepted",
        recorded_at: "2026-10-12T09:00:00.000Z",
        attrs: {
          message_count: 1,
          messages: [{ text: "newest line", occurred_at: "2026-10-12T08:00:00.000Z" }],
        },
      },
      { id: "" },
      null,
    ]);
    assert.deepEqual(
      records.map((record) => record.id),
      ["newer", "older"],
    );
    assert.equal(records[1]?.title, "later");
    assert.deepEqual(
      records[1]?.messages.map((message) => message.text),
      ["earlier", "later"],
    );
    assert.equal(records[1]?.thread_id, "feishu:oc_a");
    assert.equal(records[0]?.title, "newest line");
  });

  it("shortens a long newest line for the row title", () => {
    const [record] = contextRecordsFromArtifacts([
      {
        id: "long",
        kind: "thread_summary",
        status: "proposed",
        recorded_at: "2026-10-12T09:00:00.000Z",
        attrs: {
          messages: [{ text: "x".repeat(90), occurred_at: "2026-10-12T08:00:00.000Z" }],
        },
      },
    ]);
    assert.equal(record?.title.length, 81);
    assert.equal(record?.title.endsWith("…"), true);
    assert.equal(record?.messages[0]?.text.length, 90);
  });
});
