import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InboxThread } from "../src/renderer/src/inbox.ts";
import {
  readingMessages,
  threadActivityCopy,
  threadActivityOf,
  threadTitle,
} from "../src/renderer/src/message-view.ts";
import type { InboxViewItem, ThreadActivity } from "../src/renderer/src/types.ts";

function item(input: {
  id: string;
  external_id: string;
  text: string;
  kind?: InboxViewItem["kind"];
  direction?: InboxViewItem["direction"];
  activity?: ThreadActivity;
  occurred_at?: string;
}): InboxViewItem {
  return {
    decision: {
      event_id: input.id,
      org_id: "org",
      disposition: "current_work",
      layer: "L1_event",
      reason_codes: [],
      score: 1,
      decided_at: "2026-08-23T12:00:00.000Z",
    },
    event: {
      id: input.id,
      org_id: "org",
      source: "dsh",
      external_id: input.external_id,
      operation: "create",
      occurred_at: input.occurred_at ?? "2026-08-23T12:00:00.000Z",
      ingested_at: input.occurred_at ?? "2026-08-23T12:00:00.000Z",
    },
    body_text: input.text,
    channel: "dsh",
    channel_label: "DSH",
    kind: input.kind ?? "user",
    direction: input.direction ?? "outbound",
    can_send: true,
    thread_id: "dsh:session-1",
    activity: input.activity,
  };
}

function thread(messages: InboxViewItem[]): InboxThread {
  return {
    id: "dsh:session-1",
    source: "dsh",
    channel: "dsh",
    channel_label: "DSH",
    label: "session",
    title: null,
    conversation_label: null,
    conversation_kind: null,
    pinned: false,
    can_send: true,
    messages,
  };
}

describe("reading messages", () => {
  it("hides a pulled user echo of the same outbound text", () => {
    const outbound = item({
      id: "out-1",
      external_id: "session-1:out:rpc",
      text: "背景: Ahacreator的介绍",
    });
    const echo = item({
      id: "hist-2",
      external_id: "session-1:2",
      text: "背景: Ahacreator的介绍",
    });
    const reading = readingMessages(thread([outbound, echo]));
    assert.equal(reading.length, 1);
    assert.equal(reading[0].event.id, "out-1");
  });

  it("keeps two different user messages from the same speaker", () => {
    const first = item({
      id: "out-1",
      external_id: "session-1:out:a",
      text: "ping",
    });
    const second = item({
      id: "out-2",
      external_id: "session-1:out:b",
      text: "pong",
    });
    const reading = readingMessages(thread([first, second]));
    assert.equal(reading.length, 2);
  });

  it("hides working markers from the reading list", () => {
    const outbound = item({
      id: "out-1",
      external_id: "session-1:out:rpc",
      text: "Continue",
    });
    const working = item({
      id: "work-1",
      external_id: "session-1:9",
      text: "Still working.",
      kind: "system",
      direction: "inbound",
      activity: "working",
    });
    const reading = readingMessages(thread([outbound, working]));
    assert.deepEqual(reading.map((entry) => entry.event.id), ["out-1"]);
  });
});

describe("thread activity", () => {
  it("reads connector activity without using the channel name", () => {
    const waiting = thread([
      item({
        id: "ask-1",
        external_id: "session-1:12",
        text: "Which channel?",
        kind: "assistant",
        direction: "inbound",
        activity: "awaiting_user",
      }),
    ]);
    assert.equal(threadActivityOf(waiting), "awaiting_user");
    assert.match(threadActivityCopy(threadActivityOf(waiting)) ?? "", /original channel/);
    const working = thread([
      item({
        id: "work-1",
        external_id: "session-1:9",
        text: "Still working.",
        kind: "system",
        direction: "inbound",
        activity: "working",
      }),
    ]);
    assert.equal(threadActivityOf(working), "working");
    assert.match(threadActivityCopy(threadActivityOf(working)) ?? "", /still working/i);
  });

  it("treats a recent outbound as waiting for the original channel", () => {
    const now = Date.parse("2026-08-23T12:05:00.000Z");
    const sent = thread([
      item({
        id: "out-1",
        external_id: "session-1:out:rpc",
        text: "Continue",
        occurred_at: "2026-08-23T12:00:00.000Z",
      }),
    ]);
    assert.equal(threadActivityOf(sent, now), "sent");
    assert.match(threadActivityCopy(threadActivityOf(sent, now)) ?? "", /Waiting for a reply/);
  });

  it("does not keep a stale outbound in the waiting state", () => {
    const now = Date.parse("2026-08-23T13:00:00.000Z");
    const stale = thread([
      item({
        id: "out-1",
        external_id: "session-1:out:rpc",
        text: "thanks",
        occurred_at: "2026-08-23T12:00:00.000Z",
      }),
    ]);
    assert.equal(threadActivityOf(stale, now), undefined);
  });

  it("does not title the thread from a working marker", () => {
    const titled = thread([
      item({
        id: "out-1",
        external_id: "session-1:out:rpc",
        text: "Optimize the outline",
      }),
      item({
        id: "work-1",
        external_id: "session-1:9",
        text: "Still working.",
        kind: "system",
        direction: "inbound",
        activity: "working",
      }),
    ]);
    assert.equal(threadTitle(titled), "Optimize the outline");
  });
});
