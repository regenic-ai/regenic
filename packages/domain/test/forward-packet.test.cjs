const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  FORWARD_MAX_TEXT,
  channelRecord,
  appendMissingAttachedLines,
  compileForwardPacket,
  formatForwardAttribution,
  forwardIdempotencyKey,
  latestForwardedTo,
  readForwardedFrom,
  surfaceFromParts,
} = require("../dist");

describe("compileForwardPacket", () => {
  it("compiles utterances with attribution and keeps attachment bytes", () => {
    const packet = compileForwardPacket({
      source_thread_id: "feishu:oc_1",
      source: "feishu",
      mode: "messages",
      utterances: [
        {
          event_id: "ev-1",
          occurred_at: "2026-08-29T02:21:00.000Z",
          channel_label: "Feishu",
          actor_label: "Ada",
          body_text: "Please review **this**.",
          attachments: [
            {
              filename: "shot.png",
              media_type: "image/png",
              bytes: new Uint8Array([1, 2, 3]),
            },
          ],
        },
      ],
    });
    assert.equal(
      packet.text,
      "Feishu · Ada · 2026-08-29 02:21\nPlease review **this**.\n[Attached: shot.png]",
    );
    assert.equal(packet.attachments[0].filename, "shot.png");
    assert.deepEqual(packet.attachments[0].bytes, new Uint8Array([1, 2, 3]));
    assert.deepEqual(packet.forwarded_from, {
      thread_id: "feishu:oc_1",
      event_ids: ["ev-1"],
      source: "feishu",
    });
    assert.equal(packet.truncated, false);
  });

  it("puts a transcript title first and can omit attribution", () => {
    const packet = compileForwardPacket({
      source_thread_id: "slack:C123",
      source: "slack",
      mode: "transcript",
      title: "Release desk",
      attribution: false,
      utterances: [
        {
          event_id: "ev-1",
          occurred_at: "2026-08-29T02:21:00.000Z",
          channel_label: "Slack",
          actor_label: "Ada",
          body_text: "Need a decision.",
        },
        {
          event_id: "ev-2",
          occurred_at: "2026-08-29T02:22:00.000Z",
          channel_label: "Slack",
          body_text: "Ship it.",
        },
      ],
    });
    assert.equal(packet.text, "Release desk\n\nNeed a decision.\n\nShip it.");
  });

  it("keeps a filename even when bytes are missing", () => {
    const packet = compileForwardPacket({
      source_thread_id: "feishu:oc_1",
      source: "feishu",
      mode: "messages",
      attribution: false,
      utterances: [
        {
          event_id: "ev-1",
          occurred_at: "2026-08-29T02:21:00.000Z",
          channel_label: "Feishu",
          body_text: "See this.",
          attachments: [{ filename: "notes.pdf", media_type: "application/pdf" }],
        },
      ],
    });
    assert.equal(packet.text, "See this.\n[Attached: notes.pdf]");
    assert.deepEqual(packet.attachments, []);
    assert.equal(
      appendMissingAttachedLines("See this.\n[Attached: notes.pdf]", ["notes.pdf"]),
      "See this.\n[Attached: notes.pdf]",
    );
    assert.equal(
      appendMissingAttachedLines("See this.", ["notes.pdf", "shot.png"]),
      "See this.\n[Attached: notes.pdf]\n[Attached: shot.png]",
    );
  });

  it("truncates long text and says so", () => {
    const packet = compileForwardPacket({
      source_thread_id: "dsh:sess-a",
      source: "dsh",
      mode: "messages",
      attribution: false,
      utterances: [
        {
          event_id: "ev-1",
          occurred_at: "2026-08-29T02:21:00.000Z",
          channel_label: "DSH",
          body_text: "x".repeat(FORWARD_MAX_TEXT + 80),
        },
      ],
    });
    assert.equal(packet.truncated, true);
    assert.ok(packet.text.startsWith("Truncated."));
    assert.ok(packet.text.length <= FORWARD_MAX_TEXT);
  });
});

describe("forwarded_from surface", () => {
  it("round-trips through channelRecord", () => {
    const record = channelRecord({
      channel: "dsh",
      kind: "user",
      direction: "outbound",
      external_id: "sess-b:out:rpc-1",
      occurred_at: "2026-08-29T02:21:00.000Z",
      actor_id: "local-owner",
      scope_id: "sess-b",
      text: "forwarded",
      forwarded_from: {
        thread_id: "feishu:oc_1",
        event_ids: ["ev-1"],
        source: "feishu",
      },
    });
    assert.deepEqual(surfaceFromParts(record.content).forwarded_from, {
      thread_id: "feishu:oc_1",
      event_ids: ["ev-1"],
      source: "feishu",
    });
  });

  it("drops an incomplete provenance object", () => {
    assert.equal(readForwardedFrom({ thread_id: "x" }), undefined);
    assert.equal(formatForwardAttribution({ channel_label: "Feishu" }), "Feishu");
  });
});

describe("forwarded_to surface", () => {
  it("round-trips through channelRecord", () => {
    const record = channelRecord({
      channel: "dsh",
      kind: "system",
      direction: "outbound",
      type: "thread_status",
      external_id: "sess-a:out:fwd-1",
      occurred_at: "2026-08-29T02:22:00.000Z",
      actor_id: "local-owner",
      scope_id: "sess-a",
      forwarded_to: {
        thread_id: "dsh:sess-b",
        event_ids: ["ev-1"],
        source: "dsh",
      },
    });
    assert.deepEqual(surfaceFromParts(record.content).forwarded_to, {
      thread_id: "dsh:sess-b",
      event_ids: ["ev-1"],
      source: "dsh",
    });
    assert.equal(surfaceFromParts(record.content).type, "thread_status");
  });

  it("keeps the latest destination for each source event", () => {
    const latest = latestForwardedTo([
      {
        id: "st-1",
        occurred_at: "2026-08-29T02:21:00.000Z",
        forwarded_to: {
          thread_id: "dsh:sess-b",
          event_ids: ["ev-1"],
          source: "dsh",
        },
      },
      {
        id: "st-2",
        occurred_at: "2026-08-29T02:22:00.000Z",
        forwarded_to: {
          thread_id: "dsh:created-1",
          event_ids: ["ev-1", "ev-2"],
          source: "dsh",
        },
      },
    ]);
    assert.deepEqual(latest.get("ev-1"), {
      thread_id: "dsh:created-1",
      event_ids: ["ev-1", "ev-2"],
      source: "dsh",
    });
    assert.equal(latest.get("ev-2")?.thread_id, "dsh:created-1");
  });
});

describe("forwardIdempotencyKey", () => {
  it("is stable for the same source, events, and target", () => {
    const input = {
      org_id: "local-owner",
      source_thread_id: "feishu:oc_1",
      event_ids: ["ev-1", "ev-2"],
      target: "dsh:sess-b",
      mode: "messages",
    };
    assert.equal(forwardIdempotencyKey(input), forwardIdempotencyKey(input));
    assert.notEqual(
      forwardIdempotencyKey(input),
      forwardIdempotencyKey({ ...input, target: "dsh:sess-c" }),
    );
  });
});
