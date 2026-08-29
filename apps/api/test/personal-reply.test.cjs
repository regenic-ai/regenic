const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  conversationStampForReply,
  usableConversationName,
} = require("../dist/personal-reply.service");

describe("conversationStampForReply", () => {
  it("copies a human conversation name onto the outbound record", () => {
    assert.deepEqual(
      conversationStampForReply({
        target: "oc_e317d1b82c1bc75e271b0e6a614f3900",
        streamLabel: "oc_e317d1b82c1bc75e271b0e6a614f3900",
        headLabel: "交付运营沟通群",
        headKind: "group",
      }),
      {
        scope_name: "交付运营沟通群",
        conversation_kind: "group",
      },
    );
  });

  it("copies unit_kind from the quoted record before the list head", () => {
    assert.deepEqual(
      conversationStampForReply({
        target: "order-1",
        quotedUnitKind: "crm.order_review",
        headUnitKind: "crm.lead_followup",
      }),
      { unit_kind: "crm.order_review" },
    );
    assert.deepEqual(
      conversationStampForReply({
        target: "order-1",
        headUnitKind: "crm.lead_followup",
      }),
      { unit_kind: "crm.lead_followup" },
    );
  });

  it("ignores a raw chat id so the list does not title itself as oc_…", () => {
    assert.equal(
      usableConversationName("oc_e317d1b82c1bc75e271b0e6a614f3900", "oc_e317d1b82c1bc75e271b0e6a614f3900"),
      undefined,
    );
    assert.deepEqual(
      conversationStampForReply({
        target: "oc_1",
        quotedLabel: "oc_1",
        streamLabel: "oc_1",
        headLabel: "oc_1",
      }),
      {},
    );
  });
});
