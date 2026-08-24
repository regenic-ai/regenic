import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  groupInboxThreads,
  evictThreadCache,
  orderThreadMessages,
  openedThreadView,
  overlayThreadMessages,
  sortInboxThreads,
  type InboxThread,
} from "../src/renderer/src/inbox.ts";
import { reuseInboxList } from "../src/renderer/src/thread-window.ts";
import type { InboxViewItem } from "../src/renderer/src/types.ts";

function message(
  id: string,
  occurredAt: string,
  threadId = "dsh:old",
): InboxViewItem {
  return {
    decision: {
      event_id: id,
      org_id: "org",
      disposition: "current_work",
      layer: "L1_event",
      reason_codes: [],
      score: 1,
      decided_at: occurredAt,
    },
    event: {
      id,
      org_id: "org",
      source: "dsh",
      external_id: `${threadId}:${id}`,
      operation: "create",
      occurred_at: occurredAt,
      ingested_at: occurredAt,
    },
    body_text: id,
    channel: "dsh",
    channel_label: "DSH",
    kind: "user",
    direction: "outbound",
    can_send: true,
    thread_id: threadId,
  };
}

function thread(input: {
  id: string;
  pinned?: boolean;
  opened_at?: string;
  occurred_at?: string;
}): InboxThread {
  const messages = input.occurred_at
    ? [message(`${input.id}-m`, input.occurred_at, input.id)]
    : [];
  return {
    id: input.id,
    source: "dsh",
    channel: "dsh",
    channel_label: "DSH",
    label: input.id,
    title: null,
    conversation_label: null,
    conversation_kind: null,
    pinned: input.pinned === true,
    can_send: true,
    opened_at: input.opened_at,
    messages,
  };
}

describe("inbox sort", () => {
  it("puts a just-opened empty conversation above older unpinned threads", () => {
    const older = thread({
      id: "dsh:old",
      occurred_at: "2026-08-21T00:00:00.000Z",
    });
    const created = thread({
      id: "dsh:new",
      opened_at: "2026-08-23T12:00:00.000Z",
    });
    const sorted = sortInboxThreads([older, created]);
    assert.equal(sorted[0].id, "dsh:new");
    assert.equal(sorted[1].id, "dsh:old");
  });

  it("keeps a new conversation at the top even if its first event is older", () => {
    const older = thread({
      id: "dsh:old",
      occurred_at: "2026-08-23T11:00:00.000Z",
    });
    const created = thread({
      id: "dsh:new",
      opened_at: "2026-08-23T12:00:00.000Z",
      occurred_at: "2026-08-20T00:00:00.000Z",
    });
    const sorted = sortInboxThreads([older, created]);
    assert.equal(sorted[0].id, "dsh:new");
  });

  it("keeps pinned threads above a new empty conversation", () => {
    const pinned = thread({
      id: "feishu:oc_1",
      pinned: true,
      occurred_at: "2026-08-22T00:00:00.000Z",
    });
    const created = thread({
      id: "dsh:new",
      opened_at: "2026-08-23T12:00:00.000Z",
    });
    const sorted = sortInboxThreads([created, pinned]);
    assert.equal(sorted[0].id, "feishu:oc_1");
    assert.equal(sorted[1].id, "dsh:new");
  });

  it("appends into one thread without rebuilding the others", () => {
    const first = [
      message("a", "2026-08-23T10:00:00.000Z", "dsh:one"),
      message("b", "2026-08-23T10:01:00.000Z", "dsh:two"),
    ];
    const extra = message("c", "2026-08-23T10:02:00.000Z", "dsh:one");
    const previous = groupInboxThreads(first);
    const reused = reuseInboxList(first, [...first, extra]);
    const next = groupInboxThreads(reused.items, previous, reused);
    assert.equal(
      next.find((entry) => entry.id === "dsh:two"),
      previous.find((entry) => entry.id === "dsh:two"),
    );
    assert.notEqual(
      next.find((entry) => entry.id === "dsh:one"),
      previous.find((entry) => entry.id === "dsh:one"),
    );
    assert.equal(next.find((entry) => entry.id === "dsh:one")?.messages[1], extra);
  });

  it("overlays a loaded thread without rebuilding the other rows", () => {
    const first = [
      message("a", "2026-08-23T10:00:00.000Z", "dsh:one"),
      message("b", "2026-08-23T10:01:00.000Z", "dsh:two"),
    ];
    const threads = groupInboxThreads(first);
    const extra = message("c", "2026-08-23T10:02:00.000Z", "dsh:one");
    const next = overlayThreadMessages(threads, { "dsh:one": [first[0], extra] });
    assert.equal(next.find((entry) => entry.id === "dsh:two"), threads.find((entry) => entry.id === "dsh:two"));
    assert.equal(next.find((entry) => entry.id === "dsh:one")?.messages.length, 2);
  });

  it("shows a loaded thread oldest-first even if the payload arrived newest-first", () => {
    const older = message("a", "2026-08-23T10:00:00.000Z", "dsh:one");
    const newer = message("c", "2026-08-23T10:02:00.000Z", "dsh:one");
    const other = message("b", "2026-08-23T10:01:00.000Z", "dsh:two");
    const threads = groupInboxThreads([older, other]);
    const next = overlayThreadMessages(threads, { "dsh:one": [newer, older] });
    const messages = next.find((entry) => entry.id === "dsh:one")?.messages ?? [];
    assert.equal(messages[0], older);
    assert.equal(messages[1], newer);
    assert.deepEqual(
      orderThreadMessages([newer, older]).map((item) => item.event.id),
      ["a", "c"],
    );
  });

  it("does not treat the list head as the opened transcript", () => {
    const head = message("a", "2026-08-23T10:00:00.000Z", "feishu:oc_yiki");
    const extra = message("b", "2026-08-23T10:01:00.000Z", "feishu:oc_yiki");
    const [row] = groupInboxThreads([head]);
    const opening = openedThreadView(row, undefined, true);
    assert.deepEqual(opening.messages, []);
    const failed = openedThreadView(row, undefined, false);
    assert.deepEqual(failed.messages, []);
    const loaded = openedThreadView(row, [head, extra], false);
    assert.equal(loaded.messages.length, 2);
    assert.equal(loaded.messages[1], extra);
  });

  it("evicts older thread caches and keeps the open one", () => {
    const cache = Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => [`dsh:${index}`, [message(String(index), "2026-08-23T10:00:00.000Z", `dsh:${index}`)]]),
    );
    const next = evictThreadCache(cache, ["dsh:9", "dsh:0"], 3);
    assert.equal(Object.keys(next).length, 3);
    assert.ok(next["dsh:9"]);
    assert.ok(next["dsh:0"]);
  });
});
