import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldFetchChangedHeads } from "../src/renderer/src/inbox-digest.ts";
import { InboxListStore } from "../src/renderer/src/inbox-list-store.ts";
import { markInboxThreadRead } from "../src/renderer/src/inbox.ts";
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

function at(row: InboxViewItem, stamp: string): InboxViewItem {
  return {
    ...row,
    event: { ...row.event, occurred_at: stamp, ingested_at: stamp },
  };
}

describe("InboxListStore", () => {
  it("replaces the live window and keeps extras off the history cursor", () => {
    const pinned = at(item("pin", "pin", "crm:order-pin"), "2026-08-22T00:00:00.000Z");
    pinned.pinned = true;
    const live = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    const work = at(item("job", "job", "dsh:session-job"), "2026-08-20T00:00:00.000Z");
    const store = new InboxListStore();
    const snap = store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned: [pinned],
      live: [live],
      activeWork: [work],
      nextBefore: { before: live.event.occurred_at, before_id: live.event.id },
      hasOlder: true,
    });
    assert.deepEqual(
      snap.items.map((row) => row.thread_id),
      ["crm:order-pin", "crm:order-2", "dsh:session-job"],
    );
    assert.deepEqual(snap.nextBefore, {
      before: "2026-08-23T00:02:00.000Z",
      before_id: "n2",
    });
    assert.equal(store.cursor?.before_id, "n2");
  });

  it("keeps loaded older heads when live refresh includes an extra old work face", () => {
    const recent = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    const mid = at(item("n1", "mid", "crm:order-1"), "2026-08-23T00:01:00.000Z");
    const older = at(item("n0", "old", "crm:order-0"), "2026-08-23T00:00:00.000Z");
    const extra = at(item("job", "job", "dsh:session-job"), "2026-08-20T00:00:00.000Z");
    const store = new InboxListStore();
    store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned: [],
      live: [recent, mid],
      activeWork: [],
      nextBefore: { before: mid.event.occurred_at, before_id: mid.event.id },
      hasOlder: true,
    });
    store.reduce({
      kind: "olderLoaded",
      items: [older],
      nextBefore: { before: older.event.occurred_at, before_id: older.event.id },
      hasOlder: true,
    });
    const snap = store.reduce({
      kind: "liveChanged",
      pinned: [],
      live: [recent, mid],
      activeWork: [extra],
      nextBefore: { before: mid.event.occurred_at, before_id: mid.event.id },
      hasOlder: true,
      pageSize: 2,
    });
    assert.deepEqual(
      snap.items.map((row) => row.thread_id),
      ["crm:order-0", "crm:order-2", "crm:order-1", "dsh:session-job"],
    );
  });

  it("drops a live-window head that disappeared and keeps older history", () => {
    const recent = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    const gone = at(item("n1", "gone", "crm:order-1"), "2026-08-23T00:01:00.000Z");
    const older = at(item("n0", "old", "crm:order-0"), "2026-08-23T00:00:00.000Z");
    const store = InboxListStore.fromItems([older, gone], 2);
    const snap = store.reduce({
      kind: "liveChanged",
      pinned: [],
      live: [recent],
      activeWork: [],
      nextBefore: { before: recent.event.occurred_at, before_id: recent.event.id },
      hasOlder: true,
      pageSize: 2,
    });
    assert.deepEqual(
      snap.items.map((row) => row.thread_id),
      ["crm:order-0", "crm:order-2"],
    );
  });

  it("clears history when the live page says the list is complete", () => {
    const recent = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    const older = at(item("n0", "old", "crm:order-0"), "2026-08-23T00:00:00.000Z");
    const store = new InboxListStore();
    store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned: [],
      live: [recent],
      activeWork: [],
      nextBefore: { before: recent.event.occurred_at, before_id: recent.event.id },
      hasOlder: true,
    });
    store.reduce({
      kind: "olderLoaded",
      items: [older],
      nextBefore: { before: older.event.occurred_at, before_id: older.event.id },
      hasOlder: true,
    });
    const snap = store.reduce({
      kind: "liveChanged",
      pinned: [],
      live: [recent],
      activeWork: [],
      nextBefore: { before: recent.event.occurred_at, before_id: recent.event.id },
      hasOlder: false,
    });
    assert.deepEqual(
      snap.items.map((row) => row.thread_id),
      ["crm:order-2"],
    );
  });

  it("applies a local read patch without dropping history", () => {
    const recent = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    recent.unread = true;
    recent.unread_count = 2;
    const older = at(item("n0", "old", "crm:order-0"), "2026-08-23T00:00:00.000Z");
    const store = new InboxListStore();
    store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned: [],
      live: [recent],
      activeWork: [],
      nextBefore: { before: recent.event.occurred_at, before_id: recent.event.id },
      hasOlder: true,
    });
    store.reduce({
      kind: "olderLoaded",
      items: [older],
      nextBefore: { before: older.event.occurred_at, before_id: older.event.id },
      hasOlder: true,
    });
    const snap = store.reduce({
      kind: "headPatched",
      items: markInboxThreadRead(store.items, "crm:order-2"),
    });
    const updated = snap.items.find((row) => row.thread_id === "crm:order-2");
    assert.equal(updated?.unread, false);
    assert.equal(
      snap.items.some((row) => row.thread_id === "crm:order-0"),
      true,
    );
  });

  it("promotes a touched older head into the live window and drops gone rows", () => {
    const recent = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    const mid = at(item("n1", "mid", "crm:order-1"), "2026-08-23T00:01:00.000Z");
    const older = at(item("n0", "old", "crm:order-0"), "2026-08-23T00:00:00.000Z");
    const store = new InboxListStore();
    store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned: [],
      live: [recent, mid],
      activeWork: [],
      nextBefore: { before: mid.event.occurred_at, before_id: mid.event.id },
      hasOlder: true,
    });
    store.reduce({
      kind: "olderLoaded",
      items: [older],
      nextBefore: { before: older.event.occurred_at, before_id: older.event.id },
      hasOlder: true,
    });
    const bumped = at(item("n0", "old+", "crm:order-0"), "2026-08-23T00:03:00.000Z");
    const snap = store.reduce({
      kind: "headsTouched",
      items: [bumped],
      gone: ["crm:order-1"],
      pageSize: 2,
    });
    assert.deepEqual(
      snap.items.map((row) => row.thread_id),
      ["crm:order-0", "crm:order-2"],
    );
    assert.equal(store.cursor?.before_id, "n2");
  });

  it("patches from a digest change only when events or prefs moved", () => {
    assert.equal(
      shouldFetchChangedHeads({
        replace: false,
        previousDigest: "1:2026-08-23T00:00:00.000Z:e1:0:",
        nextDigest: "1:2026-08-23T00:00:01.000Z:e2:0:",
      }),
      true,
    );
    assert.equal(
      shouldFetchChangedHeads({
        replace: false,
        previousDigest: "1:2026-08-23T00:00:00.000Z:e1:0:",
        nextDigest: "1:2026-08-23T00:00:00.000Z:e1:0:&s=dsh:2",
      }),
      false,
    );
    assert.equal(
      shouldFetchChangedHeads({
        replace: true,
        previousDigest: "1:2026-08-23T00:00:00.000Z:e1:0:",
        nextDigest: "1:2026-08-23T00:00:01.000Z:e2:0:",
      }),
      false,
    );
    assert.equal(
      shouldFetchChangedHeads({
        replace: false,
        previousDigest: "1:2026-08-23T00:00:00.000Z:e1:0:",
        nextDigest: "1:2026-08-23T00:00:00.000Z:e1:0:&w=2026-08-23T00:02:00.000Z",
      }),
      false,
    );
    assert.equal(
      shouldFetchChangedHeads({
        replace: false,
        previousDigest: "1:2026-08-23T00:00:00.000Z:e1:0:",
        nextDigest: "1:2026-08-23T00:00:00.000Z:e1:1:2026-08-23T00:01:00.000Z",
      }),
      true,
    );
  });

  it("keeps active work extras off the live ranking after a touch", () => {
    const live = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    const work = at(item("job", "job", "dsh:job"), "2026-08-23T00:03:00.000Z");
    const store = new InboxListStore();
    store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned: [],
      live: [live],
      activeWork: [work],
      nextBefore: { before: live.event.occurred_at, before_id: live.event.id },
      hasOlder: false,
    });
    const bumped = at(item("job", "job+", "dsh:job"), "2026-08-23T00:04:00.000Z");
    const snap = store.reduce({
      kind: "headsTouched",
      items: [bumped],
      pageSize: 2,
    });
    assert.deepEqual(
      snap.items.map((row) => row.thread_id),
      ["crm:order-2", "dsh:job"],
    );
    assert.equal(store.cursor?.before_id, "n2");
  });

  it("lets an older page and a live refresh commute", async () => {
    const recent = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    const mid = at(item("n1", "mid", "crm:order-1"), "2026-08-23T00:01:00.000Z");
    const older = at(item("n0", "old", "crm:order-0"), "2026-08-23T00:00:00.000Z");
    const store = new InboxListStore();
    store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned: [],
      live: [recent, mid],
      activeWork: [],
      nextBefore: { before: mid.event.occurred_at, before_id: mid.event.id },
      hasOlder: true,
    });
    await store.enqueue({
      kind: "olderLoaded",
      items: [older],
      nextBefore: { before: older.event.occurred_at, before_id: older.event.id },
      hasOlder: false,
    });
    const snap = await store.enqueue({
      kind: "liveChanged",
      pinned: [],
      live: [recent, mid],
      activeWork: [],
      nextBefore: { before: mid.event.occurred_at, before_id: mid.event.id },
      hasOlder: true,
      pageSize: 2,
    });
    assert.deepEqual(
      snap.items.map((row) => row.thread_id),
      ["crm:order-0", "crm:order-2", "crm:order-1"],
    );
  });
});
