const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  SURFACE_MEDIA_TYPE,
  channelLabel,
  channelRecord,
  conversationId,
  isLocalOutboundId,
  normalizeUtterance,
  inferLegacySurface,
  resolveMessageSurface,
  surfaceFromParts,
  toReplyParts,
} = require("../dist");

describe("message contract", () => {
  it("groups DSH seq and outbound replies on the same session", () => {
    assert.equal(
      conversationId("dsh", "session-abc:49"),
      conversationId("dsh", "session-abc:out:rpc-1"),
    );
    assert.equal(conversationId("dsh", "session-abc:49"), "dsh:session-abc");
    assert.equal(conversationId("slack", "C123:1710000000.000100"), "slack:C123");
    assert.equal(isLocalOutboundId("session-abc:out:rpc"), true);
    assert.equal(isLocalOutboundId("session-abc:49"), false);
    assert.equal(normalizeUtterance("  你是哪个模型 \n"), "你是哪个模型");
  });

  it("labels known channels and leaves unknown ids readable", () => {
    assert.equal(channelLabel("dsh"), "DSH");
    assert.equal(channelLabel("slack"), "Slack");
    assert.equal(channelLabel("mail"), "MAIL");
  });

  it("keeps conversation and actor labels on the stored surface", () => {
    const record = channelRecord({
      channel: "feishu",
      kind: "user",
      direction: "inbound",
      external_id: "oc_1:om_1",
      occurred_at: "2026-08-21T00:00:00.000Z",
      actor_id: "ou_1",
      actor_label: "Ada",
      scope_id: "oc_1",
      scope_name: "Bioby.ai",
      conversation_kind: "group",
      text: "hello",
    });
    assert.equal(record.actor.display_name, "Ada");
    assert.equal(record.scope.name, "Bioby.ai");
    assert.deepEqual(surfaceFromParts(record.content), {
      channel: "feishu",
      kind: "user",
      direction: "inbound",
      conversation_label: "Bioby.ai",
      conversation_kind: "group",
      actor_label: "Ada",
    });
    assert.deepEqual(
      resolveMessageSurface({
        source: "feishu",
        external_id: "oc_1:om_1",
        stored: surfaceFromParts(record.content),
      }),
      {
        channel: "feishu",
        kind: "user",
        direction: "inbound",
        conversation_label: "Bioby.ai",
        conversation_kind: "group",
        actor_label: "Ada",
      },
    );
  });

  it("lets a connector emit one ingest record that already carries surface", () => {
    const record = channelRecord({
      channel: "dsh",
      kind: "user",
      direction: "outbound",
      external_id: "sess-1:3",
      occurred_at: "2026-08-21T00:00:00.000Z",
      actor_id: "user",
      scope_id: "sess-1",
      text: "Please review this",
    });

    assert.equal(record.source, "dsh");
    assert.deepEqual(record.direction_tags, ["outbound"]);
    const surfacePart = record.content.find(
      (part) => part.role === "metadata" && part.media_type === SURFACE_MEDIA_TYPE,
    );
    assert.equal(JSON.parse(surfacePart.text).kind, "user");
    assert.deepEqual(
      surfaceFromParts(record.content),
      { channel: "dsh", kind: "user", direction: "outbound" },
    );
  });

  it("builds the send envelope as body plus attachment parts", () => {
    const parts = toReplyParts({
      text: "See this",
      attachments: [
        { filename: "shot.png", media_type: "image/png", bytes: Buffer.from([1, 2, 3]) },
      ],
    });
    assert.equal(parts[0].role, "body");
    assert.equal(parts[0].media_type, "text/markdown");
    assert.equal(parts[1].role, "attachment");
    assert.equal(parts[1].source_filename, "shot.png");
  });

  it("prefers stored surface and only infers for legacy events", () => {
    assert.deepEqual(
      resolveMessageSurface({
        source: "dsh",
        external_id: "sess-1:1",
        body_text: "Current runtime context",
        stored: { channel: "dsh", kind: "user", direction: "outbound" },
      }),
      { channel: "dsh", kind: "user", direction: "outbound" },
    );
    assert.equal(
      inferLegacySurface({
        source: "dsh",
        external_id: "sess-1:out:rpc",
        body_text: "ok",
      }).kind,
      "user",
    );
    assert.equal(
      inferLegacySurface({
        source: "dsh",
        external_id: "sess-1:2",
        body_text: "Current runtime context is workspace-write",
      }).kind,
      "assistant",
    );
  });
});
