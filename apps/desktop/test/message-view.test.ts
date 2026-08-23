import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { InboxThread } from "../src/renderer/src/inbox.ts";
import { readingMessages } from "../src/renderer/src/message-view.ts";
import type { InboxViewItem } from "../src/renderer/src/types.ts";

function item(input: {
  id: string;
  external_id: string;
  text: string;
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
      occurred_at: "2026-08-23T12:00:00.000Z",
      ingested_at: "2026-08-23T12:00:00.000Z",
    },
    body_text: input.text,
    channel: "dsh",
    channel_label: "DSH",
    kind: "user",
    direction: "outbound",
    can_send: true,
    thread_id: "dsh:session-1",
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
});
