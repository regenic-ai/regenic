const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createWhatsAppPersonalImport } = require("../dist");

function message(overrides = {}) {
  return {
    schema_version: "1.0",
    kind: "whatsapp_personal_message",
    message_id: "message-1",
    chat_id: "chat-1",
    chat_name: "Family",
    sender_id: "15550001",
    sender_name: "Alex",
    direction: "incoming",
    sent_at: "2026-08-21T00:00:00.000Z",
    text: "Please confirm the plan.",
    ...overrides,
  };
}

describe("WhatsApp Personal Export v1", () => {
  it("maps incoming messages, replies, outgoing actor, edits, and tombstones", () => {
    const result = createWhatsAppPersonalImport({
      data: [
        message(),
        message({ message_id: "message-2", reply_to_message_id: "message-1" }),
        message({ message_id: "message-3", direction: "outgoing", sender_id: "15550000" }),
        message({ message_id: "message-4", operation: "revise", revision_id: "v2" }),
        message({ message_id: "message-5", operation: "tombstone", text: undefined }),
      ].map(JSON.stringify).join("\n"),
      org_id: "local-owner",
      local_principal_id: "local-user",
      received_at: "2026-08-21T00:00:01.000Z",
    });
    const records = result.batches[0].records;

    assert.equal(records[0].source, "whatsapp-personal");
    assert.equal(records[1].parent_external_id, "chat-1:message-1");
    assert.equal(records[2].actor.id, "local-user");
    assert.equal(records[3].revision_id, "v2");
    assert.equal(records[4].operation, "tombstone");
    assert.equal(records[4].content, undefined);
  });

  it("isolates invalid export lines without discarding valid messages", () => {
    const result = createWhatsAppPersonalImport({
      data: `${JSON.stringify(message())}\n${JSON.stringify(message({ message_id: "bad-time", sent_at: "not-a-time" }))}`,
      org_id: "local-owner",
      local_principal_id: "local-user",
      received_at: "2026-08-21T00:00:01.000Z",
    });

    assert.equal(result.batches[0].records.length, 1);
    assert.deepEqual(result.errors, [{
      line: 2,
      code: "invalid_message",
      message: "Export line does not match WhatsApp Personal Export v1",
    }]);
  });
});