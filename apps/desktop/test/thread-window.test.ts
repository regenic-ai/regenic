import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeWindow,
  endScrollTop,
  estimateMessageHeight,
  inboxRevision,
  isStuckToEnd,
  paddingYFromStyle,
  prefixOffsets,
  appendHeadPages,
  hasOlderPage,
  inboxCursor,
  mergeHeadPages,
  mergeInboxDelta,
  mergeOlderInbox,
  mergeRecentInbox,
  olderHeadsCursor,
  olderInboxCursor,
  reuseInboxItems,
  reuseInboxList,
  patchInboxWork,
  shouldFetchInboxDelta,
  shouldLoadMoreHeads,
  shouldLoadOlder,
  shouldRearmLoadMoreHeads,
  shouldRearmLoadOlder,
  LIST_LOAD_MORE_PX,
  THREAD_LOAD_OLDER_PX,
  THREAD_PAGE_SIZE,
  THREAD_STICK_PX,
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

  it("counts a source-side forwarded chip in height and revision", () => {
    const message = item("m1", "hello");
    const marked = {
      ...message,
      forwarded_to: {
        thread_id: "dsh:sess-b",
        event_ids: ["m1"],
        source: "dsh",
        channel_label: "DSH",
      },
    };
    assert.ok(estimateMessageHeight(marked, false) > estimateMessageHeight(message, false));
    assert.notEqual(inboxRevision([message]), inboxRevision([marked]));
  });

  it("estimates ticket system messages from the body instead of a collapsed line", () => {
    const ticket = {
      ...item("t1", "# 订单 AI 内审待人工\n- 达人: 小红\n\n## 项目需求\n要竖屏带货"),
      kind: "system" as const,
      thread_facet: "ticket" as const,
    };
    const notice = { ...item("s1", "ok"), kind: "system" as const };
    assert.equal(estimateMessageHeight(notice, false), 36);
    assert.ok(estimateMessageHeight(ticket, false) > 80);
  });

  it("changes inbox revision when a later event appears", () => {
    const first = [item("a", "one"), item("b", "two")];
    const next = [...first, item("c", "three")];
    assert.notEqual(inboxRevision(first), inboxRevision(next));
    assert.equal(inboxRevision(first), inboxRevision(first));
  });

  it("reuses items by content hash without walking the message body", () => {
    const first = [item("a", "one")];
    const parsedAgain = [
      {
        ...first[0],
        body_text: "one copied again",
        event: { ...first[0].event },
      },
    ];
    const reused = reuseInboxItems(first, parsedAgain);
    assert.equal(reused, first);
    assert.equal(reused[0], first[0]);

    const edited = [
      {
        ...first[0],
        body_text: "changed",
        event: { ...first[0].event, content_hash: "hash-a-2" },
      },
    ];
    const next = reuseInboxItems(first, edited);
    assert.equal(next[0], edited[0]);
  });

  it("does not reuse an inbox row when write-back status changes", () => {
    const first = [
      {
        ...item("a", "one"),
        work: {
          id: "work-1",
          status: "done" as const,
          has_result: true,
          delivery: { status: "write_back" as const, write_back: "pending" as const, attempts: 1 },
        },
      },
    ];
    const sent = [
      {
        ...first[0],
        event: { ...first[0].event },
        work: {
          id: "work-1",
          status: "done" as const,
          has_result: true,
          delivery: { status: "acked" as const, write_back: "sent" as const, attempts: 1 },
        },
      },
    ];
    const reused = reuseInboxList(first, sent);
    assert.equal(reused.same, false);
    assert.equal(reused.items[0], sent[0]);
    assert.equal(inboxRevision(first) === inboxRevision(sent), false);
  });

  it("patches opened messages with a later head write-back", () => {
    const opened = [
      {
        ...item("a", "one"),
        work: {
          id: "work-1",
          status: "done" as const,
          delivery: { status: "write_back" as const, write_back: "pending" as const, attempts: 1 },
        },
      },
    ];
    const heads = [
      {
        ...item("a", "one"),
        work: {
          id: "work-1",
          status: "done" as const,
          delivery: { status: "dead" as const, write_back: "failed" as const, attempts: 3 },
        },
      },
    ];
    const patched = patchInboxWork(opened, heads);
    assert.equal(patched[0].work?.delivery?.status, "dead");
    assert.equal(patched[0].work?.delivery?.attempts, 3);
    assert.equal(patchInboxWork(opened, opened), opened);
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
    const appendedList = reuseInboxList(first, [...parsedAgain, extra]);
    const appended = appendedList.items;
    assert.equal(appendedList.unchangedPrefix, 2);
    assert.equal(appended[0], first[0]);
    assert.equal(appended[1], first[1]);
    assert.equal(appended[2], extra);

    const previous = groupInboxThreads(first);
    const next = groupInboxThreads(appended, previous, appendedList);
    assert.equal(next.find((thread) => thread.id === "feishu:oc_1"), previous[0]);
    assert.equal(next.find((thread) => thread.id === "feishu:oc_1")?.messages[0], first[0]);
  });

  it("merges a delta by replacing matching ids and appending the rest", () => {
    const first = [item("a", "one"), item("b", "two")];
    const edited = { ...first[1], body_text: "two edited", event: { ...first[1].event } };
    const extra = item("c", "three", "feishu:oc_2");
    extra.event.occurred_at = "2026-08-23T00:00:01.000Z";
    extra.event.ingested_at = "2026-08-23T00:00:01.000Z";
    const merged = mergeInboxDelta(first, [edited, extra]);
    assert.equal(merged[0], first[0]);
    assert.equal(merged[1], edited);
    assert.equal(merged[2], extra);
    const cursor = inboxCursor(merged);
    assert.equal(cursor?.since_id, "c");
  });

  it("keeps a live Read receipt when a later local page only has Sent", () => {
    const sent = item("m1", "hi");
    sent.direction = "outbound";
    sent.can_receipt = true;
    sent.receipt = { state: "sent" };
    const read = {
      ...sent,
      receipt: { state: "read" as const, read_count: 1 },
    };
    assert.equal(mergeInboxDelta([sent], [read])[0].receipt?.state, "read");
    assert.equal(mergeInboxDelta([read], [sent])[0].receipt?.state, "read");
    assert.equal(mergeRecentInbox([read], [sent])[0].receipt?.state, "read");
  });

  it("does not pull older catch-up events into a recent window", () => {
    const recent = [
      item("m50", "new"),
      item("m51", "newer"),
    ];
    recent[0].event.occurred_at = "2026-08-23T10:00:00.000Z";
    recent[1].event.occurred_at = "2026-08-23T11:00:00.000Z";
    const older = item("m1", "old");
    older.event.occurred_at = "2026-07-01T00:00:00.000Z";
    const merged = mergeInboxDelta(recent, [older]);
    assert.deepEqual(
      merged.map((entry) => entry.event.id),
      ["m50", "m51"],
    );
  });

  it("prepends an older page and keeps a before cursor on the oldest row", () => {
    const recent = [item("m2", "two"), item("m3", "three")];
    recent[0].event.occurred_at = "2026-08-23T10:00:00.000Z";
    recent[1].event.occurred_at = "2026-08-23T11:00:00.000Z";
    const older = item("m1", "one");
    older.event.occurred_at = "2026-08-23T09:00:00.000Z";
    const merged = mergeOlderInbox(recent, [older]);
    assert.deepEqual(
      merged.map((entry) => entry.event.id),
      ["m1", "m2", "m3"],
    );
    assert.deepEqual(olderInboxCursor(merged), {
      before: "2026-08-23T09:00:00.000Z",
      before_id: "m1",
    });
    assert.equal(hasOlderPage(THREAD_PAGE_SIZE), true);
    assert.equal(hasOlderPage(THREAD_PAGE_SIZE - 1), false);
  });

  it("keeps prepended history when a recent page is refetched", () => {
    const older = item("m1", "one");
    older.event.occurred_at = "2026-08-23T09:00:00.000Z";
    const mid = item("m2", "two");
    mid.event.occurred_at = "2026-08-23T10:00:00.000Z";
    const newer = item("m3", "three");
    newer.event.occurred_at = "2026-08-23T11:00:00.000Z";
    const merged = mergeRecentInbox([older, mid], [mid, newer]);
    assert.deepEqual(
      merged.map((entry) => entry.event.id),
      ["m1", "m2", "m3"],
    );
    assert.equal(merged[0], older);
    assert.equal(merged[1], mid);
  });

  it("refetches a thin open window instead of polling only new ingest", () => {
    assert.equal(
      shouldFetchInboxDelta({ loaded: true, loadedCount: 1, hasCursor: true }),
      false,
    );
    assert.equal(
      shouldFetchInboxDelta({ loaded: true, loadedCount: 23, hasCursor: true }),
      true,
    );
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

  it("pins to the content end including scroll padding", () => {
    assert.equal(paddingYFromStyle({ paddingTop: "16px", paddingBottom: "20px" }), 36);
    assert.equal(endScrollTop(5_000, 600, 36), 4_436);
    assert.equal(endScrollTop(5_000, 600, 0), 4_400);
    assert.equal(endScrollTop(200, 600, 36), 0);
  });

  it("loads older history only after an upward scroll reaches the top", () => {
    const tall = {
      hasOlder: true,
      loadingOlder: false,
      opening: false,
      scrollHeight: 8_000,
      clientHeight: 640,
      scrolledUp: true,
      armed: true,
    };
    assert.equal(shouldLoadOlder({ ...tall, scrollTop: 0 }), true);
    assert.equal(shouldLoadOlder({ ...tall, scrollTop: THREAD_LOAD_OLDER_PX }), true);
    assert.equal(shouldLoadOlder({ ...tall, scrollTop: THREAD_STICK_PX }), false);
    assert.equal(shouldLoadOlder({ ...tall, scrollTop: 0, scrolledUp: false }), false);
    assert.equal(shouldLoadOlder({ ...tall, scrollTop: 0, armed: false }), false);
    assert.equal(shouldRearmLoadOlder(THREAD_STICK_PX), true);
    assert.equal(shouldRearmLoadOlder(0), false);
  });

  it("fills a short thread without waiting for another scroll", () => {
    assert.equal(
      shouldLoadOlder({
        hasOlder: true,
        loadingOlder: false,
        opening: false,
        scrollTop: 0,
        scrollHeight: 400,
        clientHeight: 640,
        scrolledUp: false,
        armed: false,
      }),
      true,
    );
    assert.equal(
      shouldLoadOlder({
        hasOlder: true,
        loadingOlder: true,
        opening: false,
        scrollTop: 0,
        scrollHeight: 400,
        clientHeight: 640,
        scrolledUp: false,
        armed: false,
      }),
      false,
    );
  });

  it("pages list heads from the oldest unpinned face and keeps older rows", () => {
    const recent = item("n2", "new", "crm:order-2");
    recent.event.occurred_at = "2026-08-23T00:02:00.000Z";
    const mid = item("n1", "mid", "crm:order-1");
    mid.event.occurred_at = "2026-08-23T00:01:00.000Z";
    const older = item("n0", "old", "crm:order-0");
    older.event.occurred_at = "2026-08-23T00:00:00.000Z";
    const pinned = item("pin", "pin", "crm:order-pin");
    pinned.pinned = true;
    pinned.event.occurred_at = "2026-08-22T00:00:00.000Z";
    const cursor = olderHeadsCursor([pinned, recent, mid]);
    assert.equal(cursor?.before_id, "n1");
    const merged = mergeHeadPages([older, mid], [pinned, recent, mid]);
    assert.deepEqual(
      merged.map((row) => row.thread_id),
      ["crm:order-0", "crm:order-pin", "crm:order-2", "crm:order-1"],
    );
    const appended = appendHeadPages([pinned, recent, mid], [older]);
    assert.equal(appended[appended.length - 1], older);
    assert.equal(appendHeadPages([mid], [mid]).length, 1);
  });

  it("loads more list heads when the scroller is at the bottom or still short", () => {
    const tall = {
      hasOlder: true,
      loadingOlder: false,
      scrollHeight: 8_000,
      clientHeight: 640,
      scrolledDown: true,
      armed: true,
    };
    assert.equal(
      shouldLoadMoreHeads({ ...tall, scrollTop: 8_000 - 640 - LIST_LOAD_MORE_PX }),
      true,
    );
    assert.equal(shouldLoadMoreHeads({ ...tall, scrollTop: 100 }), false);
    assert.equal(
      shouldLoadMoreHeads({ ...tall, scrollTop: 7_000, scrolledDown: false }),
      false,
    );
    assert.equal(
      shouldLoadMoreHeads({
        hasOlder: true,
        loadingOlder: false,
        scrollTop: 0,
        scrollHeight: 400,
        clientHeight: 640,
        scrolledDown: false,
        armed: false,
      }),
      true,
    );
    assert.equal(shouldRearmLoadMoreHeads(LIST_LOAD_MORE_PX), false);
    assert.equal(shouldRearmLoadMoreHeads(400), true);
  });
});
