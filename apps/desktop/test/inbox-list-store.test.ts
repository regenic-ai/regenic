import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shouldFetchChangedHeads } from "../src/renderer/src/inbox-digest.ts";
import {
  InboxListStore,
  isActivePrefWrite,
} from "../src/renderer/src/inbox-list-store.ts";
import { inboxListRestoreFact } from "../src/renderer/src/inbox-list-sync.ts";
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

  it("keeps the history-tail cursor when a touch does not drop history", () => {
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
    const bumped = at(item("n1", "mid+", "crm:order-1"), "2026-08-23T00:01:30.000Z");
    const snap = store.reduce({
      kind: "headsTouched",
      items: [bumped],
      pageSize: 2,
    });
    assert.equal(store.cursor?.before_id, "n0");
    assert.equal(snap.hasOlder, true);
  });

  it("invalidates an in-flight older page after a live refresh or gone touch", () => {
    const recent = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
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
    const afterLoad = store.token;
    store.reduce({
      kind: "olderLoaded",
      items: [at(item("n0", "old", "crm:order-0"), "2026-08-23T00:00:00.000Z")],
      nextBefore: { before: "2026-08-23T00:00:00.000Z", before_id: "n0" },
      hasOlder: true,
    });
    assert.equal(store.acceptsPage(afterLoad), true);
    store.reduce({
      kind: "liveChanged",
      pinned: [],
      live: [recent],
      activeWork: [],
      nextBefore: { before: recent.event.occurred_at, before_id: recent.event.id },
      hasOlder: false,
    });
    assert.equal(store.acceptsPage(afterLoad), false);
    assert.equal(store.acceptsList(afterLoad), true);
    const afterFull = store.token;
    store.reduce({
      kind: "headPatched",
      items: [recent],
    });
    assert.equal(store.acceptsPage(afterFull), true);
    store.reduce({
      kind: "headsTouched",
      items: [],
      gone: ["crm:order-2"],
    });
    assert.equal(store.acceptsPage(afterFull), false);
  });

  it("keeps a poll token across a page bump but drops it on a list bump", () => {
    const recent = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    const store = new InboxListStore();
    store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned: [],
      live: [recent],
      activeWork: [],
      nextBefore: { before: recent.event.occurred_at, before_id: recent.event.id },
      hasOlder: false,
    });
    const poll = store.token;
    store.reduce({
      kind: "liveChanged",
      pinned: [],
      live: [recent],
      activeWork: [],
      nextBefore: { before: recent.event.occurred_at, before_id: recent.event.id },
      hasOlder: false,
    });
    assert.equal(store.acceptsList(poll), true);
    assert.equal(store.acceptsPage(poll), false);
    store.bumpList();
    assert.equal(store.acceptsList(poll), false);
  });

  it("applies an optimistic pref and yields to a newer server face", () => {
    const row = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    const store = new InboxListStore();
    store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned: [],
      live: [row],
      activeWork: [],
      nextBefore: { before: row.event.occurred_at, before_id: row.event.id },
      hasOlder: false,
    });
    const pinned = store.reduce({
      kind: "prefPatched",
      threadId: "crm:order-2",
      pref: {
        title: null,
        pinned: true,
        hidden: false,
        updated_at: "2026-08-23T00:03:00.000Z",
      },
    });
    assert.equal(pinned.items[0]?.pinned, true);
    const confirmed = {
      ...row,
      pinned: true,
      pref_updated_at: "2026-08-23T00:04:00.000Z",
    };
    const snap = store.reduce({
      kind: "headsTouched",
      items: [confirmed],
    });
    assert.equal(snap.items[0]?.pinned, true);
    assert.equal(store.prefOverlay("crm:order-2"), undefined);
    store.reduce({
      kind: "prefPatched",
      threadId: "crm:order-2",
      pref: {
        title: "later",
        pinned: false,
        hidden: false,
        updated_at: "2026-08-23T00:05:00.000Z",
      },
    });
    const reverted = store.reduce({
      kind: "prefReverted",
      threadId: "crm:order-2",
    });
    assert.equal(reverted.items[0]?.pinned, true);
    assert.equal(reverted.items[0]?.title ?? null, null);
    assert.equal(store.prefOverlay("crm:order-2"), undefined);
  });

  it("does not bake an optimistic pref into the catalog when marking a head read", () => {
    const row = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    row.unread = true;
    row.unread_count = 2;
    const store = new InboxListStore();
    store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned: [],
      live: [row],
      activeWork: [],
      nextBefore: { before: row.event.occurred_at, before_id: row.event.id },
      hasOlder: false,
    });
    store.reduce({
      kind: "prefPatched",
      threadId: "crm:order-2",
      pref: {
        title: null,
        pinned: false,
        hidden: true,
        updated_at: "2026-08-23T00:03:00.000Z",
      },
    });
    assert.equal(store.items.length, 0);
    store.reduce({
      kind: "headPatched",
      items: [{ ...row, unread: false, unread_count: 0, hidden: true }],
    });
    store.reduce({ kind: "prefReverted", threadId: "crm:order-2" });
    assert.equal(store.items[0]?.unread, false);
    assert.equal(store.items[0]?.hidden === true, false);
  });

  it("drops an optimistic hide from the shown list and restores it on revert", () => {
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
      pageSize: 2,
    });
    store.reduce({
      kind: "olderLoaded",
      items: [older],
      nextBefore: { before: older.event.occurred_at, before_id: older.event.id },
      hasOlder: true,
    });
    const hidden = store.reduce({
      kind: "prefPatched",
      threadId: "crm:order-1",
      pref: {
        title: null,
        pinned: false,
        hidden: true,
        updated_at: "2026-08-23T00:03:00.000Z",
      },
    });
    assert.deepEqual(
      hidden.items.map((row) => row.thread_id),
      ["crm:order-2", "crm:order-0"],
    );
    const refreshed = store.reduce({
      kind: "liveChanged",
      pinned: [],
      live: [recent],
      activeWork: [],
      nextBefore: { before: recent.event.occurred_at, before_id: recent.event.id },
      hasOlder: true,
      pageSize: 2,
    });
    assert.deepEqual(
      refreshed.items.map((row) => row.thread_id),
      ["crm:order-0", "crm:order-2"],
    );
    const reverted = store.reduce({
      kind: "prefReverted",
      threadId: "crm:order-1",
    });
    assert.equal(
      reverted.items.some((row) => row.thread_id === "crm:order-1"),
      true,
    );
  });

  it("ranks an optimistic pin into the pinned column", () => {
    const recent = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    const older = at(item("n0", "old", "crm:order-0"), "2026-08-23T00:00:00.000Z");
    const store = new InboxListStore();
    store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned: [],
      live: [recent, older],
      activeWork: [],
      nextBefore: { before: older.event.occurred_at, before_id: older.event.id },
      hasOlder: false,
      pageSize: 2,
    });
    const snap = store.reduce({
      kind: "prefPatched",
      threadId: "crm:order-0",
      pref: {
        title: null,
        pinned: true,
        hidden: false,
        updated_at: "2026-08-23T00:03:00.000Z",
      },
    });
    assert.deepEqual(
      snap.items.map((row) => row.thread_id),
      ["crm:order-0", "crm:order-2"],
    );
    assert.equal(snap.items[0]?.pinned, true);
  });

  it("keeps an optimistic unpin in the live window", () => {
    const pinned = at(item("pin", "pin", "crm:order-pin"), "2026-08-23T00:02:00.000Z");
    pinned.pinned = true;
    const live = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:01:00.000Z");
    const store = new InboxListStore();
    store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned: [pinned],
      live: [live],
      activeWork: [],
      nextBefore: { before: live.event.occurred_at, before_id: live.event.id },
      hasOlder: false,
      pageSize: 2,
    });
    const snap = store.reduce({
      kind: "prefPatched",
      threadId: "crm:order-pin",
      pref: {
        title: null,
        pinned: false,
        hidden: false,
        updated_at: "2026-08-23T00:03:00.000Z",
      },
    });
    assert.deepEqual(
      snap.items.map((row) => row.thread_id),
      ["crm:order-pin", "crm:order-2"],
    );
    assert.equal(
      snap.items.find((row) => row.thread_id === "crm:order-pin")?.pinned,
      false,
    );
  });

  it("reverts a pref write only while that write is still the active overlay", () => {
    const first = {
      title: null,
      pinned: false,
      hidden: true,
      updated_at: "2026-08-23T00:03:00.000Z",
    };
    const second = {
      title: null,
      pinned: true,
      hidden: true,
      updated_at: "2026-08-23T00:04:00.000Z",
    };
    assert.equal(isActivePrefWrite(first, first.updated_at), true);
    assert.equal(isActivePrefWrite(second, first.updated_at), false);
    assert.equal(isActivePrefWrite(undefined, first.updated_at), false);
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
    assert.equal(
      shouldFetchChangedHeads({
        replace: false,
        previousDigest: "1:2026-08-23T00:00:00.000Z:e1:0:",
        nextDigest: "1:2026-08-23T00:00:01.000Z:e2:0:",
        fullRefreshDue: true,
      }),
      false,
    );
    assert.equal(
      shouldFetchChangedHeads({
        replace: false,
        previousDigest: "1:2026-08-23T00:00:00.000Z:e1:0:",
        nextDigest: "0:2026-08-23T00:00:00.000Z:e1:0:",
      }),
      false,
    );
    assert.equal(
      shouldFetchChangedHeads({
        replace: false,
        previousDigest: "1:2026-08-23T00:00:00.000Z:e1:0:",
        nextDigest: "0:2026-08-23T00:00:01.000Z:e2:0:&w=2026-08-23T00:02:00.000Z",
      }),
      false,
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

  it("replaces work extras when a touch carries the current active set", () => {
    const live = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    const ended = at(item("job", "job", "dsh:job"), "2026-08-23T00:03:00.000Z");
    const started = at(item("next", "next", "dsh:next"), "2026-08-20T00:00:00.000Z");
    const store = new InboxListStore();
    store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned: [],
      live: [live],
      activeWork: [ended],
      nextBefore: { before: live.event.occurred_at, before_id: live.event.id },
      hasOlder: false,
    });
    const snap = store.reduce({
      kind: "headsTouched",
      items: [ended],
      activeWork: [started],
      pageSize: 2,
    });
    assert.deepEqual(
      snap.items.map((row) => row.thread_id),
      ["dsh:job", "crm:order-2", "dsh:next"],
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

  it("drops a queued live page after a workspace reset", async () => {
    const recent = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    const store = new InboxListStore();
    const pending = store.enqueue({
      kind: "liveLoaded",
      list: "shown",
      pinned: [],
      live: [recent],
      activeWork: [],
      nextBefore: { before: recent.event.occurred_at, before_id: recent.event.id },
      hasOlder: false,
    });
    store.reduce({ kind: "reset" });
    const snap = await pending;
    assert.deepEqual(snap.items, []);
    assert.equal(store.items.length, 0);
  });

  it("drops a queued live page after a list bump", async () => {
    const first = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    const next = at(item("n1", "mid", "crm:order-1"), "2026-08-23T00:01:00.000Z");
    const store = new InboxListStore();
    store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned: [],
      live: [first],
      activeWork: [],
      nextBefore: { before: first.event.occurred_at, before_id: first.event.id },
      hasOlder: false,
    });
    const pending = store.enqueue({
      kind: "liveChanged",
      pinned: [],
      live: [next],
      activeWork: [],
      nextBefore: { before: next.event.occurred_at, before_id: next.event.id },
      hasOlder: false,
    });
    store.bumpList();
    const snap = await pending;
    assert.deepEqual(
      snap.items.map((row) => row.thread_id),
      ["crm:order-2"],
    );
  });

  it("drops a queued older page after a live refresh bumps the page token", async () => {
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
    const pending = store.enqueue({
      kind: "olderLoaded",
      items: [older],
      nextBefore: { before: older.event.occurred_at, before_id: older.event.id },
      hasOlder: true,
    });
    store.reduce({
      kind: "liveChanged",
      pinned: [],
      live: [recent],
      activeWork: [],
      nextBefore: { before: recent.event.occurred_at, before_id: recent.event.id },
      hasOlder: false,
    });
    const snap = await pending;
    assert.deepEqual(
      snap.items.map((row) => row.thread_id),
      ["crm:order-2"],
    );
  });

  it("applies a live page enqueued after reset", async () => {
    const recent = at(item("n2", "new", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    const store = new InboxListStore();
    store.reduce({ kind: "reset" });
    const snap = await store.enqueue({
      kind: "liveLoaded",
      list: "shown",
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

  it("restores a cached hidden list instead of filtering shown heads to empty", () => {
    const shown = at(item("n2", "shown", "crm:order-2"), "2026-08-23T00:02:00.000Z");
    const hiddenRow = at(item("h1", "hidden", "crm:hidden"), "2026-08-23T00:01:00.000Z");
    hiddenRow.hidden = true;
    const store = new InboxListStore();
    store.reduce({
      kind: "liveLoaded",
      list: "shown",
      pinned: [],
      live: [shown],
      activeWork: [],
      nextBefore: { before: shown.event.occurred_at, before_id: shown.event.id },
      hasOlder: false,
    });
    store.bumpList();
    const snap = store.reduce(
      inboxListRestoreFact("hidden", {
        items: [hiddenRow],
        hasOlder: false,
        nextBefore: null,
      }),
    );
    assert.deepEqual(
      snap.items.map((row) => row.thread_id),
      ["crm:hidden"],
    );
    assert.equal(snap.listView, "hidden");
  });
});
