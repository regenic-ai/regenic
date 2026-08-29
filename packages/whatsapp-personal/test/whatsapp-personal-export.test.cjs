const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  createPurrWhatsAppImport,
  createWhatsAppPersonalImport,
} = require("../dist");
const { surfaceFromParts } = require("@regenic/domain");

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

  it("converts a Purr WA CSV with stable identities and quoted multiline text", () => {
    const data = [
      "datetime,sender,fromMe,type,text",
      '"21/08/2026 14:30","Alex, Sr.",0,chat,"Hello, ""team""\nSecond line"',
      '"21/08/2026 14:31","You",1,chat,"Confirmed"',
    ].join("\n");
    const input = {
      data,
      file_name: "Family_15550001_c_us.csv",
      org_id: "local-owner",
      local_principal_id: "local-user",
      received_at: "2026-08-21T15:00:00.000Z",
    };
    const first = createPurrWhatsAppImport(input);
    const second = createPurrWhatsAppImport(input);
    const records = first.batches[0].records;

    assert.equal(first.errors.length, 0);
    assert.equal(records.length, 2);
    assert.equal(records[0].scope.id, "15550001@c.us");
    assert.equal(records[0].scope.name, "Family");
    assert.equal(records[0].actor.display_name, "Alex, Sr.");
    assert.equal(records[0].content[0].text, 'Hello, "team"\nSecond line');
    assert.deepEqual(surfaceFromParts(records[0].content), {
      channel: "whatsapp-personal",
      kind: "user",
      direction: "inbound",
      conversation_label: "Family",
      conversation_kind: "direct",
      actor_label: "Alex, Sr.",
      type: "message",
    });
    assert.deepEqual(
      records.map((record) => record.external_id),
      second.batches[0].records.map((record) => record.external_id),
    );
  });

  it("maps Purr group events to a system surface", () => {
    const result = createPurrWhatsAppImport({
      data: [
        "datetime,sender,fromMe,type,text",
        '"21/08/2026 14:30","WhatsApp",0,gp2,"[Group event]"',
      ].join("\n"),
      file_name: "Team_120363408877806847_g_us.csv",
      org_id: "local-owner",
      local_principal_id: "local-user",
      received_at: "2026-08-21T15:00:00.000Z",
    });
    const record = result.batches[0].records[0];

    assert.deepEqual(surfaceFromParts(record.content), {
      channel: "whatsapp-personal",
      kind: "system",
      direction: "inbound",
      conversation_label: "Team",
      conversation_kind: "group",
      actor_label: "WhatsApp",
      type: "message",
    });
  });

  it("rejects renamed Purr WA CSV files that no longer carry a chat identity", () => {
    const result = createPurrWhatsAppImport({
      data: "datetime,sender,fromMe,type,text\n2026-08-21 14:30:05,Alex,0,chat,Hello",
      file_name: "renamed.csv",
      org_id: "local-owner",
      local_principal_id: "local-user",
      received_at: "2026-08-21T15:00:00.000Z",
    });

    assert.equal(result.batches.length, 0);
    assert.match(result.errors[0].message, /Purr WA CSV filename/);
  });

  it("rejects a Purr CSV with the wrong header", () => {
    const result = createPurrWhatsAppImport({
      data: "time,sender,fromMe,type,text\n21/08/2026 14:30,Alex,0,chat,Hello",
      file_name: "Family_15550001_c_us.csv",
      org_id: "local-owner",
      local_principal_id: "local-user",
      received_at: "2026-08-21T15:00:00.000Z",
    });

    assert.equal(result.batches.length, 0);
    assert.match(result.errors[0].message, /expected header/);
  });

  it("rejects an empty Purr CSV and isolates an invalid calendar date", () => {
    const empty = createPurrWhatsAppImport({
      data: "datetime,sender,fromMe,type,text\n",
      file_name: "Family_15550001_c_us.csv",
      org_id: "local-owner",
      local_principal_id: "local-user",
      received_at: "2026-08-21T15:00:00.000Z",
    });
    const invalidDate = createPurrWhatsAppImport({
      data: "datetime,sender,fromMe,type,text\n31/02/2026 14:30,Alex,0,chat,Hello",
      file_name: "Family_15550001_c_us.csv",
      org_id: "local-owner",
      local_principal_id: "local-user",
      received_at: "2026-08-21T15:00:00.000Z",
    });

    assert.equal(empty.batches.length, 0);
    assert.match(empty.errors[0].message, /no message rows/);
    assert.equal(invalidDate.batches.length, 0);
    assert.equal(invalidDate.errors.length, 1);
  });
});