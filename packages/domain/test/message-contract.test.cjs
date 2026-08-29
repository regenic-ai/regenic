const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  SURFACE_MEDIA_TYPE,
  attachmentDigestsFromParts,
  attachmentsCoveredBy,
  channelLabel,
  channelRecord,
  labelForUnitKind,
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
    assert.equal(
      conversationId("dsh", "workspace:session:49"),
      conversationId("dsh", "workspace:session:out:rpc-1"),
    );
    assert.equal(
      conversationId("dsh", "workspace:session:out:rpc-1"),
      "dsh:workspace:session",
    );
    assert.equal(conversationId("slack", "C123:1710000000.000100"), "slack:C123");
    assert.equal(isLocalOutboundId("session-abc:out:rpc"), true);
    assert.equal(isLocalOutboundId("session-abc:49"), false);
    assert.equal(normalizeUtterance("  你是哪个模型 \n"), "你是哪个模型");
  });

  it("labels known channels and leaves unknown ids readable", () => {
    assert.equal(channelLabel("dsh"), "DSH");
    assert.equal(channelLabel("slack"), "Slack");
    assert.equal(channelLabel("whatsapp-personal"), "WhatsApp");
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

  it("labels unit_kind from the catalog of the same source", () => {
    const catalogs = [
      {
        source: "crm",
        kinds: [{ id: "crm.order_review", label: "Order review" }],
      },
      {
        source: "extra",
        kinds: [{ id: "extra.order_review", label: "Extra review" }],
      },
    ];
    assert.equal(
      labelForUnitKind(catalogs, "crm", "crm.order_review"),
      "Order review",
    );
    assert.equal(
      labelForUnitKind(catalogs, "extra", "extra.order_review"),
      "Extra review",
    );
    assert.equal(
      labelForUnitKind(catalogs, "other", "crm.order_review"),
      "Order review",
    );
    assert.equal(
      labelForUnitKind(catalogs, "crm", "crm.unknown"),
      "crm.unknown",
    );
    assert.equal(labelForUnitKind(catalogs, "crm", "  "), undefined);
  });

  it("keeps unit_kind on the stored surface without using conversation_kind", () => {
    const record = channelRecord({
      channel: "crm",
      kind: "system",
      direction: "inbound",
      external_id: "order-1:task-1",
      occurred_at: "2026-08-29T00:00:00.000Z",
      actor_id: "crm",
      scope_id: "order-1",
      scope_name: "Order 8821",
      conversation_kind: "direct",
      unit_kind: "crm.order_review",
      type: "task",
      text: "Review this order",
    });
    assert.deepEqual(surfaceFromParts(record.content), {
      channel: "crm",
      kind: "system",
      direction: "inbound",
      conversation_label: "Order 8821",
      conversation_kind: "direct",
      unit_kind: "crm.order_review",
      type: "task",
    });
  });

  it("keeps a DSH turn boundary on the stored surface", () => {
    const record = channelRecord({
      channel: "dsh",
      kind: "system",
      direction: "inbound",
      external_id: "sess-1:9",
      occurred_at: "2026-08-21T00:00:00.000Z",
      actor_id: "assistant",
      scope_id: "sess-1",
      type: "thread_status",
      turn: { state: "ended", ok: true, reason: "completed" },
      text: "",
    });
    assert.deepEqual(surfaceFromParts(record.content).turn, {
      state: "ended",
      ok: true,
      reason: "completed",
    });
  });

  it("keeps connector activity on the stored surface", () => {
    const record = channelRecord({
      channel: "dsh",
      kind: "system",
      direction: "inbound",
      external_id: "sess-1:working",
      occurred_at: "2026-08-21T00:00:00.000Z",
      actor_id: "assistant",
      activity: "working",
      scope_id: "sess-1",
      type: "thread_status",
      text: "Still working.",
    });
    assert.equal(record.type, "thread_status");
    assert.deepEqual(surfaceFromParts(record.content), {
      channel: "dsh",
      kind: "system",
      direction: "inbound",
      activity: "working",
      type: "thread_status",
    });
    assert.deepEqual(
      resolveMessageSurface({
        source: "dsh",
        external_id: "sess-1:working",
        stored: surfaceFromParts(record.content),
      }),
      {
        channel: "dsh",
        kind: "system",
        direction: "inbound",
        activity: "working",
        type: "thread_status",
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

  it("fingerprints attachment bytes so a split image echo can match the local send", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const local = attachmentDigestsFromParts(
      toReplyParts({
        text: "see",
        attachments: [{ filename: "rules.png", media_type: "image/png", bytes: png }],
      }),
    );
    const echo = attachmentDigestsFromParts([
      {
        role: "attachment",
        media_type: "image/png",
        source_filename: "image.png",
        bytes: png,
      },
    ]);
    assert.equal(local.length, 1);
    assert.deepEqual(echo, local);
    assert.equal(attachmentsCoveredBy(echo, local), true);
    assert.equal(
      attachmentsCoveredBy(echo, attachmentDigestsFromParts([
        {
          role: "attachment",
          media_type: "image/png",
          bytes: Buffer.from([0xff, 0xd8, 0xff]),
        },
      ])),
      false,
    );
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
