import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeWindow,
  estimateMessageHeight,
  inboxRevision,
  isStuckToEnd,
  prefixOffsets,
  reuseInboxItems,
} from "../src/renderer/src/thread-window.ts";
import { groupInboxThreads } from "../src/renderer/src/inbox.ts";
import type { InboxViewItem } from "../src/renderer/src/types.ts";

function item(id: string, text: string, threadId = "feishu:oc_1"): InboxViewItem {
  return {
    decision: {
      event_id: id,
      org_id: "org",
      disposition: "current_work",
      layer: "L1_event",
      reason_codes: [],
      score: 1,
      decided_at: "2026-08-23T00:00:00.000Z",
    },
    event: {
      id,
      org_id: "org",
      source: "feishu",
      external_id: `${threadId}:${id}`,
      operation: "create",
      content_hash: `hash-${id}`,
      occurred_at: "2026-08-23T00:00:00.000Z",
      ingested_at: "2026-08-23T00:00:00.000Z",
    },
    body_text: text,
    channel: "feishu",
    channel_label: "Feishu",
    kind: "user",
    direction: "inbound",
    can_send: true,
    thread_id: threadId,
  };
}

describe("thread window", () => {
  it("windows a tall list to the visible slice plus overscan", () => {
    const offsets = prefixOffsets(Array.from({ length: 1000 }, () => 40));
    const window = computeWindow({
      offsets,
      scrollTop: 20_000,
      viewport: 400,
      overscan: 2,
    });
    assert.equal(window.start, 500 - 2);
    assert.ok(window.end >= 510);
    assert.ok(window.end - window.start < 30);
  });

  it("pins the first window to the top and the last window to the end", () => {
    const offsets = prefixOffsets([80, 80, 80, 80, 80]);
    assert.deepEqual(
      computeWindow({ offsets, scrollTop: 0, viewport: 100, overscan: 0 }),
      { start: 0, end: 2 },
    );
    const tail = computeWindow({
      offsets,
      scrollTop: 300,
      viewport: 100,
      overscan: 0,
    });
    assert.equal(tail.end, 5);
    assert.ok(tail.start >= 3);
  });

  it("treats an empty list as an empty window", () => {
    assert.deepEqual(
      computeWindow({ offsets: [0], scrollTop: 0, viewport: 400, overscan: 8 }),
      { start: 0, end: 0 },
    );
  });

  it("estimates follow rows shorter than a new speaker", () => {
    const message = item("m1", "hello");
    assert.ok(estimateMessageHeight(message, true) < estimateMessageHeight(message, false));
  });

  it("changes inbox revision when a later event appears", () => {
    const first = [item("a", "one"), item("b", "two")];
    const next = [...first, item("c", "three")];
    assert.notEqual(inboxRevision(first), inboxRevision(next));
    assert.equal(inboxRevision(first), inboxRevision(first));
  });

  it("reuses unchanged inbox objects so a later poll does not replace the open thread", () => {
    const first = [item("a", "one"), item("b", "two")];
    const parsedAgain = first.map((entry) => ({
      ...entry,
      event: { ...entry.event },
    }));
    const reused = reuseInboxItems(first, parsedAgain);
    assert.equal(reused, first);
    assert.equal(reused[0], first[0]);

    const extra = item("c", "three", "feishu:oc_2");
    const appended = reuseInboxItems(first, [...parsedAgain, extra]);
    assert.equal(appended[0], first[0]);
    assert.equal(appended[1], first[1]);
    assert.equal(appended[2], extra);

    const previous = groupInboxThreads(first);
    const next = groupInboxThreads(appended, previous);
    assert.equal(next.find((thread) => thread.id === "feishu:oc_1"), previous[0]);
    assert.equal(next.find((thread) => thread.id === "feishu:oc_1")?.messages[0], first[0]);
  });

  it("detects a stick-to-end scroll position", () => {
    assert.equal(
      isStuckToEnd({ scrollHeight: 10_000, scrollTop: 9_920, clientHeight: 80 }),
      true,
    );
    assert.equal(
      isStuckToEnd({ scrollHeight: 10_000, scrollTop: 100, clientHeight: 80 }),
      false,
    );
  });
});
